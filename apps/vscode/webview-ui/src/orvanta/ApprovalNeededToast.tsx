import type { ClineMessage } from "@shared/ExtensionMessage"
import type { OrvantaRosterAgent } from "@shared/proto/cline/orvanta"
import { IconAlertTriangle, IconX } from "@tabler/icons-react"
import { useMemo, useState } from "react"
import { canonicalAgentId } from "@/components/chat/chat-view/utils/filterAgentChannelMessages"
import { useExtensionState } from "@/context/ExtensionStateContext"

export type PendingAgentApproval = {
	agentId: string
	anchorTs: number
	phase: "awaiting_approval" | "awaiting_followup"
	summary: string
}

function askSummary(message: ClineMessage | undefined): string {
	if (!message || message.type !== "ask") return "cần phản hồi"
	switch (message.ask) {
		case "command":
			return "cần duyệt lệnh"
		case "use_mcp_server":
			return "cần duyệt MCP"
		case "use_subagents":
			return "cần duyệt spawn agent"
		case "followup":
			return "đang hỏi bạn"
		case "tool":
		default:
			return "cần duyệt công cụ"
	}
}

export function resolvePendingAgentApproval(
	turnState: { phase?: string; anchorTs?: number } | undefined,
	messages: ClineMessage[],
): PendingAgentApproval | null {
	if (!turnState || (turnState.phase !== "awaiting_approval" && turnState.phase !== "awaiting_followup")) {
		return null
	}
	if (turnState.anchorTs === undefined) return null
	const anchored = messages.find((m) => m.ts === turnState.anchorTs)
	const rawAgentId = anchored?.agentId ?? anchored?.agent_id
	const agentId = canonicalAgentId(rawAgentId) || "coordinator"
	return {
		agentId,
		anchorTs: turnState.anchorTs,
		phase: turnState.phase,
		summary: askSummary(anchored),
	}
}

function isViewingApprovalOwner(focusAgentId: string, approvalAgentId: string): boolean {
	const focus = canonicalAgentId(focusAgentId === "team-feed" ? "" : focusAgentId)
	if (!focus) return false
	return focus === approvalAgentId
}

export interface ApprovalNeededToastProps {
	focusAgentId: string
	agents: OrvantaRosterAgent[]
	onSelectAgent: (agentId: string) => void
}

/**
 * Toast when an Agent (other than the one currently focused) is waiting for
 * Approve/Reject or a follow-up answer. Click navigates to that Agent channel
 * where the matching action buttons are shown.
 */
export function ApprovalNeededToast({ focusAgentId, agents, onSelectAgent }: ApprovalNeededToastProps) {
	const { turnState, clineMessages } = useExtensionState()
	const pending = useMemo(() => resolvePendingAgentApproval(turnState, clineMessages ?? []), [turnState, clineMessages])
	const [dismissedAnchorTs, setDismissedAnchorTs] = useState<number | null>(null)

	if (!pending || isViewingApprovalOwner(focusAgentId, pending.agentId) || dismissedAnchorTs === pending.anchorTs) {
		return null
	}

	const agent = agents.find((a) => canonicalAgentId(a.id) === pending.agentId)
	const label = agent?.displayName || pending.agentId

	return (
		<div
			className="pointer-events-auto absolute bottom-3 right-3 z-50 flex max-w-[min(360px,calc(100%-1.5rem))] items-start gap-2 rounded-md border border-amber-500/40 bg-(--vscode-editor-background) px-3 py-2.5 shadow-lg"
			data-testid="approval-needed-toast"
			role="status">
			<button
				className="flex min-w-0 flex-1 items-start gap-2 text-left hover:opacity-90"
				onClick={() => onSelectAgent(pending.agentId)}
				type="button">
				<span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-amber-500/15 text-amber-300">
					<IconAlertTriangle size={14} stroke={1.75} />
				</span>
				<span className="flex min-w-0 flex-col gap-0.5">
					<span className="truncate text-xs font-semibold text-foreground">
						{label} {pending.summary}
					</span>
					<span className="text-[11px] text-muted-foreground">Bấm để mở Agent và duyệt</span>
				</span>
			</button>
			<button
				aria-label="Đóng"
				className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-surface-secondary hover:text-foreground"
				onClick={() => setDismissedAnchorTs(pending.anchorTs)}
				type="button">
				<IconX size={14} stroke={1.5} />
			</button>
		</div>
	)
}

export default ApprovalNeededToast
