import type { ClineMessage } from "@shared/ExtensionMessage"

export const COORDINATION_TOOL_NAMES = new Set(["team_run_task", "orvanta_submit_handoff", "team_send_message"])

export type CoordinationCardKind = "assign" | "report"

export interface CoordinationToolInfo {
	tool: string
	senderId: string
	recipientId: string
	kind: CoordinationCardKind
	hasContent: boolean
}

function agentIdOf(message: ClineMessage): string | undefined {
	return message.agentId ?? message.agent_id
}

export function isCoordinatorChannel(agentId?: string | null): boolean {
	return canonicalAgentId(agentId) === "coordinator"
}

/** Map lead/parent/mailbox-style ids (e.g. 1793273682195_h9itp) to coordinator. */
export function canonicalAgentId(agentId?: string | null): string {
	if (!agentId || !agentId.trim()) {
		return ""
	}
	const trimmed = agentId.trim()
	const lower = trimmed.toLowerCase()
	if (
		lower === "coordinator" ||
		lower === "lead" ||
		lower === "parent" ||
		lower === "system" ||
		lower === "agent" ||
		/^\d/.test(trimmed)
	) {
		return "coordinator"
	}
	return lower
}

export function agentIdsEqual(a?: string | null, b?: string | null): boolean {
	if (!a || !b) {
		return false
	}
	return canonicalAgentId(a) === canonicalAgentId(b)
}

/** Dev-6551ae1053d2-1 → dev (role base for loose matching). */
export function agentBaseId(agentId?: string | null): string {
	const canonical = canonicalAgentId(agentId)
	if (!canonical || canonical === "coordinator") {
		return canonical
	}
	const match = canonical.match(/^([a-z][a-z0-9]*)-[0-9a-f]{6,}(?:-\d+)?$/)
	return match ? match[1] : canonical
}

export function agentIdsLooselyEqual(a?: string | null, b?: string | null): boolean {
	if (agentIdsEqual(a, b)) {
		return true
	}
	const baseA = agentBaseId(a)
	const baseB = agentBaseId(b)
	return Boolean(baseA && baseB && baseA === baseB)
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
	const value = record[key]
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

export function parseCoordinationToolMessage(message: ClineMessage): CoordinationToolInfo | undefined {
	if (message.say !== "tool" && message.ask !== "tool") {
		return undefined
	}
	let outer: { tool?: string; content?: unknown }
	try {
		outer = JSON.parse(message.text || "{}") as { tool?: string; content?: unknown }
	} catch {
		return undefined
	}
	if (!outer.tool || !COORDINATION_TOOL_NAMES.has(outer.tool)) {
		return undefined
	}

	let payload: Record<string, unknown> = {}
	if (typeof outer.content === "string") {
		try {
			payload = asRecord(JSON.parse(outer.content))
		} catch {
			payload = {}
		}
	} else {
		payload = asRecord(outer.content)
	}

	const senderId =
		canonicalAgentId(stringField(payload, "fromAgentId") || stringField(payload, "from") || agentIdOf(message)) ||
		"coordinator"

	const explicitRecipient =
		stringField(payload, "toAgentId") ||
		stringField(payload, "assignee") ||
		stringField(payload, "to") ||
		stringField(payload, "recipient") ||
		(outer.tool === "team_run_task" ? stringField(payload, "agentId") : undefined)

	const fallbackRecipient =
		outer.tool === "orvanta_submit_handoff" || (outer.tool === "team_send_message" && senderId !== "coordinator")
			? "coordinator"
			: ""
	const resolvedRecipient = canonicalAgentId(explicitRecipient || fallbackRecipient)

	const hasContent = Boolean(
		stringField(payload, "task") ||
			stringField(payload, "instruction") ||
			stringField(payload, "description") ||
			stringField(payload, "prompt") ||
			stringField(payload, "summary") ||
			stringField(payload, "body") ||
			stringField(payload, "content") ||
			stringField(payload, "subject") ||
			stringField(payload, "message") ||
			stringField(payload, "title") ||
			stringField(payload, "taskTitle") ||
			stringField(payload, "taskId"),
	)

	return {
		tool: outer.tool,
		senderId,
		recipientId: resolvedRecipient,
		kind: getCoordinationCardKind(outer.tool, senderId, resolvedRecipient),
		hasContent,
	}
}

export function getCoordinationCardKind(tool: string, senderId: string, recipientId: string): CoordinationCardKind {
	if (tool === "team_run_task") {
		return "assign"
	}
	if (tool === "orvanta_submit_handoff") {
		return "report"
	}
	if (isCoordinatorChannel(senderId) && !isCoordinatorChannel(recipientId)) {
		return "assign"
	}
	return "report"
}

const HIDDEN_TEAM_TOOL_PREFIX = "team_"

export function isNonVisualToolMessage(message: ClineMessage): boolean {
	if (message.say !== "tool" && message.ask !== "tool") {
		return false
	}
	let toolName = ""
	try {
		toolName = String((JSON.parse(message.text || "{}") as { tool?: string }).tool || "")
	} catch {
		return false
	}
	if (!toolName) {
		return true
	}
	const coordination = parseCoordinationToolMessage(message)
	if (coordination) {
		return !coordination.hasContent || !coordination.recipientId || coordination.recipientId.toLowerCase() === "agent"
	}
	return toolName.startsWith(HIDDEN_TEAM_TOOL_PREFIX)
}

export function coordinationToolInvolvesAgent(info: CoordinationToolInfo, selectedAgentId: string): boolean {
	if (agentIdsEqual(info.senderId, selectedAgentId) || agentIdsEqual(info.recipientId, selectedAgentId)) {
		return true
	}
	if (!isCoordinatorChannel(selectedAgentId)) {
		return false
	}
	return (
		info.tool === "team_run_task" ||
		info.tool === "orvanta_submit_handoff" ||
		(info.kind === "report" && isCoordinatorChannel(info.recipientId))
	)
}

function isRealTaskHeaderMessage(message: ClineMessage | undefined): boolean {
	// Only the opening say:"task" brief belongs in TaskHeader. Follow-up CEO
	// steers (user_feedback) stay in the scrollable transcript as UserMessage
	// bubbles so they keep chronological order and teal chrome under COMPLETED.
	return Boolean(message && message.say === "task")
}

/** Raw JSON / empty API stubs must never become the CEO teal TaskHeader bubble. */
export function isJunkTaskHeaderText(text: string | undefined): boolean {
	const trimmed = (text || "").trim()
	if (!trimmed) {
		return true
	}
	if (trimmed === "{}") {
		return true
	}
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed)
			return parsed !== null && typeof parsed === "object"
		} catch {
			return false
		}
	}
	return false
}

function summarizeCoordinationForTaskHeader(message: ClineMessage): string | undefined {
	const info = parseCoordinationToolMessage(message)
	if (!info?.hasContent) {
		return undefined
	}
	const payload = parseCoordinationToolPayload(message)
	const subject =
		stringField(payload, "subject") ||
		stringField(payload, "title") ||
		stringField(payload, "taskTitle") ||
		stringField(payload, "task") ||
		stringField(payload, "instruction") ||
		stringField(payload, "summary")
	const body =
		stringField(payload, "body") ||
		stringField(payload, "description") ||
		stringField(payload, "prompt") ||
		stringField(payload, "content") ||
		stringField(payload, "message")
	if (subject && body && body !== subject) {
		return `${subject}\n\n${body}`
	}
	return subject || body
}

function placeholderTaskHeader(ts: number): ClineMessage {
	return {
		ts: Math.max(0, ts - 1),
		type: "say",
		say: "task",
		text: "",
	}
}

/**
 * ChatView uses messages[0] as TaskHeader and slices it out of the transcript.
 * Agent channels strip say:"task", so the first remaining row is often a coordination
 * tool — which already renders as a task/message card. Do not also promote that into
 * TaskHeader (duplicate of the purple "Tin nhắn" / "Nhận việc" card).
 *
 * Also never promote api_req_started / raw JSON stubs (e.g. "{}") into the teal bubble.
 */
export function resolveAgentChannelTaskHeader(messages: ClineMessage[]): {
	task: ClineMessage | undefined
	/** Index into `messages` where the scrollable transcript starts. */
	bodyStartIndex: number
	/** Hide TaskHeader chrome; the in-stream coordination card is enough. */
	suppressTaskHeader: boolean
} {
	const first = messages[0]
	if (!first) {
		return { task: undefined, bodyStartIndex: 0, suppressTaskHeader: false }
	}
	if (isRealTaskHeaderMessage(first)) {
		if (isJunkTaskHeaderText(first.text)) {
			return {
				task: placeholderTaskHeader(first.ts),
				bodyStartIndex: 0,
				suppressTaskHeader: true,
			}
		}
		return { task: first, bodyStartIndex: 1, suppressTaskHeader: false }
	}
	if (first.say === "tool" || first.ask === "tool") {
		const coordination = parseCoordinationToolMessage(first)
		// Assign / inbox message / handoff / report cards already carry the brief.
		if (coordination?.hasContent) {
			return {
				task: placeholderTaskHeader(first.ts),
				bodyStartIndex: 0,
				suppressTaskHeader: true,
			}
		}
		const summary = summarizeCoordinationForTaskHeader(first)
		if (summary && !isJunkTaskHeaderText(summary)) {
			return {
				task: {
					ts: Math.max(0, first.ts - 1),
					type: "say",
					say: "task",
					text: summary,
				},
				bodyStartIndex: 0,
				suppressTaskHeader: false,
			}
		}
		return {
			task: placeholderTaskHeader(first.ts),
			bodyStartIndex: 0,
			suppressTaskHeader: true,
		}
	}
	// api_req_started, plain text, etc. — keep them in the transcript body, never as TaskHeader.
	return {
		task: placeholderTaskHeader(first.ts),
		bodyStartIndex: 0,
		suppressTaskHeader: true,
	}
}

/**
 * Extract nested tool payload from a coordination tool say/ask message.
 */
export function parseCoordinationToolPayload(message: ClineMessage): Record<string, unknown> {
	let outer: { content?: unknown }
	try {
		outer = JSON.parse(message.text || "{}") as { content?: unknown }
	} catch {
		return {}
	}
	if (typeof outer.content === "string") {
		try {
			return asRecord(JSON.parse(outer.content))
		} catch {
			return {}
		}
	}
	return asRecord(outer.content)
}

function completionTextFromPayload(payload: Record<string, unknown>): string {
	return (
		stringField(payload, "content") ||
		stringField(payload, "body") ||
		stringField(payload, "message") ||
		stringField(payload, "summary") ||
		stringField(payload, "result") ||
		stringField(payload, "subject") ||
		""
	)
}

function rewriteToolMessageContent(message: ClineMessage, nextPayload: Record<string, unknown>): ClineMessage {
	let outer: Record<string, unknown> = {}
	try {
		outer = asRecord(JSON.parse(message.text || "{}"))
	} catch {
		outer = {}
	}
	return {
		...message,
		text: JSON.stringify({
			...outer,
			content: JSON.stringify(nextPayload),
		}),
	}
}

function findAssignIndexForCompletion(
	assigns: Array<{ index: number; taskId?: string; recipientId: string }>,
	foldedAssignIndexes: Set<number>,
	opts: { taskId?: string; senderId: string; atIndex: number },
): number {
	if (opts.taskId) {
		const byId = assigns.find((a) => a.taskId && a.taskId === opts.taskId)?.index
		if (byId !== undefined) {
			return byId
		}
	}
	for (let i = assigns.length - 1; i >= 0; i--) {
		const candidate = assigns[i]
		if (candidate.index >= opts.atIndex) {
			continue
		}
		if (!agentIdsLooselyEqual(candidate.recipientId, opts.senderId)) {
			continue
		}
		if (foldedAssignIndexes.has(candidate.index)) {
			continue
		}
		return candidate.index
	}
	return -1
}

/**
 * Fold teammate handoff / report / completion_result into the original assignment
 * slip so the UI flips to Completed — no separate "nhận báo cáo" row.
 * Must run on the full transcript (before channel filter) so teammate
 * completion_result rows can still update the coordinator's assign card.
 */
export function foldTaskCompletionsIntoAssignments(messages: ClineMessage[]): ClineMessage[] {
	const assigns: Array<{ index: number; taskId?: string; recipientId: string }> = []
	const reports: Array<{
		index: number
		taskId?: string
		senderId: string
		text: string
		hide: boolean
		/** content_end stub: status/reportText without agentId/task — match nearest prior assign */
		orphanCompleted?: boolean
	}> = []

	messages.forEach((message, index) => {
		const info = parseCoordinationToolMessage(message)
		const payload = info ? parseCoordinationToolPayload(message) : undefined
		if (info && payload) {
			const taskId = stringField(payload, "taskId")
			const status = (stringField(payload, "status") || "").toLowerCase()
			const reportText =
				stringField(payload, "reportText") || stringField(payload, "output") || completionTextFromPayload(payload)
			// Orphan completed team_run_task from content_end (lost input fields / agentId).
			if (
				info.tool === "team_run_task" &&
				(status === "completed" || Boolean(stringField(payload, "reportText"))) &&
				!info.recipientId &&
				!stringField(payload, "task") &&
				!stringField(payload, "instruction")
			) {
				reports.push({
					index,
					taskId,
					senderId: "",
					text: reportText || "",
					hide: true,
					orphanCompleted: true,
				})
				return
			}
			if (info.hasContent) {
				if (info.kind === "assign") {
					assigns.push({ index, taskId, recipientId: info.recipientId })
					return
				}
				if (info.kind === "report") {
					reports.push({
						index,
						taskId,
						senderId: info.senderId,
						text: completionTextFromPayload(payload),
						hide: true,
					})
					return
				}
			}
		}

		// Teammate COMPLETED box (attempt_completion) — fold into prior assign to same agent.
		if (
			(message.say === "completion_result" || message.ask === "completion_result") &&
			typeof message.text === "string" &&
			message.text.trim()
		) {
			const senderId = canonicalAgentId(agentIdOf(message))
			if (senderId && !isCoordinatorChannel(senderId)) {
				reports.push({
					index,
					senderId,
					text: message.text.trim(),
					hide: false, // keep COMPLETED visible on the teammate channel
				})
			}
		}
	})

	if (reports.length === 0) {
		return messages
	}

	const foldedAssignIndexes = new Set<number>()
	const hiddenReportIndexes = new Set<number>()
	const completionByAssignIndex = new Map<number, string>()

	for (const report of reports) {
		let assignIndex = -1
		if (report.orphanCompleted) {
			// Only fold when exactly one unfinished assign precedes the stub — otherwise
			// a blind "nearest prior" match can mark the wrong agent's slip Completed.
			const priorUnfinished = assigns.filter(
				(candidate) => candidate.index < report.index && !foldedAssignIndexes.has(candidate.index),
			)
			if (priorUnfinished.length === 1) {
				assignIndex = priorUnfinished[0].index
			} else if (priorUnfinished.length > 1 && report.taskId) {
				assignIndex = priorUnfinished.find((candidate) => candidate.taskId === report.taskId)?.index ?? -1
			}
		} else {
			assignIndex = findAssignIndexForCompletion(assigns, foldedAssignIndexes, {
				taskId: report.taskId,
				senderId: report.senderId,
				atIndex: report.index,
			})
		}
		if (assignIndex < 0) {
			// Always drop orphan completed stubs — they are duplicate UI with no recipient.
			if (report.orphanCompleted && report.hide) {
				hiddenReportIndexes.add(report.index)
			}
			continue
		}
		foldedAssignIndexes.add(assignIndex)
		if (report.hide) {
			hiddenReportIndexes.add(report.index)
		}
		if (!report.text) {
			// Still mark completed even when report text is empty (status-only stub).
			if (!completionByAssignIndex.has(assignIndex)) {
				completionByAssignIndex.set(assignIndex, "")
			}
			continue
		}
		const existing = completionByAssignIndex.get(assignIndex)
		completionByAssignIndex.set(assignIndex, existing ? `${existing}\n\n---\n\n${report.text}`.trim() : report.text)
	}

	if (foldedAssignIndexes.size === 0 && hiddenReportIndexes.size === 0) {
		return messages
	}

	const reportsByIndex = new Map(reports.map((report) => [report.index, report]))

	return messages.flatMap((message, index) => {
		if (hiddenReportIndexes.has(index)) {
			const report = reportsByIndex.get(index)
			// Fold still updates the Coordinator assign card. On the teammate channel,
			// keep a completion_result frame (khung hoàn thành) with the reply text —
			// same chrome as attempt_completion — while the Tin nhắn / Nhận việc slip
			// stays Assigned.
			if (report && report.text && report.senderId && !isCoordinatorChannel(report.senderId) && !report.orphanCompleted) {
				return [
					{
						ts: message.ts,
						type: "say" as const,
						say: "completion_result" as const,
						text: report.text,
						agentId: report.senderId,
					},
				]
			}
			return []
		}
		if (!completionByAssignIndex.has(index)) {
			return [message]
		}
		const completion = completionByAssignIndex.get(index) || ""
		const payload = parseCoordinationToolPayload(message)
		return [
			rewriteToolMessageContent(message, {
				...payload,
				status: "completed",
				...(completion ? { reportText: completion } : {}),
			}),
		]
	})
}

export interface FilterAgentChannelOptions {
	/**
	 * When viewing an Agent's own history transcript (dedicated SDK session),
	 * messages often lack agentId stamps — keep unattributed rows for that channel.
	 * Do NOT enable on the live shared team transcript.
	 */
	includeUnattributedForTeammate?: boolean
}

/** CEO/Coordinator rows that must never appear on Agent channels when unattributed. */
export function isLeadFacingUnattributedMessage(message: ClineMessage): boolean {
	if (message.say === "user_feedback" || message.say === "task") {
		return true
	}
	if (message.say === "api_req_started" || message.say === "api_req_finished") {
		return true
	}
	if (message.type !== "ask") {
		return false
	}
	return (
		message.ask === "followup" ||
		message.ask === "plan_mode_respond" ||
		message.ask === "resume_task" ||
		message.ask === "resume_completed_task" ||
		message.ask === "completion_result" ||
		message.ask === "command" ||
		message.ask === "tool" ||
		message.ask === "mistake_limit_reached" ||
		message.ask === "use_mcp_server" ||
		message.ask === "browser_action_launch"
	)
}

/**
 * Shared CEO/team transcripts mix Coordinator + Agent stamps (and team_run_task).
 * includeUnattributedForTeammate is only safe on dedicated Agent-only histories.
 */
export function isSharedTeamTranscript(messages: ClineMessage[]): boolean {
	let hasTeammateStamp = false
	let hasCoordinatorStamp = false
	for (const message of messages) {
		const coordination = parseCoordinationToolMessage(message)
		if (
			coordination &&
			(coordination.tool === "team_run_task" ||
				coordination.tool === "orvanta_submit_handoff" ||
				coordination.tool === "team_send_message")
		) {
			return true
		}
		const id = agentIdOf(message)
		if (!id) {
			continue
		}
		if (isCoordinatorChannel(id)) {
			hasCoordinatorStamp = true
		} else {
			hasTeammateStamp = true
		}
		if (hasTeammateStamp && hasCoordinatorStamp) {
			return true
		}
	}
	return false
}

export function filterMessagesForAgentChannel(
	messages: ClineMessage[],
	selectedAgentId?: string,
	options?: FilterAgentChannelOptions,
): ClineMessage[] {
	// Fold first on the full transcript so teammate completion_result / handoff can
	// update assignment slips before channel filtering hides those rows.
	const folded = foldTaskCompletionsIntoAssignments(messages)

	if (!selectedAgentId || selectedAgentId === "team-feed") {
		return folded
	}

	const coordinatorChannel = isCoordinatorChannel(selectedAgentId)
	const allowUnattributedForTeammate = Boolean(options?.includeUnattributedForTeammate) && !isSharedTeamTranscript(folded)

	const filtered = folded.filter((message) => {
		const coordination = parseCoordinationToolMessage(message)
		if (coordination) {
			return coordinationToolInvolvesAgent(coordination, selectedAgentId)
		}
		if (coordinatorChannel) {
			// Keep teammate activity in its own channel. The Coordinator transcript
			// shows the lead's messages; coordination cards are handled above.
			// Tool/followup asks are scoped by agentId so Approve/Reject only appear
			// on the Agent that owns the pending request (legacy asks without agentId
			// still surface on Coordinator).
			const messageAgentId = agentIdOf(message)
			if (message.type === "ask") {
				return !messageAgentId || agentIdsEqual(messageAgentId, selectedAgentId)
			}
			return !messageAgentId || agentIdsEqual(messageAgentId, selectedAgentId) || message.say === "task"
		}
		const messageAgentId = agentIdOf(message)
		if (!messageAgentId) {
			// Lead/CEO chatter on a shared transcript often lacks agentId. Never paint it
			// onto Agent channels — even with includeUnattributedForTeammate (that flag is
			// for dedicated Agent-only histories that forgot to stamp rows).
			if (isLeadFacingUnattributedMessage(message)) {
				return false
			}
			return allowUnattributedForTeammate
		}
		// Coordinator-owned rows must stay on Coordinator (followup already covered;
		// also text / completion inferred onto the lead).
		if (isCoordinatorChannel(messageAgentId) && !agentIdsLooselyEqual(messageAgentId, selectedAgentId)) {
			return false
		}
		return agentIdsLooselyEqual(messageAgentId, selectedAgentId)
	})

	// Do not prepend the CEO say:"task" onto Agent channels — that brief belongs to
	// Coordinator; Agents already see their assign slip as the entry point.
	return filtered
}
