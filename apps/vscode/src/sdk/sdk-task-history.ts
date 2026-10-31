import { existsSync } from "node:fs"
import path from "node:path"
import type { ClineCoreListHistoryOptions, SessionHistoryRecord } from "@cline/core"
import type { MessageWithMetadata as SdkMessage } from "@cline/llms"
import {
	bindTaskToSession,
	deleteWorkspaceSession,
	formatDisplayUserInput,
	getActiveTaskBinding,
	loadWorkspaceTaskMessages,
	parseUserInputMode,
	recordTaskTurnEvent,
	saveWorkspaceTaskMessages,
} from "@cline/shared"
import { type ProjectStorageRoots, validateProjectStorageRoots } from "@cline/shared/orvanta"
import type { ClineMessage } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import getFolderSize from "get-folder-size"
import { loadCompany } from "@/orvanta/workspace-store"
import type { McpHub } from "@/services/mcp/McpHub"
import type { TelemetryService } from "@/services/telemetry/TelemetryService"
import { Logger } from "@/shared/services/Logger"
import { deleteLegacyTask, readApiConversationHistory, readTaskHistory, readUiMessages, taskDirPath } from "./legacy-state-reader"
import {
	appendLegacyResumeWarning,
	legacyApiHistoryToSdkMessages,
	mergeLegacyUiMessagesWithResumedSdkMessages,
} from "./legacy-task-handling"
import type { MessageIdMinter } from "./message-id-minter"
import { sdkMessagesToClineMessages } from "./message-translator"
import type { SdkSessionLifecycle } from "./sdk-session-lifecycle"
import type { SdkSessionHost } from "./session-host"

export interface TaskUsage {
	tokensIn: number
	tokensOut: number
	totalCost?: number
	cacheReads?: number
	cacheWrites?: number
}

export interface SdkTaskHistoryOptions {
	mcpHub: McpHub
	sessions: SdkSessionLifecycle
	/**
	 * VS Code's legacy global storage root. Pre-SDK VS Code tasks lived here under
	 * state/taskHistory.json and tasks/<id>/ instead of ~/.cline/data.
	 */
	legacyExtensionStorageDir?: string
	/**
	 * The process-wide id/seq/epoch authority. When provided, history rendering mints ids from
	 * it so regenerated history ids never overlap live-session ids. Optional for tests.
	 */
	getMinter?: () => MessageIdMinter
	telemetry?: TelemetryService
	/**
	 * Cline Cloud sessions live in the cloud control plane, not the local SDK
	 * store. When provided, they are merged into history listings and lookups
	 * (identified by their `ses-…` ids) so History is the one place for every task.
	 */
	cloud?: CloudHistorySource
	/**
	 * Cutover flag for v0.1.1: isolates legacy pre-v0.1.1 tasks completely.
	 * When true (default), legacy tasks are excluded from listing, cannot be opened/resumed,
	 * and no legacy files are modified or migrated.
	 */
	enableLegacyCutover?: boolean
	getWorkspaceRoot?: () => Promise<string>
	getActiveSessionHost?: () => SdkSessionHost | undefined
}

export interface CloudHistorySource {
	isCloudSessionId: (id: string) => boolean
	list: () => Promise<SessionHistoryRecord[]>
	find: (id: string) => Promise<SessionHistoryRecord | undefined>
	delete: (id: string) => Promise<void>
}

type SdkTaskHistoryListOptions = ClineCoreListHistoryOptions & {
	offset?: number
}

function metadataNumber(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): number | undefined {
	const value = metadata?.[key]
	return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function metadataBoolean(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): boolean | undefined {
	const value = metadata?.[key]
	return typeof value === "boolean" ? value : undefined
}

function metadataString(metadata: SessionHistoryRecord["metadata"] | undefined, key: string): string | undefined {
	const value = metadata?.[key]
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function dateStringToTimestamp(value: string | null | undefined): number {
	if (!value) {
		return 0
	}
	const timestamp = Date.parse(value)
	return Number.isFinite(timestamp) ? timestamp : 0
}

/**
 * Sort comparator for session history records by recency: newest first.
 *
 * Falls back through `updatedAt` → `endedAt` → `startedAt` so records that
 * haven't been touched since creation still sort deterministically. Used both
 * when merging the initial list and when re-sorting after a single-record
 * patch, so the two orderings can never diverge.
 */
function compareSessionHistoryRecordsByRecencyDesc(a: SessionHistoryRecord, b: SessionHistoryRecord): number {
	return (
		dateStringToTimestamp(b.updatedAt ?? b.endedAt ?? b.startedAt) -
		dateStringToTimestamp(a.updatedAt ?? a.endedAt ?? a.startedAt)
	)
}

function projectRootsMatch(sessionWorkspace: string | undefined, roots: ProjectStorageRoots | undefined): boolean {
	if (!sessionWorkspace || !roots) return false
	try {
		return validateProjectStorageRoots(roots, sessionWorkspace).workspaceRoot === roots.workspaceRoot
	} catch {
		return false
	}
}

export function historyItemToSessionMetadata(item: HistoryItem, fallbackModelId?: string): Record<string, unknown> {
	return {
		title: item.task,
		isFavorited: item.isFavorited ?? false,
		size: item.size ?? 0,
		totalCost: item.totalCost ?? 0,
		tokensIn: item.tokensIn ?? 0,
		tokensOut: item.tokensOut ?? 0,
		cacheWrites: item.cacheWrites ?? 0,
		cacheReads: item.cacheReads ?? 0,
		modelId: item.modelId ?? fallbackModelId ?? "",
		legacyTask: item.isLegacy ?? false,
		sessionId: item.sessionId,
		agentNumericId: item.agentNumericId,
	}
}

function historyItemToSessionHistoryRecord(item: HistoryItem): SessionHistoryRecord {
	const startedAt = new Date(item.ts || Date.now()).toISOString()
	const displayTask = formatDisplayUserInput(item.task)
	return {
		sessionId: item.id,
		source: "vscode",
		pid: 0,
		startedAt,
		endedAt: startedAt,
		exitCode: 0,
		status: "completed",
		interactive: true,
		provider: item.apiProvider ?? "",
		model: item.modelId ?? "",
		cwd: item.cwdOnTaskInitialization ?? "",
		workspaceRoot: item.cwdOnTaskInitialization ?? "",
		enableTools: true,
		enableSpawn: false,
		enableTeams: false,
		isSubagent: false,
		prompt: displayTask,
		metadata: {
			...historyItemToSessionMetadata({ ...item, task: displayTask }),
			legacyTask: true,
		},
		updatedAt: startedAt,
	}
}

/** SdkMessage plus the plan/act mode recovered from its <user_input mode="..."> wrapper. */
type SdkDisplayMessage = SdkMessage & { uiMode?: "plan" | "act" | "yolo" }

function parseUserMessageMode(content: SdkMessage["content"]): "plan" | "act" | "yolo" | undefined {
	if (typeof content === "string") {
		return parseUserInputMode(content)
	}
	for (const block of content) {
		if (block.type === "text" && typeof block.text === "string") {
			const mode = parseUserInputMode(block.text)
			if (mode) {
				return mode
			}
		}
	}
	return undefined
}

/** Renders a persisted SDK transcript as chat rows, the same way History does for local tasks. */
export function sdkMessagesToDisplayClineMessages(
	messages: SdkMessage[],
	minter: MessageIdMinter | undefined,
	options: { finalTurnCompleted: boolean; cwd?: string },
): ClineMessage[] {
	return sdkMessagesToClineMessages(sanitizeSdkUserMessagesForDisplay(messages), minter, options)
}

function sanitizeSdkUserMessagesForDisplay(messages: SdkMessage[]): SdkDisplayMessage[] {
	return messages.map((message): SdkDisplayMessage => {
		if (message.role !== "user") {
			return message
		}
		// Recover the mode BEFORE display sanitization strips the <user_input mode="..."> wrapper;
		// history rendering uses it to style each turn's inferred completion row.
		const uiMode = parseUserMessageMode(message.content)
		if (typeof message.content === "string") {
			return { ...message, content: formatDisplayUserInput(message.content), uiMode }
		}
		if (Array.isArray(message.content)) {
			return {
				...message,
				content: message.content.map((block) =>
					block.type === "text" && typeof block.text === "string"
						? { ...block, text: formatDisplayUserInput(block.text) }
						: block,
				),
				uiMode,
			}
		}
		return message
	})
}

export function sessionHistoryRecordToHistoryItem(item: SessionHistoryRecord): HistoryItem {
	const metadata = item.metadata
	return {
		id: item.sessionId,
		ts: dateStringToTimestamp(item.updatedAt ?? item.endedAt ?? item.startedAt),
		task: formatDisplayUserInput(metadataString(metadata, "title") ?? item.prompt ?? ""),
		tokensIn: metadataNumber(metadata, "tokensIn") ?? 0,
		tokensOut: metadataNumber(metadata, "tokensOut") ?? 0,
		cacheWrites: metadataNumber(metadata, "cacheWrites") ?? 0,
		cacheReads: metadataNumber(metadata, "cacheReads") ?? 0,
		totalCost: metadataNumber(metadata, "totalCost") ?? 0,
		size: metadataNumber(metadata, "size"),
		isFavorited: metadataBoolean(metadata, "isFavorited") ?? metadataBoolean(metadata, "is_favorited") ?? false,
		modelId: item.model || metadataString(metadata, "modelId") || "",
		apiProvider: item.provider || undefined,
		cwdOnTaskInitialization: item.cwd ?? item.workspaceRoot,
		isLegacy:
			metadataBoolean(metadata, "legacyTask") === true || metadataBoolean(metadata, "migratedFromLegacyTask") === true,
		sessionId: metadataString(metadata, "sessionId"),
		agentNumericId: metadataNumber(metadata, "agentNumericId"),
		...(metadataString(metadata, "executionTarget") === "cloud"
			? {
					executionTarget: "cloud" as const,
					cloudStatus: metadataString(metadata, "cloudStatus") as HistoryItem["cloudStatus"],
					cloudRepoUrl: metadataString(metadata, "repoUrl"),
					cloudBranch: metadataString(metadata, "branch"),
					cloudUsageAvailable: metadataBoolean(metadata, "usageAvailable") ?? false,
				}
			: {}),
	}
}

export class SdkTaskHistory {
	private readonly sessionWorkspaceRoots = new Map<string, string>()
	private readonly metadataHistoryCacheByWorkspace = new Map<
		string,
		{
			records: SessionHistoryRecord[]
			hostLimit: number
			workspaceRoot?: string
			createdAt: number
		}
	>()
	private metadataHistoryCache?: {
		records: SessionHistoryRecord[]
		hostLimit: number
		workspaceRoot?: string
		createdAt: number
	}
	private disposed = false
	private readonly pendingDisplayMessageSaves = new Map<
		string,
		{ timer: ReturnType<typeof setTimeout>; workspaceRoot: string; messages: ClineMessage[] }
	>()
	private readonly metadataHistoryCacheTtlMs = 10_000

	constructor(private readonly options: SdkTaskHistoryOptions) {}
	isCutoverActive(): boolean {
		return this.options.enableLegacyCutover === true || process.env.ORVANTA_CUTOVER === "1"
	}

	private getLegacyDataDirs(): (string | undefined)[] {
		const dirs: (string | undefined)[] = [undefined]
		const extensionStorageDir = this.options.legacyExtensionStorageDir?.trim()
		if (extensionStorageDir) {
			dirs.push(extensionStorageDir)
		}
		return dirs
	}

	private readAllLegacyTaskHistory(): {
		item: HistoryItem
		dataDir?: string
	}[] {
		const seenIds = new Set<string>()
		const tasks: { item: HistoryItem; dataDir?: string }[] = []
		for (const dataDir of this.getLegacyDataDirs()) {
			for (const item of readTaskHistory(dataDir)) {
				if (!item.id || seenIds.has(item.id)) {
					continue
				}
				seenIds.add(item.id)
				tasks.push({ item, dataDir })
			}
		}
		return tasks
	}

	private findLegacyTask(taskId: string): { item: HistoryItem; dataDir?: string } | undefined {
		return this.readAllLegacyTaskHistory().find(({ item }) => item.id === taskId)
	}

	private isCloudTask(taskId: string): boolean {
		return this.options.cloud?.isCloudSessionId(taskId) ?? false
	}

	private getActiveHistoryHost(): SdkSessionHost | undefined {
		const sdkHost = this.options.sessions.getActiveSession()?.sdkHost
		// A cloud host only knows its own sandbox; local history always needs the local store.
		if (sdkHost && "listHistory" in sdkHost && !("isCloud" in sdkHost)) {
			return sdkHost
		}
		return undefined
	}

	private async getHistoryHostForSession(sessionId: string, record?: SessionHistoryRecord): Promise<SdkSessionHost> {
		const active = this.options.sessions.getActiveSession()
		const selectedWorkspace = await this.options.getWorkspaceRoot?.()
		const currentProjectRoots = selectedWorkspace
			? await this.options.sessions.resolveStorageRootsForWorkspace(selectedWorkspace)
			: undefined
		const sessionWorkspaceRoot = record?.workspaceRoot || record?.cwd || this.sessionWorkspaceRoots.get(sessionId)
		if (sessionWorkspaceRoot) {
			const projectRoots = await this.options.sessions.resolveStorageRootsForWorkspace(sessionWorkspaceRoot)
			if (currentProjectRoots && !projectRootsMatch(sessionWorkspaceRoot, currentProjectRoots)) {
				throw new Error(`Session ${sessionId} does not belong to the selected project workspace`)
			}
			if (projectRoots) return this.getHistoryHost(projectRoots.workspaceRoot)
			if (selectedWorkspace && currentProjectRoots) {
				throw new Error(`Session ${sessionId} is missing project-scoped storage roots`)
			}
			return this.getHistoryHost(sessionWorkspaceRoot)
		}
		if (currentProjectRoots) {
			if (active?.sessionId === sessionId && this.options.sessions.isProjectScopedHost?.(active.sdkHost)) {
				return active.sdkHost
			}
			return this.getHistoryHost(currentProjectRoots.workspaceRoot)
		}
		if (active?.sessionId === sessionId) return active.sdkHost

		if (typeof this.options.sessions.getUnscopedHost === "function") return this.options.sessions.getUnscopedHost()
		return this.options.getActiveSessionHost?.() ?? this.getHistoryHost()
	}

	private async getCurrentProjectStorageRoots(): Promise<ProjectStorageRoots | undefined> {
		const workspaceRoot = await this.options.getWorkspaceRoot?.()
		return workspaceRoot ? await this.options.sessions.resolveStorageRootsForWorkspace(workspaceRoot) : undefined
	}

	private async getSessionRecord(sessionId: string): Promise<SessionHistoryRecord | undefined> {
		const selectedWorkspace = await this.options.getWorkspaceRoot?.()
		const currentProjectRoots = selectedWorkspace
			? await this.options.sessions.resolveStorageRootsForWorkspace(selectedWorkspace)
			: undefined
		let record: SessionHistoryRecord | undefined
		if (currentProjectRoots) {
			const scopedHost = await this.getHistoryHost(currentProjectRoots.workspaceRoot)
			record = (await scopedHost.get(sessionId)) as SessionHistoryRecord | undefined
			if (record) {
				const root = record.workspaceRoot || record.cwd
				if (!root || !projectRootsMatch(root, currentProjectRoots)) {
					throw new Error(`Session ${sessionId} workspace does not match the selected project storage root`)
				}
				this.sessionWorkspaceRoots.set(sessionId, root)
				return record
			}
			return undefined
		}
		if (selectedWorkspace) {
			// A selected non-project workspace uses the legacy shared backend, but
			// never consult a project-scoped active host from a previously selected
			// workspace.
			return (await (await this.getHistoryHost(selectedWorkspace)).get(sessionId)) as SessionHistoryRecord | undefined
		}

		const knownRoot = this.sessionWorkspaceRoots.get(sessionId)
		if (knownRoot) {
			const roots = await this.options.sessions.resolveStorageRootsForWorkspace(knownRoot)
			const scopedHost = roots
				? await this.getHistoryHost(roots.workspaceRoot)
				: typeof this.options.sessions.getUnscopedHost === "function"
					? await this.options.sessions.getUnscopedHost()
					: await this.getHistoryHost()
			return (await scopedHost.get(sessionId)) as SessionHistoryRecord | undefined
		}

		const activeHistoryHost = this.options.getActiveSessionHost?.() ?? this.getActiveHistoryHost()
		if (activeHistoryHost) {
			record = (await activeHistoryHost.get(sessionId)) as SessionHistoryRecord | undefined
			if (record) {
				const root = record.workspaceRoot || record.cwd
				if (root) this.sessionWorkspaceRoots.set(sessionId, root)
				return record
			}
			if (this.options.sessions.isProjectScopedHost?.(activeHistoryHost)) return undefined
		}

		const unscopedHost =
			typeof this.options.sessions.getUnscopedHost === "function"
				? await this.options.sessions.getUnscopedHost()
				: (this.options.getActiveSessionHost?.() ?? this.getActiveHistoryHost() ?? (await this.getHistoryHost()))
		record = (await unscopedHost.get(sessionId)) as SessionHistoryRecord | undefined
		if (record) {
			const root = record.workspaceRoot || record.cwd
			if (root) this.sessionWorkspaceRoots.set(sessionId, root)
		}
		return record
	}

	private async getHistoryHost(workspaceRoot?: string): Promise<SdkSessionHost> {
		if (this.disposed) {
			throw new Error("SdkTaskHistory has been disposed")
		}
		return this.options.sessions.getHostForWorkspaceRoot(workspaceRoot)
	}

	async dispose(): Promise<void> {
		this.disposed = true
		await Promise.all([...this.pendingDisplayMessageSaves.keys()].map((taskId) => this.flushDisplayMessages(taskId)))
		this.invalidateMetadataHistoryCache()
	}

	private invalidateMetadataHistoryCache(): void {
		this.metadataHistoryCache = undefined
		this.metadataHistoryCacheByWorkspace.clear()
	}

	/** Forces the next listing to re-enumerate (e.g. a cloud session changed status). */
	invalidateCache(): void {
		this.invalidateMetadataHistoryCache()
	}

	/**
	 * Mirror a persistence-layer write into the cache so the next read sees
	 * the updated record without a full re-enumeration.
	 *
	 * The persistence layer bumps `updatedAt` on every write, so the cached
	 * record is updated to match and the cache is re-sorted to preserve the
	 * descending-`updatedAt` ordering that {@link listHistory} establishes.
	 * When the session isn't in the cache (e.g. a brand-new task whose list
	 * membership/ordering may change) the cache is invalidated so the next
	 * read re-enumerates from disk.
	 */
	private updateCachedSessionRecord(
		sessionId: string,
		updates: { prompt: string; metadata: Record<string, unknown>; updatedAt: string },
		cacheKey: string,
	): void {
		const cache = this.metadataHistoryCacheByWorkspace.get(cacheKey)
		const index = cache?.records.findIndex((record) => record.sessionId === sessionId) ?? -1
		if (!cache || index === -1) {
			this.invalidateMetadataHistoryCache()
			return
		}
		const existing = cache.records[index]
		cache.records[index] = {
			...existing,
			prompt: updates.prompt,
			metadata: updates.metadata,
			updatedAt: updates.updatedAt,
		}
		cache.records.sort(compareSessionHistoryRecordsByRecencyDesc)
	}

	private canUseMetadataHistoryCache(options: SdkTaskHistoryListOptions): boolean {
		return options.hydrate === false
	}

	private async getCurrentHistoryCacheKey(): Promise<string> {
		const workspaceRoot = await this.options.getWorkspaceRoot?.()
		if (!workspaceRoot) return "<unscoped>"
		const projectRoots = await this.options.sessions.resolveStorageRootsForWorkspace(workspaceRoot)
		return projectRoots?.workspaceRoot ?? workspaceRoot
	}

	private async withHistoryHost<T>(fn: (host: SdkSessionHost) => Promise<T>, sessionId?: string): Promise<T> {
		const currentProjectRoots = await this.getCurrentProjectStorageRoots()
		if (currentProjectRoots) {
			// The selected project owns this operation; never route it through an
			// active session or shared host from another workspace.
			return fn(await this.getHistoryHost(currentProjectRoots.workspaceRoot))
		}
		const selectedWorkspace = await this.options.getWorkspaceRoot?.()
		if (selectedWorkspace) {
			return fn(await this.getHistoryHost(selectedWorkspace))
		}
		const activeHistory = this.options.sessions.getActiveSession()
		const activeHost = this.options.getActiveSessionHost?.() ?? this.getActiveHistoryHost()
		if (activeHistory && activeHost && (sessionId === undefined || activeHistory.sessionId === sessionId)) {
			return fn(activeHost)
		}
		if (sessionId) {
			const record = await this.getSessionRecord(sessionId)
			return fn(await this.getHistoryHostForSession(sessionId, record))
		}
		const workspaceRoot = await this.options.getWorkspaceRoot?.()
		const projectRoots = workspaceRoot
			? await this.options.sessions.resolveStorageRootsForWorkspace(workspaceRoot)
			: undefined
		if (projectRoots) return fn(await this.getHistoryHost(projectRoots.workspaceRoot))
		if (typeof this.options.sessions.getUnscopedHost === "function") {
			return fn(await this.options.sessions.getUnscopedHost())
		}
		const active = this.getActiveHistoryHost()
		return fn(active ?? (await this.getHistoryHost()))
	}

	async listHistory(options: SdkTaskHistoryListOptions = {}): Promise<SessionHistoryRecord[]> {
		const offset = Math.max(0, Math.floor(options.offset ?? 0))
		const limit = Math.max(0, Math.floor(options.limit ?? 10_000))
		const hostLimit = offset + limit
		const workspaceRoot = await this.options.getWorkspaceRoot?.()
		const projectRoots = workspaceRoot
			? await this.options.sessions.resolveStorageRootsForWorkspace(workspaceRoot)
			: undefined
		const useCache = this.canUseMetadataHistoryCache(options)
		const now = Date.now()
		const cacheKey = projectRoots?.workspaceRoot ?? workspaceRoot ?? "<unscoped>"
		const cached = useCache ? this.metadataHistoryCacheByWorkspace.get(cacheKey) : undefined
		if (cached && cached.hostLimit >= hostLimit && now - cached.createdAt < this.metadataHistoryCacheTtlMs) {
			const result = cached.records.slice(offset, offset + limit)
			return result
		}

		const hostOptions: ClineCoreListHistoryOptions = { ...options }
		delete (hostOptions as { offset?: number }).offset

		const historyHost = projectRoots
			? await this.getHistoryHost(projectRoots.workspaceRoot)
			: this.options.getWorkspaceRoot !== undefined
				? workspaceRoot
					? await this.getHistoryHost(workspaceRoot)
					: await this.getHistoryHost()
				: typeof this.options.sessions.getUnscopedHost === "function"
					? await this.options.sessions.getUnscopedHost()
					: (this.getActiveHistoryHost() ?? (await this.getHistoryHost()))
		const sdkHistory = await historyHost.listHistory({
			...hostOptions,
			limit: hostLimit || 10_000,
			// The SDK manifest fallback scans resolveSessionDataDir(), which is
			// process-global. Never let a project-scoped history query supplement
			// its project DB with manifests from the user's shared Cline store.
			includeManifestFallback: !projectRoots,
		})
		for (const record of sdkHistory) {
			const root = record.workspaceRoot || record.cwd
			if (root) this.sessionWorkspaceRoots.set(record.sessionId, root)
		}
		const visibleSdkHistory = sdkHistory.filter((item) => item.isSubagent !== true)
		const sdkIds = new Set(visibleSdkHistory.map((item) => item.sessionId))
		const legacyHistory =
			projectRoots || this.isCutoverActive()
				? []
				: this.readAllLegacyTaskHistory()
						.filter(({ item }) => item.task && !sdkIds.has(item.id))
						.map(({ item }) => historyItemToSessionHistoryRecord(item))
		// An SDK record with legacy metadata is a legacy task that was resumed,
		// i.e. migrated (historyItemToSessionMetadata stamps legacyTask on resume).
		const migratedSdkTaskCount = visibleSdkHistory.filter(
			(item) =>
				metadataBoolean(item.metadata, "migratedFromLegacyTask") === true ||
				metadataBoolean(item.metadata, "legacyTask") === true,
		).length

		const cloudHistory = this.options.cloud
			? await this.options.cloud.list().catch((error) => {
					Logger.warn("[SdkTaskHistory] Failed to list cloud sessions:", error)
					return [] as SessionHistoryRecord[]
				})
			: []

		const mergedHistory = [...visibleSdkHistory, ...legacyHistory, ...cloudHistory].sort(
			compareSessionHistoryRecordsByRecencyDesc,
		)
		if (useCache) {
			const entry = {
				records: mergedHistory,
				hostLimit,
				workspaceRoot,
				createdAt: Date.now(),
			}
			this.metadataHistoryCacheByWorkspace.set(cacheKey, entry)
		}

		this.options.telemetry?.safeCapture(
			() =>
				this.options.telemetry?.captureLegacyTaskMigrationBacklog({
					pendingLegacyTaskCount: legacyHistory.length,
					migratedSdkTaskCount,
					visibleSdkTaskCount: visibleSdkHistory.length,
					visibleTaskCount: mergedHistory.length,
				}),
			"SdkTaskHistory.listHistory.legacyMigrationBacklog",
		)

		const result = mergedHistory.slice(offset, offset + limit)
		return result
	}

	private async getSdkRecord(taskId: string): Promise<SessionHistoryRecord | undefined> {
		return this.getSessionRecord(taskId)
	}

	queueDisplayMessagesSave(taskId: string, workspaceRoot: string, messages: ClineMessage[]): void {
		if (this.isCloudTask(taskId) || !workspaceRoot || messages.length === 0) {
			return
		}

		const pending = this.pendingDisplayMessageSaves.get(taskId)
		if (pending) {
			clearTimeout(pending.timer)
		}
		const snapshot = messages.map((message) => ({ ...message, partial: false }))
		const timer = setTimeout(() => {
			void this.flushDisplayMessages(taskId)
		}, 250)
		this.pendingDisplayMessageSaves.set(taskId, { timer, workspaceRoot, messages: snapshot })
	}

	private async flushDisplayMessages(taskId: string): Promise<void> {
		const pending = this.pendingDisplayMessageSaves.get(taskId)
		if (!pending) return
		clearTimeout(pending.timer)
		this.pendingDisplayMessageSaves.delete(taskId)
		try {
			await saveWorkspaceTaskMessages(pending.workspaceRoot, taskId, pending.messages)
		} catch (error) {
			Logger.warn(`[SdkTaskHistory] Failed to persist display transcript for ${taskId}:`, error)
		}
	}

	async getClineMessages(taskId: string): Promise<ClineMessage[]> {
		if (this.isCloudTask(taskId)) {
			// Cloud transcripts are read through the sandbox connection (see SdkCloudSessionCoordinator).
			return []
		}
		const sdkRecord = await this.getSdkRecord(taskId)
		const selectedWorkspace = await this.options.getWorkspaceRoot?.()
		const projectRoots = selectedWorkspace
			? await this.options.sessions.resolveStorageRootsForWorkspace(selectedWorkspace)
			: undefined
		if (projectRoots && !sdkRecord) return []
		const legacyTask = projectRoots ? undefined : this.findLegacyTask(taskId)
		const workspaceRoot = sdkRecord?.cwd || sdkRecord?.workspaceRoot || legacyTask?.item.cwdOnTaskInitialization
		// Prefer the Orvanta display transcript when it carries teammate attribution.
		// Multi-agent tool history is stamped into ui_messages.json during the live
		// session; SDK readMessages(taskId) only returns the coordinator session file
		// and drops Agent work (stored in separate *__canonical.messages.json files).
		// Must run for project-scoped workspaces too — that is the normal Orvanta path.
		const displayTranscriptRoot = selectedWorkspace || workspaceRoot
		if (displayTranscriptRoot) {
			try {
				const persistedDisplayMessages = await loadWorkspaceTaskMessages<ClineMessage>(displayTranscriptRoot, taskId)
				// Only trust the display artifact as the richer source when it contains
				// teammate attribution. Older cache files may be Coordinator-only and
				// must not hide the SDK transcript for non-Orvanta sessions.
				if (
					persistedDisplayMessages?.some((message) => {
						const agentId = message.agentId ?? message.agent_id
						return Boolean(agentId && agentId.toLowerCase() !== "coordinator")
					})
				) {
					return persistedDisplayMessages
				}
			} catch {
				// Fall through to SDK canonical history.
			}
		}
		if (!projectRoots && !sdkRecord && legacyTask) {
			if (this.isCutoverActive()) {
				return []
			}
			return readUiMessages(taskId, legacyTask.dataDir)
		}
		if (!projectRoots && !sdkRecord && !legacyTask) {
			const selectedWorkspace = await this.options.getWorkspaceRoot?.()
			const cacheKey = selectedWorkspace ?? "<unscoped>"
			const cachedRecord = this.metadataHistoryCacheByWorkspace
				.get(cacheKey)
				?.records.find((record) => record.sessionId === taskId)
			const cwd = cachedRecord?.cwd
			if (cwd) {
				try {
					const wsMessages = await loadWorkspaceTaskMessages<ClineMessage>(cwd, taskId)
					if (wsMessages && wsMessages.length > 0) {
						return wsMessages
					}
				} catch {
					// Fall through to empty
				}
			}
		}

		const sdkMessages = await this.withHistoryHost((host) => host.readMessages(taskId) as Promise<SdkMessage[]>, taskId)
		const clineMessages = sdkMessagesToClineMessages(
			sanitizeSdkUserMessagesForDisplay(sdkMessages),
			this.options.getMinter?.(),
			{
				// Only retag the transcript's terminal text as an inferred completion when the
				// session record says its last turn ended cleanly — status "completed", written
				// by the SDK runtime host's resolveInteractiveStopStatus when the session is
				// released (task switch, clear, extension dispose). Everything else stays a
				// plain text row: "failed"/"cancelled" runs ended on a dangling response, and
				// non-terminal statuses at rest ("idle"/"running"/"pending") mean the process
				// died without recording an outcome — "idle" in particular is also the state
				// after an aborted turn (markTurnIdle runs for every finish reason), so it
				// cannot be trusted as a clean ending. A missing record is likewise an unknown
				// outcome, so it gets no completion styling either.
				finalTurnCompleted: sdkRecord?.status === "completed",
				// Relativize the absolute tool paths for display, same as the live path.
				cwd: sdkRecord?.cwd || sdkRecord?.workspaceRoot || undefined,
			},
		)
		const finalMessages =
			sdkRecord && legacyTask
				? mergeLegacyUiMessagesWithResumedSdkMessages(readUiMessages(taskId, legacyTask.dataDir), clineMessages)
				: clineMessages

		// Cache to .orvanta/history/tasks/<taskId>/ui_messages.json
		const wsRoot = sdkRecord?.cwd || sdkRecord?.workspaceRoot || legacyTask?.item.cwdOnTaskInitialization
		if (wsRoot && finalMessages.length > 0 && !projectRoots) {
			try {
				await saveWorkspaceTaskMessages(wsRoot, taskId, finalMessages)
			} catch {
				// Non-blocking
			}
		}

		return finalMessages
	}

	/**
	 * Absolute path of the directory holding the task's on-disk artifacts: the SDK
	 * session folder (manifest json + messages json) for SDK tasks, or the legacy
	 * tasks/<id> folder for pre-SDK tasks. Undefined when the task is unknown.
	 */
	async getTaskDirPath(taskId: string): Promise<string | undefined> {
		const sdkRecord = await this.getSdkRecord(taskId)
		if (sdkRecord) {
			const messagesPath = typeof sdkRecord.messagesPath === "string" ? sdkRecord.messagesPath.trim() : ""
			if (messagesPath) {
				return path.dirname(messagesPath)
			}
			// Older records may lack messagesPath; fall back to the canonical
			// project session directory when its storage roots are available.
			const recordRoot = sdkRecord.cwd || sdkRecord.workspaceRoot
			const projectRoots = recordRoot ? await this.options.sessions.resolveStorageRootsForWorkspace(recordRoot) : undefined
			const sessionDir = projectRoots ? path.join(projectRoots.sdkArtifactDir, taskId) : undefined
			if (sessionDir && existsSync(sessionDir)) {
				return sessionDir
			}
		}
		if (await this.getCurrentProjectStorageRoots()) return undefined
		return this.getLegacyTaskDirPath(taskId)
	}

	getLegacyTaskDirPath(taskId: string): string | undefined {
		const legacyTask = this.findLegacyTask(taskId)
		return legacyTask ? taskDirPath(taskId, legacyTask.dataDir) : undefined
	}

	/**
	 * The persisted session status ("completed" | "cancelled" | "failed" | ...).
	 * Persisted messages cannot distinguish a completed conversation from one
	 * interrupted mid-stream (both just end with assistant text), so reopening a
	 * task from History uses this status to decide between the Resume Task and
	 * Start New Task affordances.
	 */
	async getSessionStatus(taskId: string): Promise<SessionHistoryRecord["status"] | undefined> {
		if (this.isCloudTask(taskId)) {
			return (await this.options.cloud?.find(taskId))?.status
		}
		const sdkRecord = await this.getSdkRecord(taskId)
		return sdkRecord?.status
	}

	async isLegacyTask(taskId: string): Promise<boolean> {
		if (this.isCloudTask(taskId)) {
			return false
		}
		const sdkRecord = await this.getSdkRecord(taskId)
		if (sdkRecord) {
			return (
				metadataBoolean(sdkRecord.metadata, "legacyTask") === true ||
				metadataBoolean(sdkRecord.metadata, "migratedFromLegacyTask") === true
			)
		}
		const workspaceRoot = await this.options.getWorkspaceRoot?.()
		if (workspaceRoot && (await this.options.sessions.resolveStorageRootsForWorkspace(workspaceRoot))) {
			return false
		}

		return this.findLegacyTask(taskId) !== undefined
	}

	async getLegacyResumeInitialMessages(taskId: string, fallbackMessages?: unknown[]): Promise<unknown[] | undefined> {
		const sdkRecord = await this.getSdkRecord(taskId)
		const workspaceRoot = await this.options.getWorkspaceRoot?.()
		const projectRoots = workspaceRoot
			? await this.options.sessions.resolveStorageRootsForWorkspace(workspaceRoot)
			: undefined
		const legacyTask = sdkRecord || projectRoots ? undefined : this.findLegacyTask(taskId)
		if (legacyTask) {
			const legacyApiHistory = readApiConversationHistory(taskId, legacyTask.dataDir)
			if (legacyApiHistory.length > 0) {
				return legacyApiHistoryToSdkMessages(legacyApiHistory, legacyTask.item)
			}
		}

		if (!fallbackMessages) {
			return undefined
		}
		return appendLegacyResumeWarning(fallbackMessages as { role: string; content: unknown }[])
	}

	private async updateSession(sessionId: string, item: HistoryItem): Promise<void> {
		const cacheKey = await this.getCurrentHistoryCacheKey()
		const { metadata: writtenMetadata, updated } = await this.withHistoryHost(async (host) => {
			const existing = await host.get(sessionId)
			const metadata: Record<string, unknown> = {
				...(existing?.metadata ?? {}),
				...historyItemToSessionMetadata(item, existing?.model),
			}
			if (item.size === undefined) {
				const existingSize = existing?.metadata?.size
				if (existingSize !== undefined) {
					metadata.size = existingSize
				} else {
					delete metadata.size
				}
			}
			const result = await host.update(sessionId, {
				prompt: item.task,
				metadata,
				title: item.task,
			})
			return { metadata, updated: result.updated }
		}, sessionId)
		if (!updated) {
			// The write didn't land (e.g. the session was deleted, or an optimistic-
			// concurrency retry was exhausted by a racing writer). Patching the cache
			// here would show a fake "updated" record until the TTL expires, so
			// invalidate instead and let the next read re-enumerate from disk.
			this.invalidateMetadataHistoryCache()
			return
		}
		// The persistence adapter stamps `updatedAt` with the wall-clock write time
		// (see `nowIso()` in file-session-service.ts), not `item.ts`. Mirror that here
		// rather than deriving from `item.ts`: callers like toggleTaskFavorite() reuse
		// an old HistoryItem whose `ts` predates this write, which would otherwise let
		// the cached ordering diverge from what's on disk until the cache TTL expires.
		this.updateCachedSessionRecord(
			sessionId,
			{
				prompt: item.task,
				metadata: writtenMetadata,
				updatedAt: new Date().toISOString(),
			},
			cacheKey,
		)
	}

	async updateTaskHistoryItem(item: HistoryItem): Promise<void> {
		if (this.isCloudTask(item.id)) {
			// Cloud records are owned by the control plane; nothing to persist locally.
			return
		}
		await this.updateSession(item.id, item)

		// Mirror to .orvanta/history/ if in an Orvanta workspace
		const cwd = item.cwdOnTaskInitialization
		if (cwd) {
			try {
				const load = await loadCompany(cwd)
				if (load.status === "ready" && !item.isLegacy) {
					const activeBinding = getActiveTaskBinding(item.id)
					if (activeBinding) {
						await recordTaskTurnEvent({
							workspaceRoot: cwd,
							taskId: item.id,
							sessionId: activeBinding.sessionId,
							agentNumericId: activeBinding.agentNumericId,
							usage: {
								tokensIn: item.tokensIn ?? 0,
								tokensOut: item.tokensOut ?? 0,
								totalCost: item.totalCost ?? 0,
							},
							lastMessagePreview: item.task,
						})
					} else {
						// Resolve single participating agent without whole-roster fallback
						const candidate = item.agents?.[0]
						const candidateSlug = candidate?.id || "coordinator"
						const candidateRole =
							candidate?.role === "lead" ? "lead" : candidateSlug === "coordinator" ? "lead" : "teammate"
						const matchingRosterAgent = load.roster.agents.find((a) => a.id === candidateSlug)
						const agentNumericId =
							candidate && "agentNumericId" in candidate && typeof (candidate as any).agentNumericId === "number"
								? (candidate as any).agentNumericId
								: (matchingRosterAgent?.agentNumericId ?? 1)
						const displayName = candidate?.displayName || matchingRosterAgent?.displayName || candidateSlug

						await bindTaskToSession({
							workspaceRoot: cwd,
							companyId: load.company.id,
							sessionId: item.sessionId,
							taskId: item.id,
							agentNumericId,
							agentSlug: candidateSlug,
							displayName,
							role: candidateRole,
							prompt: item.task,
							sdkSessionId: item.id,
							usage: {
								tokensIn: item.tokensIn ?? 0,
								tokensOut: item.tokensOut ?? 0,
								totalCost: item.totalCost ?? 0,
							},
							lastMessagePreview: item.task,
						})
					}
				}
			} catch (error) {
				// Non-blocking for non-Orvanta workspaces; log so CEO-session mapping
				// failures are visible during Orvanta development.
				Logger.warn("[SdkTaskHistory] Orvanta session bind/update failed:", error)
			}
		}
	}

	private async deleteSession(sessionId: string): Promise<void> {
		if (this.isCloudTask(sessionId)) {
			await this.options.cloud?.delete(sessionId)
			this.invalidateMetadataHistoryCache()
			return
		}
		const currentProjectRoots = await this.getCurrentProjectStorageRoots()
		const sdkRecord = await this.getSessionRecord(sessionId)
		if (currentProjectRoots && !sdkRecord) {
			throw new Error(`Session not found in selected project workspace: ${sessionId}`)
		}
		const projectRoots =
			sdkRecord?.workspaceRoot || sdkRecord?.cwd
				? await this.options.sessions.resolveStorageRootsForWorkspace(sdkRecord.workspaceRoot || sdkRecord.cwd || "")
				: undefined
		const legacyTask = projectRoots ? undefined : this.findLegacyTask(sessionId)
		let cwd: string | undefined = legacyTask?.dataDir
		if (!cwd) {
			const historyItem = await this.findHistoryItem(sessionId)
			cwd = historyItem?.cwdOnTaskInitialization
		}

		try {
			const host = sdkRecord
				? await this.getHistoryHostForSession(sessionId, sdkRecord)
				: projectRoots
					? await this.getHistoryHost(projectRoots.workspaceRoot)
					: typeof this.options.sessions.getUnscopedHost === "function"
						? await this.options.sessions.getUnscopedHost()
						: await this.getHistoryHost()
			await host.delete(sessionId)
		} catch (error) {
			if (!legacyTask) {
				throw error
			}
			Logger.warn(`[SdkTaskHistory] SDK session missing while deleting legacy task: ${sessionId}`, error)
		}
		if (legacyTask && !this.isCutoverActive()) {
			deleteLegacyTask(sessionId, legacyTask.dataDir)
		}
		if (cwd) {
			try {
				await deleteWorkspaceSession(cwd, sessionId)
			} catch {
				// Non-blocking
			}
		}
		this.invalidateMetadataHistoryCache()
	}

	async findHistoryItem(taskId: string): Promise<HistoryItem | undefined> {
		if (this.isCloudTask(taskId)) {
			const cloudRecord = await this.options.cloud?.find(taskId)
			return cloudRecord ? sessionHistoryRecordToHistoryItem(cloudRecord) : undefined
		}
		const currentProjectRoots = await this.getCurrentProjectStorageRoots()
		const sdkRecord = await this.getSessionRecord(taskId)
		if (currentProjectRoots && !sdkRecord) {
			throw new Error(`Session not found in selected project workspace: ${taskId}`)
		}
		const sdkHistoryItem = await (async () => {
			if (!sdkRecord || sdkRecord.isSubagent === true) {
				return undefined
			}
			const host = await this.getHistoryHostForSession(taskId, sdkRecord)
			const historyItem = sessionHistoryRecordToHistoryItem(sdkRecord)
			historyItem.size = await this.getCachedTaskSize(host, sdkRecord)
			return historyItem
		})()
		if (sdkHistoryItem) {
			return sdkHistoryItem
		}
		if (await this.getCurrentProjectStorageRoots()) return undefined

		if (this.isCutoverActive()) {
			return undefined
		}

		const legacyItem = this.findLegacyTask(taskId)?.item
		return legacyItem ? { ...legacyItem, isLegacy: true } : undefined
	}

	async deleteTaskFromState(id: string): Promise<HistoryItem[]> {
		await this.deleteSession(id)
		return (await this.listHistory()).map(sessionHistoryRecordToHistoryItem)
	}

	async deleteAllTaskHistory(options: { preserveFavorites?: boolean } = {}): Promise<number> {
		// Cloud sessions are account-wide control-plane records (possibly started from
		// another client), so bulk-clearing local history must never delete them.
		const history = (await this.listHistory({ hydrate: false })).filter((item) => !this.isCloudTask(item.sessionId))
		const tasksToDelete = options.preserveFavorites
			? history.filter(
					(item) =>
						!(
							metadataBoolean(item.metadata, "isFavorited") ??
							metadataBoolean(item.metadata, "is_favorited") ??
							false
						),
				)
			: history

		let deletedCount = 0
		for (const item of tasksToDelete) {
			try {
				await this.deleteSession(item.sessionId)
				deletedCount += 1
			} catch (error) {
				Logger.error(`[SdkTaskHistory] Failed to delete task history item: ${item.sessionId}`, error)
			}
		}

		return deletedCount
	}

	async updateTaskHistory(item: HistoryItem): Promise<HistoryItem[]> {
		await this.updateTaskHistoryItem(item)
		return (await this.listHistory()).map(sessionHistoryRecordToHistoryItem)
	}

	async updateTaskUsage(taskId: string | undefined, usage: TaskUsage): Promise<void> {
		Logger.log(
			`[SdkController] Task usage: tokensIn=${usage.tokensIn}, tokensOut=${usage.tokensOut}, cost=${usage.totalCost ?? 0}`,
		)

		if (!taskId || this.isCloudTask(taskId)) {
			return
		}

		const historyItem = await this.findHistoryItem(taskId)
		if (!historyItem) {
			return
		}

		historyItem.tokensIn = (historyItem.tokensIn || 0) + usage.tokensIn
		historyItem.tokensOut = (historyItem.tokensOut || 0) + usage.tokensOut
		historyItem.cacheReads = (historyItem.cacheReads || 0) + (usage.cacheReads ?? 0)
		historyItem.cacheWrites = (historyItem.cacheWrites || 0) + (usage.cacheWrites ?? 0)
		historyItem.totalCost = (historyItem.totalCost || 0) + (usage.totalCost ?? 0)
		historyItem.ts = Date.now()

		await this.updateTaskHistoryItem(historyItem)
	}

	private async getCachedTaskSize(host: SdkSessionHost, record: SessionHistoryRecord): Promise<number | undefined> {
		// metadata.size is a display cache: fill it when absent, and let explicit item.size updates replace it.
		const cachedSize = metadataNumber(record.metadata, "size")
		if (cachedSize !== undefined && cachedSize >= 0) {
			return cachedSize
		}

		const artifactSize = await this.getSessionArtifactSize(record)
		if (artifactSize !== undefined) {
			await this.cacheTaskSize(host, record, artifactSize)
			return artifactSize
		}

		return undefined
	}

	private async getSessionArtifactSize(record: SessionHistoryRecord): Promise<number | undefined> {
		const messagesPath = typeof record.messagesPath === "string" ? record.messagesPath.trim() : ""
		if (!messagesPath) {
			return undefined
		}

		try {
			const size = await getFolderSize.loose(path.dirname(messagesPath), {
				bigint: false,
			})
			return Number.isFinite(size) ? size : undefined
		} catch (error) {
			Logger.warn(`[SdkTaskHistory] Failed to calculate SDK session size: ${record.sessionId}`, error)
			return undefined
		}
	}

	private async cacheTaskSize(host: SdkSessionHost, record: SessionHistoryRecord, size: number): Promise<void> {
		if (!Number.isFinite(size) || size < 0 || metadataNumber(record.metadata, "size") === size) {
			return
		}

		await host.update(record.sessionId, {
			metadata: {
				...(record.metadata ?? {}),
				size,
			},
		})
		this.invalidateMetadataHistoryCache()
	}
}
