import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import {
	filterMessagesForAgentChannel,
	foldTaskCompletionsIntoAssignments,
	getCoordinationCardKind,
	isNonVisualToolMessage,
	parseCoordinationToolMessage,
	parseCoordinationToolPayload,
	resolveAgentChannelTaskHeader,
} from "./filterAgentChannelMessages"

function toolMessage(params: { ts: number; tool: string; payload: Record<string, unknown>; agentId?: string }): ClineMessage {
	return {
		ts: params.ts,
		type: "say",
		say: "tool",
		agentId: params.agentId,
		text: JSON.stringify({
			tool: params.tool,
			content: JSON.stringify(params.payload),
		}),
	}
}

const task: ClineMessage = { ts: 1, type: "say", say: "task", text: "CEO request" }
const coordinatorText: ClineMessage = {
	ts: 2,
	type: "say",
	say: "text",
	agentId: "coordinator",
	text: "I'll assign this",
}
const assignment = toolMessage({
	ts: 3,
	tool: "team_run_task",
	agentId: "coordinator",
	payload: { agentId: "coder", task: "Write login", taskId: "t-1" },
})
const coderText: ClineMessage = {
	ts: 4,
	type: "say",
	say: "text",
	agentId: "coder",
	text: "Working on login",
}
const handoff = toolMessage({
	ts: 5,
	tool: "orvanta_submit_handoff",
	agentId: "coder",
	payload: { taskId: "t-1", content: "Login done", summary: "Báo cáo hoàn tất" },
})
const sendToReviewer = toolMessage({
	ts: 6,
	tool: "team_send_message",
	agentId: "coder",
	payload: { toAgentId: "reviewer", message: "Please review login.ts" },
})
const reviewerText: ClineMessage = {
	ts: 7,
	type: "say",
	say: "text",
	agentId: "reviewer",
	text: "Reviewing",
}

const transcript = [task, coordinatorText, assignment, coderText, handoff, sendToReviewer, reviewerText]

describe("parseCoordinationToolMessage", () => {
	it("reads nested JSON content for team_run_task", () => {
		expect(parseCoordinationToolMessage(assignment)).toEqual({
			tool: "team_run_task",
			senderId: "coordinator",
			recipientId: "coder",
			kind: "assign",
			hasContent: true,
		})
	})

	it("defaults handoff recipient to coordinator", () => {
		expect(parseCoordinationToolMessage(handoff)).toEqual({
			tool: "orvanta_submit_handoff",
			senderId: "coder",
			recipientId: "coordinator",
			kind: "report",
			hasContent: true,
		})
	})
})

describe("getCoordinationCardKind", () => {
	it("keeps team_run_task as assignment even when the prompt mentions báo cáo", () => {
		expect(getCoordinationCardKind("team_run_task", "coordinator", "coder")).toBe("assign")
	})

	it("treats teammate send-message as a report, never a chat message", () => {
		expect(getCoordinationCardKind("team_send_message", "reviewer", "coordinator")).toBe("report")
		expect(getCoordinationCardKind("team_send_message", "coder", "reviewer")).toBe("report")
	})
})

describe("filterMessagesForAgentChannel", () => {
	it("shows assignment cards on both Coordinator and the assigned agent", () => {
		const coordinatorView = filterMessagesForAgentChannel(transcript, "coordinator")
		const coderView = filterMessagesForAgentChannel(transcript, "coder")
		const reviewerView = filterMessagesForAgentChannel(transcript, "reviewer")

		expect(coordinatorView.some((m) => m.ts === assignment.ts)).toBe(true)
		expect(coderView.some((m) => m.ts === assignment.ts)).toBe(true)
		expect(reviewerView.some((m) => m.ts === assignment.ts)).toBe(false)
	})

	it("folds handoff reports into the assignment slip instead of a separate report card", () => {
		const coordinatorView = filterMessagesForAgentChannel(transcript, "coordinator")
		const coderView = filterMessagesForAgentChannel(transcript, "coder")
		const reviewerView = filterMessagesForAgentChannel(transcript, "reviewer")

		// Coordinator keeps the folded assign card only — no duplicate report tool row.
		expect(coordinatorView.some((m) => m.ts === handoff.ts)).toBe(false)
		expect(reviewerView.some((m) => m.ts === handoff.ts)).toBe(false)

		// Teammate channel keeps a completion frame with the reply (task card stays Assigned).
		const coderReply = coderView.find((m) => m.ts === handoff.ts)
		expect(coderReply).toMatchObject({
			say: "completion_result",
			agentId: "coder",
			text: "Login done",
		})
		expect(coderView.some((m) => m.ts === handoff.ts && m.say === "tool")).toBe(false)

		const completedAssign = coordinatorView.find((m) => m.ts === assignment.ts)
		expect(completedAssign).toBeTruthy()
		expect(parseCoordinationToolPayload(completedAssign!)).toMatchObject({
			status: "completed",
			reportText: "Login done",
			taskId: "t-1",
		})
		expect(parseCoordinationToolPayload(coderView.find((m) => m.ts === assignment.ts)!)).toMatchObject({
			status: "completed",
			reportText: "Login done",
		})
	})

	it("shows send-message cards on the sender and the recipient", () => {
		const coordinatorView = filterMessagesForAgentChannel(transcript, "coordinator")
		const coderView = filterMessagesForAgentChannel(transcript, "coder")
		const reviewerView = filterMessagesForAgentChannel(transcript, "reviewer")

		expect(coderView).toContain(sendToReviewer)
		expect(reviewerView).toContain(sendToReviewer)
		expect(coordinatorView).not.toContain(sendToReviewer)
	})

	it("folds teammate send-message completions into matching assigns; orphan reports stay visible", () => {
		const reviewAssign = toolMessage({
			ts: 8,
			tool: "team_run_task",
			agentId: "coordinator",
			payload: { agentId: "reviewer", task: "Review login", taskId: "task_0002" },
		})
		const reviewerReport = toolMessage({
			ts: 9,
			tool: "team_send_message",
			agentId: "reviewer",
			payload: { toAgentId: "coordinator", subject: "PASS", body: "[REVIEW REPORT] PASS", taskId: "task_0002" },
		})
		const coderMailboxReport = toolMessage({
			ts: 11,
			tool: "team_send_message",
			agentId: "coder",
			payload: {
				toAgentId: "1793273682195_h9itp",
				subject: "Handoff task_0001",
				body: "Bàn giao hello.txt",
				taskId: "task_0001",
			},
		})
		const messages = [assignment, handoff, reviewAssign, reviewerReport, coderMailboxReport]
		const coordinatorView = filterMessagesForAgentChannel(messages, "coordinator")
		const reviewerView = filterMessagesForAgentChannel(messages, "reviewer")
		expect(coordinatorView.some((m) => m.ts === handoff.ts)).toBe(false)
		expect(coordinatorView.some((m) => m.ts === reviewerReport.ts)).toBe(false)
		expect(parseCoordinationToolPayload(coordinatorView.find((m) => m.ts === assignment.ts)!)).toMatchObject({
			status: "completed",
			reportText: "Login done",
		})
		expect(parseCoordinationToolPayload(coordinatorView.find((m) => m.ts === reviewAssign.ts)!)).toMatchObject({
			status: "completed",
			reportText: "[REVIEW REPORT] PASS",
			taskId: "task_0002",
		})
		// Reviewer still sees their reply in a completion frame on their channel.
		expect(reviewerView.find((m) => m.ts === reviewerReport.ts)).toMatchObject({
			say: "completion_result",
			agentId: "reviewer",
			text: "[REVIEW REPORT] PASS",
		})
		// No matching assign for task_0001 → orphan completion card remains (rebranded in UI)
		expect(coordinatorView.some((m) => m.ts === coderMailboxReport.ts)).toBe(true)
		expect(parseCoordinationToolMessage(coderMailboxReport)).toMatchObject({
			recipientId: "coordinator",
			kind: "report",
		})
	})

	it("foldTaskCompletionsIntoAssignments merges by taskId", () => {
		const folded = foldTaskCompletionsIntoAssignments([assignment, handoff])
		expect(folded).toHaveLength(2)
		expect(parseCoordinationToolPayload(folded[0])).toMatchObject({
			status: "completed",
			reportText: "Login done",
			taskId: "t-1",
		})
		expect(folded[1]).toMatchObject({
			ts: handoff.ts,
			say: "completion_result",
			agentId: "coder",
			text: "Login done",
		})
	})

	it("keeps unattributed teammate history rows when includeUnattributedForTeammate is set", () => {
		const orphan: ClineMessage = { ts: 40, type: "say", say: "text", text: "Reviewer notes" }
		expect(filterMessagesForAgentChannel([orphan], "reviewer")).toEqual([])
		expect(filterMessagesForAgentChannel([orphan], "reviewer", { includeUnattributedForTeammate: true })).toEqual([orphan])
	})

	it("keeps Coordinator followup asks off Agent channels even in shared history browse", () => {
		const followup: ClineMessage = {
			ts: 41,
			type: "ask",
			ask: "followup",
			text: JSON.stringify({
				question: "Bạn muốn đoạn Python đơn giản làm gì?",
				options: ["In Hello, World!", "Máy tính"],
			}),
		}
		const coordinatorFollowup: ClineMessage = { ...followup, ts: 42, agentId: "coordinator" }
		expect(filterMessagesForAgentChannel([followup], "reviewer", { includeUnattributedForTeammate: true })).toEqual([])
		expect(
			filterMessagesForAgentChannel([coordinatorFollowup], "reviewer", { includeUnattributedForTeammate: true }),
		).toEqual([])
		expect(filterMessagesForAgentChannel([followup, coordinatorFollowup], "coordinator")).toEqual([
			followup,
			coordinatorFollowup,
		])
	})

	it("keeps CEO user_feedback and unattributed completion asks off Agent channels in history browse", () => {
		const feedback: ClineMessage = { ts: 43, type: "say", say: "user_feedback", text: 'In "Hello, World!"' }
		const completionAsk: ClineMessage = { ts: 44, type: "ask", ask: "completion_result", text: "" }
		const leadText: ClineMessage = {
			ts: 45,
			type: "say",
			say: "text",
			agentId: "coordinator",
			text: "I'll assign the reviewer",
		}
		const reviewerTool: ClineMessage = {
			ts: 46,
			type: "say",
			say: "tool",
			agentId: "reviewer",
			text: JSON.stringify({ tool: "readFile", path: "hello.py" }),
		}
		const reviewerView = filterMessagesForAgentChannel([feedback, completionAsk, leadText, reviewerTool], "reviewer", {
			includeUnattributedForTeammate: true,
		})
		expect(reviewerView).toEqual([reviewerTool])
		expect(filterMessagesForAgentChannel([feedback, completionAsk, leadText], "coordinator").map((m) => m.ts)).toEqual([
			43, 44, 45,
		])
	})

	it("folds teammate completion_result into the assign card before channel filter", () => {
		const completion: ClineMessage = {
			ts: 50,
			type: "say",
			say: "completion_result",
			agentId: "coder",
			text: "Wrote login.ts — COMPLETED",
		}
		const coordinatorView = filterMessagesForAgentChannel([assignment, completion], "coordinator")
		expect(coordinatorView.some((m) => m.ts === completion.ts)).toBe(false)
		expect(parseCoordinationToolPayload(coordinatorView.find((m) => m.ts === assignment.ts)!)).toMatchObject({
			status: "completed",
			reportText: "Wrote login.ts — COMPLETED",
		})
	})

	it("folds orphan completed team_run_task stubs into the prior assign card", () => {
		const orphanCompleted = toolMessage({
			ts: 51,
			tool: "team_run_task",
			agentId: "coordinator",
			payload: {
				status: "completed",
				reportText: "File ready at artifacts/hello.py",
				output: "File ready at artifacts/hello.py",
			},
		})
		const view = filterMessagesForAgentChannel([assignment, orphanCompleted], "coordinator")
		expect(view.some((m) => m.ts === orphanCompleted.ts)).toBe(false)
		expect(parseCoordinationToolPayload(view.find((m) => m.ts === assignment.ts)!)).toMatchObject({
			status: "completed",
			reportText: "File ready at artifacts/hello.py",
		})
	})

	it("still hides orphan completed stubs after completion_result already folded the assign", () => {
		const completion: ClineMessage = {
			ts: 50,
			type: "say",
			say: "completion_result",
			agentId: "coder",
			text: "Wrote login.ts",
		}
		const orphanCompleted = toolMessage({
			ts: 51,
			tool: "team_run_task",
			agentId: "coordinator",
			payload: { status: "completed", reportText: "sync output", output: "sync output" },
		})
		const view = filterMessagesForAgentChannel([assignment, completion, orphanCompleted], "coordinator")
		expect(view.some((m) => m.ts === orphanCompleted.ts)).toBe(false)
		expect(parseCoordinationToolPayload(view.find((m) => m.ts === assignment.ts)!).status).toBe("completed")
	})

	it("does not fold an orphan completed stub onto the wrong assign when multiple assigns precede it", () => {
		const reviewAssign = toolMessage({
			ts: 8,
			tool: "team_run_task",
			agentId: "coordinator",
			payload: { agentId: "reviewer", task: "Review login", taskId: "task_0002" },
		})
		const orphanCompleted = toolMessage({
			ts: 51,
			tool: "team_run_task",
			agentId: "coordinator",
			payload: { status: "completed", reportText: "ambiguous sync output", output: "ambiguous sync output" },
		})
		const view = filterMessagesForAgentChannel([assignment, reviewAssign, orphanCompleted], "coordinator")
		expect(view.some((m) => m.ts === orphanCompleted.ts)).toBe(false)
		expect(parseCoordinationToolPayload(view.find((m) => m.ts === assignment.ts)!).status).toBeUndefined()
		expect(parseCoordinationToolPayload(view.find((m) => m.ts === reviewAssign.ts)!).status).toBeUndefined()
	})

	it("does not keep unattributed rows on Agent channels for shared team transcripts", () => {
		const orphanText: ClineMessage = { ts: 40, type: "say", say: "text", text: "Should stay off Reviewer" }
		const view = filterMessagesForAgentChannel([assignment, orphanText], "reviewer", {
			includeUnattributedForTeammate: true,
		})
		expect(view.some((m) => m.ts === orphanText.ts)).toBe(false)
		expect(view.some((m) => m.ts === task.ts)).toBe(false)
	})

	it("does not prepend the CEO task brief onto Agent channels", () => {
		const reviewerView = filterMessagesForAgentChannel([task, assignment, reviewerText], "reviewer")
		expect(reviewerView.some((m) => m.say === "task")).toBe(false)
		expect(reviewerView).toContain(reviewerText)
	})

	it("suppresses TaskHeader when the Agent channel already has a message/task card", () => {
		const send = toolMessage({
			ts: 20,
			tool: "team_send_message",
			agentId: "coordinator",
			payload: {
				toAgentId: "dev-6551ae1053d2-1",
				subject: "Kiểm tra tình trạng hoạt động",
				body: "Bạn có đang hoạt động bình thường không?",
			},
		})
		const agentView = filterMessagesForAgentChannel([task, send], "dev-6551ae1053d2-1")
		const { task: header, bodyStartIndex, suppressTaskHeader } = resolveAgentChannelTaskHeader(agentView)
		expect(header?.say).toBe("task")
		expect(header?.text).toBe("")
		expect(suppressTaskHeader).toBe(true)
		expect(bodyStartIndex).toBe(0)
		expect(agentView[bodyStartIndex]?.ts).toBe(send.ts)
	})

	it("keeps a real say:task as the TaskHeader and slices it from the body", () => {
		const { task: header, bodyStartIndex } = resolveAgentChannelTaskHeader([task, assignment])
		expect(header).toBe(task)
		expect(bodyStartIndex).toBe(1)
	})

	it("does not promote api_req_started stubs like {} into the TaskHeader bubble", () => {
		const apiStub: ClineMessage = {
			ts: 1,
			type: "say",
			say: "api_req_started",
			text: "{}",
			partial: false,
		}
		const send = toolMessage({
			ts: 2,
			tool: "team_send_message",
			agentId: "coordinator",
			payload: {
				toAgentId: "dev",
				subject: "Re: Chỉ đạo từ CEO tới Dev",
				body: "hello",
				status: "completed",
				reportText: "Hello! Mình đã nhận được tin nhắn.",
			},
		})
		const { task: header, bodyStartIndex, suppressTaskHeader } = resolveAgentChannelTaskHeader([apiStub, send])
		expect(suppressTaskHeader).toBe(true)
		expect(header?.text).toBe("")
		expect(bodyStartIndex).toBe(0)
	})

	it("does not promote junk user_feedback JSON into the TaskHeader bubble", () => {
		const junk: ClineMessage = {
			ts: 1,
			type: "say",
			say: "user_feedback",
			text: "{}",
			partial: false,
		}
		const { suppressTaskHeader, headerText } = (() => {
			const resolved = resolveAgentChannelTaskHeader([junk])
			return { suppressTaskHeader: resolved.suppressTaskHeader, headerText: resolved.task?.text }
		})()
		expect(suppressTaskHeader).toBe(true)
		expect(headerText).toBe("")
	})

	it("hides internal team tools that have no card UI", () => {
		const awaitRuns = toolMessage({
			ts: 10,
			tool: "team_await_runs",
			agentId: "coordinator",
			payload: { runId: "run-1" },
		})
		expect(isNonVisualToolMessage(awaitRuns)).toBe(true)
	})

	it("keeps teammate work out of Coordinator and isolated in each agent channel", () => {
		const coordinatorView = filterMessagesForAgentChannel(transcript, "coordinator")
		const coderView = filterMessagesForAgentChannel(transcript, "coder")
		const reviewerView = filterMessagesForAgentChannel(transcript, "reviewer")

		expect(coordinatorView).not.toContain(coderText)
		expect(coordinatorView).not.toContain(reviewerText)
		expect(coordinatorView).toContain(coordinatorText)
		expect(coderView).toContain(coderText)
		expect(coderView).not.toContain(reviewerText)
		expect(reviewerView).toContain(reviewerText)
		expect(reviewerView).not.toContain(coderText)
	})

	it("keeps un-attributed system/task messages visible in Coordinator", () => {
		const unassigned: ClineMessage = { ts: 8, type: "say", say: "text", text: "System notice" }
		const coordinatorView = filterMessagesForAgentChannel([task, coordinatorText, coderText, unassigned], "coordinator")

		expect(coordinatorView).toContain(task)
		expect(coordinatorView).toContain(coordinatorText)
		expect(coordinatorView).toContain(unassigned)
		expect(coordinatorView).not.toContain(coderText)
	})

	it("still shows a mis-attributed assignment on Coordinator", () => {
		const misattributed = toolMessage({
			ts: 8,
			tool: "team_run_task",
			agentId: "coder",
			payload: { agentId: "coder", task: "Write login" },
		})
		expect(filterMessagesForAgentChannel([misattributed], "coordinator")).toEqual([misattributed])
		expect(filterMessagesForAgentChannel([misattributed], "coder")).toEqual([misattributed])
		expect(filterMessagesForAgentChannel([misattributed], "reviewer")).toEqual([])
	})

	it("scopes tool-approval asks to the owning Agent channel", () => {
		const coderAsk: ClineMessage = {
			ts: 20,
			type: "ask",
			ask: "tool",
			agentId: "coder",
			text: JSON.stringify({ tool: "editedExistingFile", path: "hello.py" }),
		}
		const legacyAsk: ClineMessage = {
			ts: 21,
			type: "ask",
			ask: "tool",
			text: JSON.stringify({ tool: "editedExistingFile", path: "legacy.py" }),
		}

		expect(filterMessagesForAgentChannel([coderAsk], "coder")).toEqual([coderAsk])
		expect(filterMessagesForAgentChannel([coderAsk], "coordinator")).toEqual([])
		expect(filterMessagesForAgentChannel([coderAsk], "reviewer")).toEqual([])
		expect(filterMessagesForAgentChannel([legacyAsk], "coordinator")).toEqual([legacyAsk])
		expect(filterMessagesForAgentChannel([legacyAsk], "coder")).toEqual([])
	})
})
