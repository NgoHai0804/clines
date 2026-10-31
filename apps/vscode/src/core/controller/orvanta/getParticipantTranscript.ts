import { getSession } from "@cline/shared"
import { OrvantaParticipantTranscriptRequest, OrvantaParticipantTranscriptResponse } from "@shared/proto/cline/orvanta"
import { queryParticipantTranscript } from "@/orvanta/participant-transcript-query"
import { resolveOrvantaWorkspaceRoot } from "@/orvanta/resolve-workspace"
import type { SdkSessionLifecycle } from "@/sdk/sdk-session-lifecycle"
import type { Controller } from ".."

function getSessionLifecycle(controller: Controller): SdkSessionLifecycle | undefined {
	// `sessions` is private on Controller; access via unknown for this Orvanta host bridge.
	const sessions = (controller as unknown as { sessions?: SdkSessionLifecycle }).sessions
	return sessions
}

export async function getParticipantTranscript(
	controller: Controller,
	request: OrvantaParticipantTranscriptRequest,
): Promise<OrvantaParticipantTranscriptResponse> {
	const sessionId = request.sessionId?.trim()
	if (!sessionId) {
		return OrvantaParticipantTranscriptResponse.create({
			success: false,
			error: "sessionId is required",
			status: "error",
			code: "INVALID_ARGUMENT",
			messagesJson: "[]",
			truncated: false,
		})
	}
	const root = await resolveOrvantaWorkspaceRoot()
	if (!root) {
		return OrvantaParticipantTranscriptResponse.create({
			success: false,
			error: "No workspace folder open",
			status: "error",
			code: "WORKSPACE_MISMATCH",
			messagesJson: "[]",
			truncated: false,
		})
	}
	const lifecycle = getSessionLifecycle(controller)
	if (!lifecycle) {
		return OrvantaParticipantTranscriptResponse.create({
			success: false,
			error: "Session host unavailable",
			status: "error",
			code: "STORAGE_ERROR",
			messagesJson: "[]",
			truncated: false,
		})
	}
	try {
		const sessionHost = await lifecycle.getHostForWorkspaceRoot(root)
		const result = await queryParticipantTranscript({
			workspaceRoot: root,
			orvantaSessionId: sessionId,
			participantNumericId:
				request.participantNumericId !== undefined && request.participantNumericId > 0
					? Number(request.participantNumericId)
					: undefined,
			runId: request.runId?.trim() || undefined,
			cursor: request.cursor,
			pageSize: request.pageSize,
			loadManifest: (workspaceRoot, id) => getSession(workspaceRoot, id),
			sessionHost,
		})
		if (result.status === "ok") {
			return OrvantaParticipantTranscriptResponse.create({
				success: true,
				status: "ok",
				sdkSessionId: result.sdkSessionId,
				participantNumericId: result.participantNumericId,
				participantSlug: result.participantSlug,
				runIds: result.runIds,
				messagesJson: JSON.stringify(result.messages),
				nextCursor: result.nextCursor,
				truncated: result.truncated,
			})
		}
		if (result.status === "not-linked") {
			return OrvantaParticipantTranscriptResponse.create({
				success: false,
				error: result.reason,
				status: "not_linked",
				code: result.reason,
				messagesJson: "[]",
				truncated: false,
			})
		}
		if (result.status === "not-found") {
			return OrvantaParticipantTranscriptResponse.create({
				success: false,
				error: `${result.resource}:${result.id}`,
				status: "not_found",
				code: result.resource,
				messagesJson: "[]",
				truncated: false,
			})
		}
		return OrvantaParticipantTranscriptResponse.create({
			success: false,
			error: result.error instanceof Error ? result.error.message : String(result.error),
			status: "error",
			code: result.code,
			messagesJson: "[]",
			truncated: false,
		})
	} catch (error) {
		return OrvantaParticipantTranscriptResponse.create({
			success: false,
			error: error instanceof Error ? error.message : String(error),
			status: "error",
			code: "STORAGE_ERROR",
			messagesJson: "[]",
			truncated: false,
		})
	}
}
