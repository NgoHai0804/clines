import type { ClineMessage, TurnState } from "@shared/ExtensionMessage"
import type { PendingResponse, PendingUserMessage } from "../types/chatTypes"

/** The rows the backend writes for text the user submitted. */
function isUserAuthored(message: ClineMessage): boolean {
	return message.type === "say" && (message.say === "task" || message.say === "user_feedback")
}

/**
 * A submission is confirmed by the user-authored row the backend writes for it. The row's
 * kind depends on how the backend handled the submission, not on where it was typed: a prompt
 * sent from a task that failed before it had a session starts a new task, so the optimistic
 * `user_feedback` bubble is confirmed by a `task` row.
 */
function sameOptimisticMessage(left: ClineMessage, right: ClineMessage): boolean {
	const leftImages = left.images ?? []
	const rightImages = right.images ?? []
	const leftFiles = left.files ?? []
	const rightFiles = right.files ?? []
	const leftAgent = left.agentId ?? (left as { agent_id?: string }).agent_id
	const rightAgent = right.agentId ?? (right as { agent_id?: string }).agent_id
	// When either side is stamped for an Agent channel, require the same agent id so a
	// Coordinator "hello" cannot confirm a CEO 1:1 bubble aimed at Reviewer/Dev.
	if (leftAgent || rightAgent) {
		if ((leftAgent || "") !== (rightAgent || "")) {
			return false
		}
	}

	return (
		isUserAuthored(left) &&
		isUserAuthored(right) &&
		left.text === right.text &&
		leftImages.length === rightImages.length &&
		leftImages.every((image, index) => image === rightImages[index]) &&
		leftFiles.length === rightFiles.length &&
		leftFiles.every((file, index) => file === rightFiles[index])
	)
}

export function hasPendingMessageConfirmation(messages: ClineMessage[], pending: PendingUserMessage): boolean {
	return messages.some((message) => message.ts > pending.afterTs && sameOptimisticMessage(message, pending.message))
}

export function withPendingUserMessage(messages: ClineMessage[], pending: PendingUserMessage | undefined): ClineMessage[] {
	if (!pending || hasPendingMessageConfirmation(messages, pending)) {
		return messages
	}
	// Insert after `afterTs` so CEO 1:1 bubbles stay before agent replies that
	// arrive while the optimistic row is still pending (never blindly append).
	const insertAt = messages.findIndex((message) => message.ts > pending.afterTs)
	if (insertAt < 0) {
		return [...messages, pending.message]
	}
	return [...messages.slice(0, insertAt), pending.message, ...messages.slice(insertAt)]
}

/**
 * Keep the optimistic loader only until the backend acknowledges this submission.
 * TurnState sequence is authoritative when available; message growth is the legacy fallback.
 */
export function isPendingResponseUnconfirmed(
	pendingResponse: PendingResponse | undefined,
	turnState: TurnState | undefined,
	messageCount: number,
): boolean {
	if (!pendingResponse) {
		return false
	}
	if (turnState) {
		return pendingResponse.turnStateSeq !== undefined && turnState.seq <= pendingResponse.turnStateSeq
	}
	return messageCount <= pendingResponse.messageCount
}
