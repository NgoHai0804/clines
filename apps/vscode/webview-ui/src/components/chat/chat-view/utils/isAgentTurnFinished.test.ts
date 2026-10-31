import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { isAgentTurnFinished } from "./isAgentTurnFinished"

describe("isAgentTurnFinished", () => {
	it("is false when there is no completion", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "Do it" },
			{ ts: 2, type: "say", say: "text", text: "Working" },
		]
		expect(isAgentTurnFinished(messages)).toBe(false)
	})

	it("is true after a completion_result with no later user turn", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "Review file" },
			{ ts: 2, type: "say", say: "completion_result", text: "Looks good" },
			{ ts: 3, type: "ask", ask: "resume_task", text: "" },
		]
		expect(isAgentTurnFinished(messages)).toBe(true)
	})

	it("is false when the user continues after completion", () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "completion_result", text: "Done" },
			{ ts: 2, type: "say", say: "user_feedback", text: "Also fix tests" },
		]
		expect(isAgentTurnFinished(messages)).toBe(false)
	})
})
