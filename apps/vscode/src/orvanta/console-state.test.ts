import { EmptyRequest } from "@shared/proto/cline/common"
import { OrvantaConsoleStateSnapshot, OrvantaSendAgentDirectMessageRequest } from "@shared/proto/cline/orvanta"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Controller } from "@/core/controller"
import { sendAgentDirectMessage } from "@/core/controller/orvanta/sendAgentDirectMessage"
import { subscribeConsoleState } from "@/core/controller/orvanta/subscribeConsoleState"
import { globalWarRoomTracker } from "./war-room-tracker"

describe("Console State & Direct Steering Handlers (Orvanta v0.0.4)", () => {
	beforeEach(() => {
		globalWarRoomTracker.reset()
	})

	it("subscribeConsoleState streams snapshot with #team-feed and roster channels", async () => {
		globalWarRoomTracker.syncRoster([
			{ id: "coordinator", displayName: "Coordinator", role: "lead", status: "idle" },
			{ id: "implementer", displayName: "Dave", role: "implementer", status: "idle" },
		])

		const snapshots: OrvantaConsoleStateSnapshot[] = []
		const responseStream = async (snapshot: OrvantaConsoleStateSnapshot) => {
			snapshots.push(snapshot)
		}

		const mockController = {} as unknown as Controller
		await subscribeConsoleState(mockController, EmptyRequest.create(), responseStream)

		expect(snapshots.length).toBeGreaterThan(0)
		const latest = snapshots[snapshots.length - 1]
		expect(latest.activeChannelId).toBe("team-feed")
		expect(latest.channels.length).toBe(3) // #team-feed + coordinator + implementer

		const teamFeed = latest.channels[0]
		expect(teamFeed.id).toBe("team-feed")
		expect(teamFeed.isChannel).toBe(true)

		const dave = latest.channels.find((c) => c.id === "implementer")
		expect(dave).toBeDefined()
		expect(dave?.name).toBe("Dave")
		expect(dave?.role).toBe("implementer")
	})

	it("sendAgentDirectMessage steers coordinator via controller.task.handleWebviewAskResponse", async () => {
		const handleAskResponse = vi.fn(async () => {})
		const mockController = {
			task: {
				handleWebviewAskResponse: handleAskResponse,
			},
		} as unknown as Controller

		const req = OrvantaSendAgentDirectMessageRequest.create({
			agentId: "coordinator",
			message: "Focus on task 3 first",
		})

		const response = await sendAgentDirectMessage(mockController, req)
		expect(response.success).toBe(true)
		expect(handleAskResponse).toHaveBeenCalledWith("messageResponse", "Focus on task 3 first")
	})

	it("sendAgentDirectMessage fails without an active team runtime", async () => {
		const previous = (globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime
		delete (globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime

		const mockController = {} as unknown as Controller
		const req = OrvantaSendAgentDirectMessageRequest.create({
			agentId: "implementer",
			subject: "Urgent fix",
			message: "Please write unit tests before submitting handoff",
		})

		const response = await sendAgentDirectMessage(mockController, req)
		expect(response.success).toBe(false)
		expect(response.error).toMatch(/phiên team/i)

		;(globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime = previous
	})

	it("sendAgentDirectMessage steers teammate and records into war-room transcript", async () => {
		globalWarRoomTracker.syncRoster([{ id: "implementer", displayName: "Dave", role: "implementer", status: "idle" }])
		const previous = (globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime
		const sendMessage = vi.fn()
		const addMessages = vi.fn()
		;(globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime = {
			getLeadAgentId: () => "session-lead-1",
			getMemberIds: () => ["session-lead-1", "implementer"],
			getMemberRole: (id: string) => (id === "session-lead-1" ? "lead" : "teammate"),
			resolveMemberId: (id: string) => (id === "implementer" ? "implementer" : undefined),
			isTeammateActive: () => true,
			sendMessage,
		}

		const mockController = {
			task: { messageStateHandler: { addMessages } },
			postStateToWebview: vi.fn(),
		} as unknown as Controller
		const req = OrvantaSendAgentDirectMessageRequest.create({
			agentId: "implementer",
			subject: "Urgent fix",
			message: "Please write unit tests before submitting handoff",
		})

		const response = await sendAgentDirectMessage(mockController, req)
		expect(response.success).toBe(true)
		expect(sendMessage).toHaveBeenCalledWith(
			"session-lead-1",
			"implementer",
			"Urgent fix",
			"Please write unit tests before submitting handoff",
			undefined,
			{ wakeIfIdle: true },
		)
		expect(addMessages).toHaveBeenCalledWith([
			expect.objectContaining({
				say: "user_feedback",
				text: "Please write unit tests before submitting handoff",
				agentId: "implementer",
			}),
		])

		const transcript = globalWarRoomTracker.getAgentTranscript("implementer")
		expect(transcript.length).toBeGreaterThan(0)
		expect(transcript[0].text).toContain("[CEO ➜ @Dave] (Urgent fix): Please write unit tests before submitting handoff")

		;(globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime = previous
	})

	it("sendAgentDirectMessage soft-succeeds when recipient is missing from the live team", async () => {
		globalWarRoomTracker.syncRoster([{ id: "reviewer", displayName: "Reviewer", role: "teammate", status: "idle" }])
		const previous = (globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime
		;(globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime = {
			getLeadAgentId: () => "session-lead-1",
			getMemberIds: () => ["session-lead-1"],
			getMemberRole: () => "lead",
			resolveMemberId: () => undefined,
			isTeammateActive: () => false,
			sendMessage: vi.fn(() => {
				throw new Error('Unknown recipient "reviewer"')
			}),
		}

		const mockController = {} as unknown as Controller
		const req = OrvantaSendAgentDirectMessageRequest.create({
			agentId: "reviewer",
			message: "Please review",
		})

		const response = await sendAgentDirectMessage(mockController, req)
		expect(response.success).toBe(true)
		expect(globalWarRoomTracker.getAgentTranscript("reviewer").length).toBeGreaterThan(0)

		;(globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime = previous
	})

	it("sendAgentDirectMessage deposits mail without waking an inactive teammate", async () => {
		const previous = (globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime
		const sendMessage = vi.fn()
		;(globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime = {
			getLeadAgentId: () => "session-lead-1",
			getMemberIds: () => ["session-lead-1", "reviewer"],
			getMemberRole: (id: string) => (id === "session-lead-1" ? "lead" : "teammate"),
			resolveMemberId: (id: string) => (id === "reviewer" ? "reviewer" : undefined),
			isTeammateActive: () => false,
			sendMessage,
		}

		const mockController = {} as unknown as Controller
		const req = OrvantaSendAgentDirectMessageRequest.create({
			agentId: "reviewer",
			message: "Please review",
		})

		const response = await sendAgentDirectMessage(mockController, req)
		expect(response.success).toBe(true)
		expect(sendMessage).toHaveBeenCalledWith(
			"session-lead-1",
			"reviewer",
			"Direct Steer from CEO",
			"Please review",
			undefined,
			{ wakeIfIdle: false },
		)

		;(globalThis as { __activeTeamRuntime?: unknown }).__activeTeamRuntime = previous
	})
})
