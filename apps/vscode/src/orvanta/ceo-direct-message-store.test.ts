import { beforeEach, describe, expect, it } from "bun:test"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { clearCeoDirectMessages, mergeCeoDirectMessagesIntoTranscript, recordCeoDirectMessage } from "./ceo-direct-message-store"

describe("ceo-direct-message-store", () => {
	beforeEach(() => {
		clearCeoDirectMessages()
	})

	it("re-injects wiped CEO bubbles for the active task and sorts them before agent tool rows", () => {
		recordCeoDirectMessage({
			ts: 100,
			agentId: "reviewer",
			text: "hello",
			displayName: "Reviewer",
			taskId: "task-1",
		})

		const tool: ClineMessage = {
			ts: 200,
			type: "say",
			say: "tool",
			text: JSON.stringify({ tool: "team_send_message", content: "{}" }),
			agentId: "reviewer",
		}

		const merged = mergeCeoDirectMessagesIntoTranscript([tool], "task-1")
		expect(merged.map((m) => m.say)).toEqual(["user_feedback", "tool"])
		expect(merged[0]?.text).toBe("hello")
		expect(merged[0]?.agentId).toBe("reviewer")
	})

	it("does not reinject prior-session steers when there is no active task", () => {
		recordCeoDirectMessage({
			ts: 100,
			agentId: "reviewer",
			text: "hello",
			taskId: "task-old",
		})
		expect(mergeCeoDirectMessagesIntoTranscript([], undefined)).toEqual([])
		expect(mergeCeoDirectMessagesIntoTranscript([], null)).toEqual([])
	})

	it("does not leak steers from another task id into the active transcript", () => {
		recordCeoDirectMessage({
			ts: 100,
			agentId: "reviewer",
			text: "hello",
			taskId: "task-old",
		})
		const merged = mergeCeoDirectMessagesIntoTranscript([], "task-new")
		expect(merged).toEqual([])
	})

	it("does not duplicate a CEO bubble already present in the transcript", () => {
		recordCeoDirectMessage({
			ts: 100,
			agentId: "reviewer",
			text: "hello",
			taskId: "task-1",
		})
		const existing: ClineMessage = {
			ts: 102,
			type: "say",
			say: "user_feedback",
			text: "hello",
			agentId: "reviewer",
		}
		const merged = mergeCeoDirectMessagesIntoTranscript([existing], "task-1")
		expect(merged).toHaveLength(1)
	})

	it("remaps legacy wall-clock CEO ts so bubbles sort before agent minter rows", () => {
		recordCeoDirectMessage({
			ts: Date.now(),
			agentId: "reviewer",
			text: "hello",
			taskId: "task-1",
		})
		const completion: ClineMessage = {
			ts: 50,
			type: "say",
			say: "completion_result",
			text: "Chào CEO!",
			agentId: "reviewer",
		}
		const merged = mergeCeoDirectMessagesIntoTranscript([completion], "task-1")
		expect(merged.map((m) => m.say)).toEqual(["user_feedback", "completion_result"])
		expect(merged[0]?.ts).toBe(49)
		expect(merged[0]?.text).toBe("hello")
	})

	it("rewrites in-transcript wall-clock CEO bubbles ahead of the agent reply", () => {
		const merged = mergeCeoDirectMessagesIntoTranscript(
			[
				{
					ts: 50,
					type: "say",
					say: "completion_result",
					text: "Chào CEO!",
					agentId: "reviewer",
				},
				{
					ts: Date.now(),
					type: "say",
					say: "user_feedback",
					text: "hello",
					agentId: "reviewer",
				},
			],
			"task-1",
		)
		expect(merged.map((m) => m.say)).toEqual(["user_feedback", "completion_result"])
		expect(merged[0]?.text).toBe("hello")
		expect(merged[0]?.ts).toBe(49)
	})
})
