import { MANDATORY_DENY_WRITE_PATHS } from "@cline/shared/orvanta"
import { type AgentAutoApproval } from "@shared/AutoApprovalSettings"
import { OrvantaAgentProfile, type OrvantaRosterAgent } from "@shared/proto/cline/orvanta"
import {
	type Icon,
	IconAlertCircle,
	IconBrain,
	IconBroadcast,
	IconCheck,
	IconCode,
	IconCompass,
	IconDeviceFloppy,
	IconFileText,
	IconMessage,
	IconPencil,
	IconRobot,
	IconRuler,
	IconSearch,
	IconServer,
	IconShieldExclamation as IconShieldAlert,
	IconShieldLock,
	IconSparkles,
	IconStar,
	IconTarget,
	IconTools,
	IconTrash,
	IconUpload,
	IconUser,
} from "@tabler/icons-react"
import { useEffect, useMemo, useRef, useState } from "react"
import ReactMarkdown from "react-markdown"
import { InstructionsRulesTab, type WorkspaceRuleItem } from "./InstructionsRulesTab"
import { McpServersTab } from "./McpServersTab"
import { MemoryTab } from "./MemoryTab"
import { ModelParamsTab } from "./ModelParamsTab"
import { SkillsTab, type WorkspaceSkillItem } from "./SkillsTab"
import { ToolsPermissionsTab } from "./ToolsPermissionsTab"
import { getAllowedManagers } from "./tree-utils"

const AGENT_ID_RE = /^[a-z][a-z0-9_-]{1,31}$/

export type EditorTab = "profile" | "model" | "tools" | "rules" | "skills" | "mcp" | "memory"

export interface EditorTabInfo {
	id: EditorTab
	label: string
	icon: Icon
}

export const EDITOR_TABS: EditorTabInfo[] = [
	{ id: "profile", label: "Profile", icon: IconUser },
	{ id: "model", label: "Thông số", icon: IconBrain },
	{ id: "memory", label: "Memory", icon: IconFileText },
	{ id: "tools", label: "Tools", icon: IconTools },
	{ id: "rules", label: "Rules", icon: IconFileText },
	{ id: "skills", label: "Skills", icon: IconSparkles },
	{ id: "mcp", label: "MCP", icon: IconServer },
]

function getAgentRoleIcon(role: string, id: string) {
	const lowerId = id.toLowerCase()
	if (role === "lead" || lowerId.includes("lead") || lowerId === "coordinator") {
		return { icon: IconStar, color: "text-amber-400", bg: "bg-amber-500/10 border-amber-500/30" }
	}
	if (lowerId.includes("coder") || lowerId.includes("dev") || lowerId.includes("implementer")) {
		return { icon: IconCode, color: "text-violet-400", bg: "bg-violet-500/10 border-violet-500/30" }
	}
	if (lowerId.includes("review") || lowerId.includes("audit") || lowerId.includes("qa")) {
		return { icon: IconSearch, color: "text-indigo-400", bg: "bg-indigo-500/10 border-indigo-500/30" }
	}
	if (lowerId.includes("arch")) {
		return { icon: IconRuler, color: "text-sky-400", bg: "bg-sky-500/10 border-sky-500/30" }
	}
	if (lowerId.includes("research")) {
		return { icon: IconCompass, color: "text-teal-400", bg: "bg-teal-500/10 border-teal-500/30" }
	}
	if (lowerId.includes("skeptic") || lowerId.includes("critic")) {
		return { icon: IconShieldAlert, color: "text-rose-400", bg: "bg-rose-500/10 border-rose-500/30" }
	}
	if (lowerId.includes("writer") || lowerId.includes("doc")) {
		return { icon: IconPencil, color: "text-emerald-400", bg: "bg-emerald-500/10 border-emerald-500/30" }
	}
	if (lowerId.includes("sale") || lowerId.includes("outreach")) {
		return { icon: IconTarget, color: "text-orange-400", bg: "bg-orange-500/10 border-orange-500/30" }
	}
	return { icon: IconRobot, color: "text-slate-300", bg: "bg-slate-500/10 border-slate-500/30" }
}

export type AgentEditorProps = {
	initialProfile: OrvantaAgentProfile
	isNew: boolean
	isCoordinator: boolean
	existingIds: string[]
	rosterAgents?: OrvantaRosterAgent[]
	allProfiles?: Record<string, OrvantaAgentProfile>
	availableRules?: WorkspaceRuleItem[]
	availableSkills?: WorkspaceSkillItem[]
	defaultTab?: EditorTab
	onSave: (profile: OrvantaAgentProfile) => Promise<boolean>
	onDelete?: (agentId: string) => Promise<boolean>
	onClose: () => void
	onChatWithAgent?: (agentId: string) => void
	onOpenWarRoom?: () => void
	onDirtyChange?: (isDirty: boolean) => void
}

export const AgentEditor = ({
	initialProfile,
	isNew,
	isCoordinator,
	existingIds,
	rosterAgents,
	allProfiles,
	availableRules,
	availableSkills,
	defaultTab,
	onSave,
	onDelete,
	onClose,
	onChatWithAgent,
	onOpenWarRoom,
	onDirtyChange,
}: AgentEditorProps) => {
	const [activeTab, setActiveTab] = useState<EditorTab>(defaultTab ?? "profile")
	const [id, setId] = useState(initialProfile.id)
	const [displayName, setDisplayName] = useState(initialProfile.displayName)
	const [description, setDescription] = useState(initialProfile.description)
	const initialRole = initialProfile.role || (isCoordinator ? "lead" : "teammate")
	const [role, setRole] = useState<string>(initialRole)
	const initialReportsTo = initialProfile.reportsTo ?? (isCoordinator ? null : "coordinator")
	const [reportsTo, setReportsTo] = useState<string | null>(initialReportsTo)
	const [modelId, setModelId] = useState(initialProfile.modelId ?? "")
	const [providerId, setProviderId] = useState(initialProfile.providerId ?? "")
	const [reasoningEffort, setReasoningEffort] = useState<string>(initialProfile.reasoningEffort || "none")
	const [supportsImages, setSupportsImages] = useState<boolean>(initialProfile.supportsImages ?? true)
	const [contextWindow, setContextWindow] = useState<number>(initialProfile.contextWindow || 128000)
	const [maxOutputTokens, setMaxOutputTokens] = useState<number>(initialProfile.maxOutputTokens || 8192)
	const [maxIterations, setMaxIterations] = useState<number>(initialProfile.maxIterations || 40)
	const initialTemperature =
		initialProfile.temperature !== undefined && initialProfile.temperature !== null
			? String(initialProfile.temperature)
			: "0.7"
	const [temperature, setTemperature] = useState<string>(initialTemperature)
	const [instructions, setInstructions] = useState(initialProfile.instructions)
	const [rules, setRules] = useState<string[]>(initialProfile.rules ?? [])
	const [skills, setSkills] = useState<string[]>(initialProfile.skills ?? [])
	const [allowTools, setAllowTools] = useState<string[]>(initialProfile.tools?.allow ?? [])
	const [denyTools, setDenyTools] = useState<string[]>(initialProfile.tools?.deny ?? [])

	const initialAllowPaths =
		initialProfile.scopePaths?.allow && initialProfile.scopePaths.allow.length > 0
			? initialProfile.scopePaths.allow
			: ["**/*"]
	const [allowPaths, setAllowPaths] = useState<string[]>(initialAllowPaths)

	const initialCustomDeny = (initialProfile.scopePaths?.denyWrite ?? []).filter(
		(p) => !(MANDATORY_DENY_WRITE_PATHS as readonly string[]).includes(p),
	)
	const [customDenyPaths, setCustomDenyPaths] = useState<string[]>(initialCustomDeny)

	const parseInitialAutoApproval = (): AgentAutoApproval => {
		if (initialProfile.autoApprovalJson) {
			try {
				return JSON.parse(initialProfile.autoApprovalJson)
			} catch {}
		}
		return {
			enabled: false,
			readFiles: true,
			editFiles: false,
			executeCommands: false,
			useBrowser: false,
			useMcp: false,
		}
	}

	const [autoApproval, setAutoApproval] = useState<AgentAutoApproval>(parseInitialAutoApproval)
	const [agentMcpServers, setAgentMcpServers] = useState<string[]>(initialProfile.mcpServers ?? [])

	// Remount already happens when agent id / new|edit changes (`key` in AgentsView).
	// Do NOT reset on every `initialProfile` reference churn from parent re-renders
	// (company/state push) — that flips Auto-Approve and other edits back off mid-edit.
	useEffect(() => {
		setId(initialProfile.id)
		setDisplayName(initialProfile.displayName)
		setDescription(initialProfile.description)
		setRole(initialProfile.role || (isCoordinator ? "lead" : "teammate"))
		setReportsTo(initialProfile.reportsTo ?? (isCoordinator ? null : "coordinator"))
		setModelId(initialProfile.modelId ?? "")
		setProviderId(initialProfile.providerId ?? "")
		setReasoningEffort(initialProfile.reasoningEffort || "none")
		setSupportsImages(initialProfile.supportsImages ?? true)
		setContextWindow(initialProfile.contextWindow || 128000)
		setMaxOutputTokens(initialProfile.maxOutputTokens || 8192)
		setMaxIterations(initialProfile.maxIterations || 40)
		setTemperature(
			initialProfile.temperature !== undefined && initialProfile.temperature !== null
				? String(initialProfile.temperature)
				: "0.7",
		)
		setInstructions(initialProfile.instructions)
		setRules(initialProfile.rules ?? [])
		setSkills(initialProfile.skills ?? [])
		setAllowTools(initialProfile.tools?.allow ?? [])
		setDenyTools(initialProfile.tools?.deny ?? [])
		setAllowPaths(
			initialProfile.scopePaths?.allow && initialProfile.scopePaths.allow.length > 0
				? initialProfile.scopePaths.allow
				: ["**/*"],
		)
		setCustomDenyPaths(
			(initialProfile.scopePaths?.denyWrite ?? []).filter(
				(p) => !(MANDATORY_DENY_WRITE_PATHS as readonly string[]).includes(p),
			),
		)
		setAutoApproval(parseInitialAutoApproval())
		setAgentMcpServers(initialProfile.mcpServers ?? [])
		// biome-ignore lint/correctness/useExhaustiveDependencies: only re-hydrate when switching agent / new vs edit — not on parent profile reference churn
	}, [initialProfile.id, isNew, isCoordinator])

	const [error, setError] = useState<string | undefined>()
	const [saving, setSaving] = useState(false)
	const [saveSuccess, setSaveSuccess] = useState(false)
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
	const mdFileInputRef = useRef<HTMLInputElement>(null)
	const [instructionsMode, setInstructionsMode] = useState<"edit" | "preview">("edit")

	const handleLoadFromMdFile = (e: React.ChangeEvent<HTMLInputElement>) => {
		const file = e.target.files?.[0]
		if (!file) return
		const reader = new FileReader()
		reader.onload = (event) => {
			const text = (event.target?.result as string) || ""
			if (text) {
				const frontmatterMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
				if (frontmatterMatch) {
					const yamlPart = frontmatterMatch[1]
					const bodyPart = frontmatterMatch[2].trim()
					if (bodyPart) {
						setInstructions(bodyPart)
					} else {
						setInstructions(text.trim())
					}
					const descMatch = yamlPart.match(/description:\s*(?:["'](.*?)["']|(.*))$/m)
					const extractedDesc = descMatch ? (descMatch[1] || descMatch[2] || "").trim() : ""
					if (extractedDesc) {
						setDescription(extractedDesc.slice(0, 200))
					}
				} else {
					setInstructions(text.trim())
				}
			}
		}
		reader.readAsText(file)
		e.target.value = ""
	}

	const availableRosterAgents = useMemo<OrvantaRosterAgent[]>(() => {
		if (rosterAgents && rosterAgents.length > 0) {
			return rosterAgents
		}
		return existingIds.map((eid) => ({
			id: eid,
			displayName: eid === "coordinator" ? "Company Coordinator" : eid,
			role: eid === "coordinator" ? "lead" : "teammate",
			status: "idle",
			reportsTo: eid === "coordinator" ? undefined : "coordinator",
			legacySlugs: [],
		}))
	}, [rosterAgents, existingIds])

	const allowedManagers = useMemo(() => {
		if (isCoordinator || id === "coordinator") {
			return []
		}
		return getAllowedManagers(id, availableRosterAgents, allProfiles)
	}, [id, isCoordinator, availableRosterAgents, allProfiles])

	const handleQuickChat = () => {
		const targetId = id || initialProfile.id
		if (onChatWithAgent && targetId) {
			onChatWithAgent(targetId)
		} else {
			window.postMessage(
				{
					type: "orvanta_switch_tab",
					tab: "chat",
					agentId: targetId,
				},
				"*",
			)
		}
	}

	const isDirty =
		id !== initialProfile.id ||
		displayName !== initialProfile.displayName ||
		description !== initialProfile.description ||
		(!isCoordinator && role !== initialRole) ||
		(!isCoordinator && reportsTo !== initialReportsTo) ||
		modelId !== (initialProfile.modelId ?? "") ||
		providerId !== (initialProfile.providerId ?? "") ||
		reasoningEffort !== (initialProfile.reasoningEffort || "none") ||
		supportsImages !== (initialProfile.supportsImages ?? true) ||
		contextWindow !== (initialProfile.contextWindow || 128000) ||
		maxOutputTokens !== (initialProfile.maxOutputTokens || 8192) ||
		maxIterations !== (initialProfile.maxIterations || 40) ||
		temperature !== initialTemperature ||
		instructions !== initialProfile.instructions ||
		JSON.stringify(rules) !== JSON.stringify(initialProfile.rules ?? []) ||
		JSON.stringify(skills) !== JSON.stringify(initialProfile.skills ?? []) ||
		JSON.stringify(allowTools) !== JSON.stringify(initialProfile.tools?.allow ?? []) ||
		JSON.stringify(denyTools) !== JSON.stringify(initialProfile.tools?.deny ?? []) ||
		JSON.stringify(allowPaths) !== JSON.stringify(initialAllowPaths) ||
		JSON.stringify(customDenyPaths) !== JSON.stringify(initialCustomDeny) ||
		JSON.stringify(autoApproval) !== JSON.stringify(parseInitialAutoApproval()) ||
		JSON.stringify(agentMcpServers) !== JSON.stringify(initialProfile.mcpServers ?? [])

	useEffect(() => {
		onDirtyChange?.(isDirty)
	}, [isDirty, onDirtyChange])

	const handleSave = async () => {
		const trimmedId = id.trim()
		const trimmedName = displayName.trim()
		const trimmedDesc = description.trim()
		const trimmedInstructions = instructions.trim()

		if (!AGENT_ID_RE.test(trimmedId)) {
			setError("Id chỉ được dùng chữ thường a-z, số 0-9, gạch ngang/dưới (2-32 ký tự, bắt đầu bằng chữ)")
			return
		}
		if (isNew && existingIds.includes(trimmedId)) {
			setError(`Id '${trimmedId}' đã tồn tại trong danh sách agent`)
			return
		}
		if (!trimmedName || trimmedName.length > 48) {
			setError("Tên hiển thị phải từ 1 đến 48 ký tự")
			return
		}
		if (!trimmedInstructions) {
			setError("Instructions không được để trống")
			return
		}
		if (maxIterations < 1 || maxIterations > 200) {
			setError("Max iterations phải trong khoảng 1–200")
			return
		}

		let parsedTemp: number | undefined
		if (temperature.trim() !== "") {
			const n = parseFloat(temperature.trim())
			if (Number.isNaN(n) || n < 0 || n > 2) {
				setError("Temperature phải là số từ 0 đến 2, hoặc để trống")
				return
			}
			parsedTemp = n
		}

		const allDenyWrite = Array.from(new Set([...MANDATORY_DENY_WRITE_PATHS, ...customDenyPaths]))

		const profileToSave = OrvantaAgentProfile.create({
			id: trimmedId,
			agentNumericId: initialProfile.agentNumericId !== undefined ? initialProfile.agentNumericId : undefined,
			displayName: trimmedName,
			description: trimmedDesc,
			role: isCoordinator ? "lead" : role,
			reportsTo: isCoordinator ? undefined : reportsTo?.trim() ? reportsTo.trim() : undefined,
			providerId: providerId.trim() ? providerId.trim() : undefined,
			modelId: modelId.trim() ? modelId.trim() : undefined,
			reasoningEffort: reasoningEffort !== "none" ? reasoningEffort : undefined,
			supportsImages: supportsImages,
			contextWindow: contextWindow > 0 ? contextWindow : undefined,
			maxOutputTokens: maxOutputTokens > 0 ? maxOutputTokens : undefined,
			maxIterations,
			temperature: parsedTemp,
			instructions: trimmedInstructions,
			rules: rules,
			skills: skills,
			filePath: initialProfile.filePath || `org/agents/${trimmedId}/profile.md`,
			tools: {
				allow: allowTools,
				deny: denyTools,
			},
			scopePaths: {
				allow: allowPaths,
				denyWrite: allDenyWrite,
			},
			autoApprovalJson: JSON.stringify(autoApproval),
			mcpServers: agentMcpServers,
		})

		setError(undefined)
		setSaving(true)
		try {
			const success = await onSave(profileToSave)
			if (success) {
				setSaveSuccess(true)
				setTimeout(() => {
					onClose()
				}, 600)
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setSaving(false)
		}
	}

	const handleDelete = async () => {
		if (isCoordinator || !onDelete) return
		setSaving(true)
		try {
			const success = await onDelete(initialProfile.id)
			if (success) {
				onClose()
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err))
		} finally {
			setSaving(false)
			setShowDeleteConfirm(false)
		}
	}

	const avatarInfo = getAgentRoleIcon(role, id || initialProfile.id)
	const RoleIconComponent = avatarInfo.icon

	return (
		<div
			className="relative flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden bg-(--vscode-editor-background) text-sm text-(--vscode-foreground)"
			data-testid="agent-editor-panel">
			{/* Top Header Bar */}
			<div
				className="flex shrink-0 items-center justify-between border-b border-border-panel px-4 py-2 bg-(--vscode-sideBar-background)/50"
				data-testid="agent-editor-header">
				<div className="flex items-center gap-2 truncate pr-2">
					<span className="font-semibold text-sm truncate text-(--vscode-foreground)">
						{isNew ? "Thêm agent mới" : `Sửa agent: ${displayName || id}`}
					</span>
					{isCoordinator ? (
						<span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300 flex items-center gap-1 shrink-0">
							<IconShieldLock size={11} stroke={1.5} />
							<span>Lead</span>
						</span>
					) : (
						<span className="rounded bg-(--vscode-badge-background) px-1.5 py-0.5 text-[10px] font-medium text-(--vscode-badge-foreground) shrink-0">
							@{id || "draft"}
						</span>
					)}
				</div>

				<div className="flex items-center gap-2.5 shrink-0">
					{/* Status Indicator */}
					<div className="hidden sm:flex items-center mr-1">
						{isDirty ? (
							<span
								className="flex items-center gap-1.5 text-xs text-amber-400 font-medium"
								data-testid="dirty-indicator">
								<span className="h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
								<span>Chưa lưu</span>
							</span>
						) : (
							<span className="flex items-center gap-1 text-xs text-(--vscode-descriptionForeground) opacity-80">
								<IconCheck className="text-emerald-400 shrink-0" size={12} stroke={1.5} />
								<span>Đã đồng bộ</span>
							</span>
						)}
					</div>

					{!isNew && !isCoordinator && onDelete && (
						<button
							className="flex items-center gap-1.5 rounded border border-error/50 hover:border-error hover:bg-error/10 px-2.5 py-1 text-xs font-medium text-error transition-colors cursor-pointer"
							data-testid="quick-fire-button"
							disabled={saving}
							onClick={() => setShowDeleteConfirm(true)}
							type="button">
							<IconTrash size={13} stroke={1.5} />
							<span>Sa thải</span>
						</button>
					)}

					<button
						className="flex items-center gap-1.5 rounded bg-(--vscode-button-background) px-3.5 py-1 text-xs font-semibold text-(--vscode-button-foreground) hover:bg-(--vscode-button-hoverBackground) disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer transition-colors shadow-xs"
						data-testid="editor-save-button"
						disabled={saving || (!isDirty && !isNew)}
						onClick={handleSave}
						type="button">
						{saving ? (
							<span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
						) : (
							<IconDeviceFloppy size={13} stroke={1.5} />
						)}
						<span>{saving ? "Đang lưu…" : "Lưu"}</span>
					</button>
				</div>
			</div>

			{/* Sub-tabs bar */}
			<div
				className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border-panel bg-(--vscode-sideBar-background)/30 px-4 py-1.5 scroller-x"
				data-testid="agent-editor-tabs">
				{EDITOR_TABS.map((tab) => {
					const isActive = activeTab === tab.id
					const TabIcon = tab.icon
					return (
						<button
							className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer select-none ${
								isActive
									? "bg-(--vscode-button-background) text-(--vscode-button-foreground) shadow-xs"
									: "text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground) hover:bg-white/5"
							}`}
							data-testid={`editor-tab-${tab.id}`}
							key={tab.id}
							onClick={() => setActiveTab(tab.id)}
							type="button">
							<TabIcon className="shrink-0" size={14} stroke={1.5} />
							<span>{tab.label}</span>
						</button>
					)
				})}
			</div>

			<div className="flex-1 min-h-0 min-w-0 w-full overflow-y-auto scroller-y" data-testid="agent-editor-scroll">
				<div className="flex flex-col gap-4 p-4 pb-6">
					{error && (
						<div
							className="flex shrink-0 items-center gap-2 rounded border border-error/50 bg-error/10 p-2.5 text-xs text-error"
							data-testid="agent-editor-error">
							<IconAlertCircle className="shrink-0" size={14} stroke={1.5} />
							<span className="flex-1">{error}</span>
							<button
								className="hover:underline text-xs cursor-pointer opacity-70 hover:opacity-100"
								onClick={() => setError(undefined)}
								type="button">
								Bỏ qua
							</button>
						</div>
					)}

					{saveSuccess && (
						<div
							className="rounded border border-emerald-500/50 bg-emerald-950/30 p-2.5 text-xs text-emerald-300 flex items-center gap-2"
							data-testid="save-success-banner">
							<IconCheck className="text-emerald-400 shrink-0" size={14} stroke={2} />
							<span>Đã lưu thông tin agent thành công!</span>
						</div>
					)}

					{/* Tab 1: Profile */}
					{activeTab === "profile" && (
						<div className="flex flex-col gap-4" data-testid="tab-panel-profile">
							{/* Overview Card with Avatar and Chat Action */}
							<div className="flex items-center justify-between rounded-lg border border-border-panel bg-(--vscode-sideBar-background)/40 p-3.5">
								<div className="flex items-center gap-3 min-w-0">
									<div
										className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border ${avatarInfo.bg}`}>
										<RoleIconComponent className={avatarInfo.color} size={22} stroke={1.5} />
									</div>
									<div className="flex flex-col min-w-0">
										<div className="flex items-center gap-2">
											<span className="font-semibold text-sm text-(--vscode-foreground) truncate">
												{displayName || id || "Chưa đặt tên"}
											</span>
											{isCoordinator ? (
												<span className="rounded bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 text-[10px] font-semibold text-amber-300">
													Root Lead
												</span>
											) : (
												<span className="rounded bg-(--vscode-badge-background) px-1.5 py-0.2 text-[10px] font-medium text-(--vscode-badge-foreground)">
													{role === "lead" ? "Lead" : "Teammate"}
												</span>
											)}
										</div>
										<span className="font-mono text-xs text-(--vscode-descriptionForeground) opacity-80 truncate">
											@{id || "id"} {reportsTo ? `• Báo cáo cho: @${reportsTo}` : ""}
										</span>
									</div>
								</div>

								<div className="flex flex-wrap items-center gap-2 shrink-0">
									<button
										className="flex items-center gap-1.5 rounded bg-(--vscode-button-background) hover:bg-(--vscode-button-hoverBackground) px-3 py-1.5 text-xs font-medium text-(--vscode-button-foreground) transition-colors cursor-pointer shadow-xs"
										data-testid="quick-chat-button"
										onClick={handleQuickChat}
										type="button">
										<IconMessage size={14} stroke={1.5} />
										<span>Chat</span>
									</button>
									{onOpenWarRoom && (
										<button
											className="flex items-center gap-1.5 rounded border border-border-panel bg-input-background hover:bg-white/5 px-3 py-1.5 text-xs font-medium text-(--vscode-foreground) transition-colors cursor-pointer"
											data-testid="quick-war-room-button"
											onClick={onOpenWarRoom}
											type="button">
											<IconBroadcast size={14} stroke={1.5} />
											<span>War room</span>
										</button>
									)}
								</div>
							</div>

							{/* Form inputs */}
							<div className="grid grid-cols-2 gap-3.5">
								<label className="flex flex-col gap-1.5">
									<span className="text-xs font-medium text-(--vscode-foreground)">Mã định danh (ID)</span>
									<input
										className="rounded border border-border-panel bg-input-background px-2.5 py-1.5 font-mono text-xs text-(--vscode-foreground) disabled:opacity-50"
										disabled={!isNew || isCoordinator}
										maxLength={32}
										onChange={(e) => setId(e.target.value.toLowerCase())}
										placeholder="ví dụ: reviewer"
										value={id}
									/>
								</label>

								<label className="flex flex-col gap-1.5">
									<span className="text-xs font-medium text-(--vscode-foreground)">
										Tên hiển thị (Display Name)
									</span>
									<input
										className="rounded border border-border-panel bg-input-background px-2.5 py-1.5 text-xs text-(--vscode-foreground)"
										maxLength={48}
										onChange={(e) => setDisplayName(e.target.value)}
										placeholder="Tên agent"
										value={displayName}
									/>
								</label>
							</div>

							<div className="grid grid-cols-2 gap-3.5">
								<label className="flex flex-col gap-1.5">
									<span className="text-xs font-medium text-(--vscode-foreground)">Vai trò (Role)</span>
									<select
										className="rounded border border-border-panel bg-input-background px-2.5 py-1.5 text-xs text-(--vscode-foreground) disabled:opacity-50"
										data-testid="agent-role-select"
										disabled={isCoordinator}
										onChange={(e) => setRole(e.target.value)}
										value={role}>
										<option value="teammate">Teammate (Thành viên)</option>
										<option value="lead">Lead (Trưởng nhóm)</option>
									</select>
								</label>

								<label className="flex flex-col gap-1.5">
									<span className="text-xs font-medium text-(--vscode-foreground)">
										Quản lý bởi (Reports To)
									</span>
									{isCoordinator ? (
										<input
											className="rounded border border-border-panel bg-input-background px-2.5 py-1.5 text-xs opacity-60 text-(--vscode-foreground)"
											disabled
											value="Không (Root Coordinator)"
										/>
									) : (
										<select
											className="rounded border border-border-panel bg-input-background px-2.5 py-1.5 text-xs text-(--vscode-foreground)"
											data-testid="agent-reports-to-select"
											onChange={(e) => setReportsTo(e.target.value || null)}
											value={reportsTo ?? ""}>
											{allowedManagers.map((m) => (
												<option key={m.id} value={m.id}>
													{m.displayName} (@{m.id})
												</option>
											))}
											{allowedManagers.length === 0 && <option value="">Không có quản lý khả dụng</option>}
										</select>
									)}
								</label>
							</div>

							{/* Short Description */}
							<label className="flex flex-col gap-1.5">
								<div className="flex items-center justify-between">
									<span className="text-xs font-medium text-(--vscode-foreground)">Mô tả</span>
									<span className="text-[11px] text-(--vscode-descriptionForeground) opacity-80">
										{description.length}/200 ký tự
									</span>
								</div>
								<textarea
									className="field-sizing-content min-h-[60px] w-full resize-y rounded border border-border-panel bg-input-background p-2.5 text-xs leading-relaxed text-(--vscode-foreground) focus:outline-hidden focus:border-(--vscode-focusBorder)"
									maxLength={200}
									onChange={(e) => setDescription(e.target.value)}
									placeholder="Tóm tắt ngắn gọn nhiệm vụ chính, vai trò và phạm vi làm việc của agent..."
									rows={2}
									value={description}
								/>
							</label>

							{/* Detailed Description (Instructions / SOP from md) */}
							<div className="flex flex-col gap-2 rounded-lg border border-border-panel bg-(--vscode-sideBar-background)/40 p-3.5">
								<div className="flex items-center justify-between flex-wrap gap-2">
									<div className="flex items-center gap-2">
										<span className="text-xs font-semibold text-(--vscode-foreground)">
											Mô tả chi tiết (System Prompt / SOP)
										</span>
										<span className="font-mono text-[10px] text-(--vscode-descriptionForeground) opacity-80">
											{instructions.trim() ? instructions.trim().split(/\s+/).length : 0} từ •{" "}
											{instructions.length} ký tự
										</span>
									</div>
									<div className="flex items-center gap-1.5">
										<input
											accept=".md,.markdown,text/markdown,text/plain"
											className="hidden"
											id="profile-load-md-file"
											onChange={handleLoadFromMdFile}
											ref={mdFileInputRef}
											type="file"
										/>
										<button
											className="flex items-center gap-1 rounded border border-border-panel bg-input-background hover:bg-white/5 px-2.5 py-1 text-xs text-(--vscode-foreground) cursor-pointer transition-colors"
											data-testid="load-md-file-button"
											onClick={() => mdFileInputRef.current?.click()}
											title="Tải nội dung từ file Markdown (.md)"
											type="button">
											<IconUpload size={13} stroke={1.5} />
											<span>Tải từ file .md</span>
										</button>
										<div className="flex rounded border border-border-panel p-0.5 bg-input-background">
											<button
												className={`px-2 py-0.5 text-xs rounded transition-colors cursor-pointer ${
													instructionsMode === "edit"
														? "bg-(--vscode-button-background) text-(--vscode-button-foreground) font-semibold"
														: "text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
												}`}
												onClick={() => setInstructionsMode("edit")}
												type="button">
												Soạn thảo
											</button>
											<button
												className={`px-2 py-0.5 text-xs rounded transition-colors cursor-pointer ${
													instructionsMode === "preview"
														? "bg-(--vscode-button-background) text-(--vscode-button-foreground) font-semibold"
														: "text-(--vscode-descriptionForeground) hover:text-(--vscode-foreground)"
												}`}
												onClick={() => setInstructionsMode("preview")}
												type="button">
												Xem trước
											</button>
										</div>
									</div>
								</div>

								{instructionsMode === "edit" ? (
									<textarea
										className="min-h-[160px] w-full resize-y rounded border border-border-panel bg-input-background p-2.5 font-mono text-xs leading-relaxed text-(--vscode-foreground) focus:outline-hidden focus:border-(--vscode-focusBorder) scroller-y"
										data-testid="profile-instructions-textarea"
										onChange={(e) => setInstructions(e.target.value)}
										placeholder="Nội dung Markdown hướng dẫn chi tiết, SOP, quy trình thực thi nhiệm vụ..."
										rows={7}
										value={instructions}
									/>
								) : (
									<div
										className="min-h-[160px] max-h-80 w-full overflow-y-auto rounded border border-border-panel bg-input-background/60 p-3 text-xs leading-relaxed max-w-none scroller-y"
										data-testid="profile-instructions-preview">
										{instructions.trim() ? (
											<div className="prose prose-invert max-w-none text-xs text-(--vscode-foreground)">
												<ReactMarkdown>{instructions}</ReactMarkdown>
											</div>
										) : (
											<div className="text-(--vscode-descriptionForeground) italic text-center py-8">
												Chưa có nội dung mô tả chi tiết để xem trước.
											</div>
										)}
									</div>
								)}
							</div>
						</div>
					)}

					{/* Tab 2: Model & Thông số AI */}
					{activeTab === "model" && (
						<ModelParamsTab
							contextWindow={contextWindow}
							maxIterations={maxIterations}
							maxOutputTokens={maxOutputTokens}
							modelId={modelId}
							providerId={providerId}
							reasoningEffort={reasoningEffort}
							setContextWindow={setContextWindow}
							setMaxIterations={setMaxIterations}
							setMaxOutputTokens={setMaxOutputTokens}
							setModelId={setModelId}
							setProviderId={setProviderId}
							setReasoningEffort={setReasoningEffort}
							setSupportsImages={setSupportsImages}
							setTemperature={setTemperature}
							supportsImages={supportsImages}
							temperature={temperature}
						/>
					)}
					{/* Tab 3: Tools & Quyền Hạn */}
					{activeTab === "tools" && (
						<ToolsPermissionsTab
							allowPaths={allowPaths}
							allowTools={allowTools}
							autoApproval={autoApproval}
							customDenyPaths={customDenyPaths}
							denyTools={denyTools}
							setAllowPaths={setAllowPaths}
							setAllowTools={setAllowTools}
							setAutoApproval={setAutoApproval}
							setCustomDenyPaths={setCustomDenyPaths}
							setDenyTools={setDenyTools}
						/>
					)}

					{/* Tab 4: Rules & Instructions */}
					{activeTab === "rules" && (
						<InstructionsRulesTab
							availableRules={availableRules}
							instructions={instructions}
							selectedRules={rules}
							setInstructions={setInstructions}
							setSelectedRules={setRules}
						/>
					)}

					{/* Tab 5: Skills */}
					{activeTab === "skills" && (
						<SkillsTab availableSkills={availableSkills} selectedSkills={skills} setSelectedSkills={setSkills} />
					)}

					{/* Tab 6: MCP */}
					{activeTab === "mcp" && (
						<McpServersTab agentMcpServers={agentMcpServers} setAgentMcpServers={setAgentMcpServers} />
					)}

					{activeTab === "memory" && (
						<MemoryTab agentId={isNew ? id.trim() : initialProfile.id} disabled={isNew && !id.trim()} />
					)}
				</div>
			</div>

			{/* Confirm Delete Modal */}
			{showDeleteConfirm && (
				<div className="absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
					<div className="flex flex-col gap-3 rounded-lg border border-border-panel bg-(--vscode-sideBar-background) p-4 shadow-xl max-w-sm w-full">
						<div className="flex items-center gap-2">
							<IconTrash className="text-rose-400 shrink-0" size={18} stroke={1.5} />
							<h3 className="font-semibold text-sm text-error">Xóa agent?</h3>
						</div>
						<p className="text-xs text-(--vscode-descriptionForeground)">
							Bạn có chắc chắn muốn xóa agent <strong>{displayName || id}</strong>? File profile và thư mục của
							agent sẽ bị xóa.
						</p>
						<div className="flex justify-end gap-2 pt-1">
							<button
								className="rounded border border-border-panel px-3 py-1 text-xs hover:bg-white/5 cursor-pointer transition-colors"
								onClick={() => setShowDeleteConfirm(false)}
								type="button">
								Hủy
							</button>
							<button
								className="rounded bg-error px-3 py-1 text-xs font-semibold text-white hover:bg-error/80 cursor-pointer transition-colors"
								data-testid="confirm-delete-button"
								onClick={handleDelete}
								type="button">
								Xác nhận xóa
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	)
}

export default AgentEditor
