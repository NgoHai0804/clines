import { getActiveTaskBinding, getCeoSessionPause, isCeoSessionDispatchBlocked } from "@cline/shared"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { OrvantaSendAgentDirectMessageRequest, OrvantaSendAgentDirectMessageResponse } from "@shared/proto/cline/orvanta"
import { recordCeoDirectMessage } from "@/orvanta/ceo-direct-message-store"
import { resolveOrvantaWorkspaceRoot } from "@/orvanta/resolve-workspace"
import { globalWarRoomTracker } from "@/orvanta/war-room-tracker"
import { pushMessageToWebview } from "@/sdk/webview-grpc-bridge"
import { Logger } from "@/shared/services/Logger"

import type { Controller } from ".."

type TeamRuntimeHandle = {
	getLeadAgentId?: () => string
	getMemberIds?: () => string[]
	getMemberRole?: (agentId: string) => "lead" | "teammate" | undefined
	resolveMemberId?: (agentId: string) => string | undefined
	isTeammateActive?: (agentId: string) => boolean
	sendMessage: (
		fromAgentId: string,
		toAgentId: string,
		subject: string,
		body: string,
		taskId?: string,
		options?: { wakeIfIdle?: boolean },
	) => unknown
}

function resolveLeadAgentId(runtime: TeamRuntimeHandle): string {
	if (typeof runtime.getLeadAgentId === "function") {
		const leadId = runtime.getLeadAgentId()?.trim()
		if (leadId) {
			return leadId
		}
	}
	const memberIds = runtime.getMemberIds?.() ?? []
	const leadFromRole = memberIds.find((id) => runtime.getMemberRole?.(id) === "lead")
	return leadFromRole || "lead"
}

function fuzzyMatchAgentId(candidate: string, requested: string): boolean {
	const a = candidate.trim().toLowerCase()
	const b = requested.trim().toLowerCase()
	if (!a || !b) {
		return false
	}
	if (a === b) {
		return true
	}
	return a.startsWith(`${b}-`) || b.startsWith(`${a}-`)
}

function resolveRecipientId(runtime: TeamRuntimeHandle, requestedId: string): string {
	const trimmed = requestedId.trim()
	if (typeof runtime.resolveMemberId === "function") {
		const resolved = runtime.resolveMemberId(trimmed)
		if (resolved) {
			return resolved
		}
	}
	const memberIds = runtime.getMemberIds?.() ?? []
	const fromMembers =
		memberIds.find((id) => id === trimmed) ||
		memberIds.find((id) => id.toLowerCase() === trimmed.toLowerCase()) ||
		memberIds.find((id) => fuzzyMatchAgentId(id, trimmed))
	if (fromMembers) {
		return fromMembers
	}

	// War-room cards often carry the live instance id (reviewer-abc-1) while the
	// sidebar focuses the roster slug (reviewer). Prefer a card id that is also a member.
	const cardIds = globalWarRoomTracker.getSnapshot().map((card) => card.id)
	const fromCards =
		cardIds.find((id) => fuzzyMatchAgentId(id, trimmed) && memberIds.includes(id)) ||
		cardIds.find((id) => fuzzyMatchAgentId(id, trimmed))
	return fromCards || trimmed
}

/**
 * Mint a transcript identity on the same counter as SDK agent rows.
 * `ClineMessage.ts` is a monotonic merge key (MessageIdMinter), NOT wall-clock —
 * Date.now() (~1.7e12) sorts AFTER every minter id (1, 2, 3…) and paints CEO
 * bubbles below the agent replies they triggered.
 */
function mintCeoMessageTs(controller: Controller): number {
	const minter = (
		controller as Controller & {
			messageTranslatorState?: { getMinter?: () => { nextId?: () => number } }
		}
	).messageTranslatorState?.getMinter?.()
	if (typeof minter?.nextId === "function") {
		return minter.nextId()
	}
	const existing = controller.task?.messageStateHandler?.getClineMessages?.() ?? []
	let maxTs = 0
	for (const message of existing) {
		if (typeof message.ts === "number" && message.ts > maxTs) {
			maxTs = message.ts
		}
	}
	return maxTs + 1
}

/**
 * Persist the CEO 1:1 bubble into the shared transcript BEFORE waking the teammate,
 * so agent replies always sort after the CEO message. Stamp with the roster agent id
 * the sidebar focuses so channel filters keep the bubble on that Agent's view.
 */
function appendCeoDirectMessageToTranscript(controller: Controller, request: OrvantaSendAgentDirectMessageRequest): ClineMessage {
	const agentId = request.agentId.trim()
	const card = globalWarRoomTracker.getSnapshot().find((c) => fuzzyMatchAgentId(c.id, agentId))
	const message: ClineMessage = {
		// Same id space as agent rows — stamp before wake so replies sort after this bubble.
		ts: mintCeoMessageTs(controller),
		type: "say",
		say: "user_feedback",
		text: request.message,
		partial: false,
		agentId,
		agentDisplayName: card?.displayName || agentId,
		agentRole: card?.role || "teammate",
	}
	// Durable across SDK transcript rebuilds (MessageStateHandler is often replaced).
	// Scoped to the active task so a later [+] / clearTask blank session cannot inherit them.
	recordCeoDirectMessage({
		ts: message.ts,
		agentId,
		text: request.message,
		displayName: card?.displayName || agentId,
		subject: request.subject,
		taskId: controller.task?.taskId?.trim() || undefined,
	})
	const handler = controller.task?.messageStateHandler
	if (handler && typeof handler.addMessages === "function") {
		handler.addMessages([message])
	}
	void pushMessageToWebview(message)
	void controller.postStateToWebview?.()
	return message
}

export async function sendAgentDirectMessage(
	controller: Controller,
	request: OrvantaSendAgentDirectMessageRequest,
): Promise<OrvantaSendAgentDirectMessageResponse> {
	try {
		Logger.info(`sendAgentDirectMessage: sending message to ${request.agentId}`)

		const taskId = controller.task?.taskId?.trim()
		const binding = taskId ? getActiveTaskBinding(taskId) : undefined
		const ceoSessionId = binding?.sessionId?.trim()
		if (ceoSessionId) {
			const root = binding?.workspaceRoot || (await resolveOrvantaWorkspaceRoot())
			if (root) {
				const pause = await getCeoSessionPause(root, ceoSessionId)
				if (isCeoSessionDispatchBlocked(pause)) {
					return OrvantaSendAgentDirectMessageResponse.create({
						success: false,
						error: `CEO session is ${pause?.status ?? "paused"}; resume before sending new work.`,
					})
				}
			}
		}

		const targetId = request.agentId.trim().toLowerCase()
		const isLead = targetId === "coordinator" || targetId === "lead"
		const subject = request.subject || "Direct Steer from CEO"

		if (isLead) {
			// Direct message to Coordinator -> route to main Cline session
			if (controller.task) {
				await controller.task.handleWebviewAskResponse("messageResponse", request.message)
			} else if (typeof (controller as any).initTask === "function") {
				await (controller as any).initTask(request.message)
			} else {
				throw new Error("No active coordinator session to receive message")
			}
		} else {
			// Persist CEO bubble first so transcript order stays CEO → agent reply.
			appendCeoDirectMessageToTranscript(controller, request)
			globalWarRoomTracker.recordDirectMessage(request.agentId, request.message, subject)

			// Direct message to Teammate -> mailbox + wake idle agent so CEO gets a reply
			// biome-ignore lint/suspicious/noExplicitAny: access global team runtime if running
			const runtime = (globalThis as any).__activeTeamRuntime as TeamRuntimeHandle | undefined
			if (!runtime || typeof runtime.sendMessage !== "function") {
				return OrvantaSendAgentDirectMessageResponse.create({
					success: false,
					error: "Không có phiên team đang chạy. Mở / tiếp tục phiên CEO trước khi chỉ đạo 1:1.",
				})
			}
			try {
				const fromAgentId = resolveLeadAgentId(runtime)
				const toAgentId = resolveRecipientId(runtime, request.agentId)
				const canWake = typeof runtime.isTeammateActive !== "function" || runtime.isTeammateActive(toAgentId)
				runtime.sendMessage(fromAgentId, toAgentId, subject, request.message, undefined, {
					wakeIfIdle: canWake,
				})
			} catch (err) {
				let error = err instanceof Error ? err.message : String(err)
				Logger.warn(`sendAgentDirectMessage: runtime.sendMessage error: ${error}`)

				// Retry once with an explicit lead member id if the default sender was wrong.
				if (/Unknown sender/i.test(error)) {
					try {
						const memberIds = runtime.getMemberIds?.() ?? []
						const leadId = memberIds.find((id) => runtime.getMemberRole?.(id) === "lead")
						const toAgentId = resolveRecipientId(runtime, request.agentId)
						if (leadId) {
							const canWake = typeof runtime.isTeammateActive !== "function" || runtime.isTeammateActive(toAgentId)
							runtime.sendMessage(leadId, toAgentId, subject, request.message, undefined, {
								wakeIfIdle: canWake,
							})
							return OrvantaSendAgentDirectMessageResponse.create({ success: true })
						}
					} catch (retryErr) {
						error = retryErr instanceof Error ? retryErr.message : String(retryErr)
						Logger.warn(`sendAgentDirectMessage: sender retry failed: ${error}`)
					}
				}

				// Recipient missing from the live team graph: CEO bubble is already in the
				// transcript; treat as delivered for channel UX. Agent reply needs a spawn.
				if (/Unknown recipient/i.test(error)) {
					Logger.warn(
						`sendAgentDirectMessage: soft-succeeding Unknown recipient "${request.agentId}" for CEO-visible steer`,
					)
					return OrvantaSendAgentDirectMessageResponse.create({ success: true })
				}

				return OrvantaSendAgentDirectMessageResponse.create({
					success: false,
					error,
				})
			}
		}

		return OrvantaSendAgentDirectMessageResponse.create({
			success: true,
		})
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		Logger.error(`sendAgentDirectMessage failed: ${errorMessage}`, error)
		return OrvantaSendAgentDirectMessageResponse.create({
			success: false,
			error: errorMessage,
		})
	}
}
