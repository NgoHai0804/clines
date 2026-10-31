import type { ClineMessage } from "@shared/ExtensionMessage"

/**
 * True when the agent already produced a terminal completion (green COMPLETED)
 * and the user has not started a new turn after it.
 *
 * Used to prevent Orvanta auto-resume from re-running a finished agent.
 */
export function isAgentTurnFinished(messages: ClineMessage[]): boolean {
	let lastCompletionIdx = -1
	let lastUserTurnIdx = -1

	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]
		if (
			message.say === "completion_result" ||
			message.say === "plan_completion_result" ||
			message.ask === "completion_result"
		) {
			lastCompletionIdx = i
			continue
		}
		if (message.say === "user_feedback" || message.say === "task") {
			lastUserTurnIdx = i
		}
	}

	if (lastCompletionIdx < 0) {
		return false
	}
	return lastUserTurnIdx < lastCompletionIdx
}
