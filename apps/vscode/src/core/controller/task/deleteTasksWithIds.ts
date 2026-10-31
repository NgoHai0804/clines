import { deleteSession as deleteCeoSession, listSessions } from "@cline/shared"
import { Empty, StringArrayRequest } from "@shared/proto/cline/common"
import { resolveOrvantaWorkspaceRoot } from "@/orvanta/resolve-workspace"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

/**
 * Deletes tasks with the specified IDs.
 * Confirmation belongs in the webview (inline / button confirm) — this handler
 * must not show a second host modal, or Orvanta history delete appears to fail
 * when the user dismisses the redundant dialog.
 * @param controller The controller instance
 * @param request The request containing an array of task IDs to delete
 * @returns Empty response
 * @throws Error if operation fails
 */
export async function deleteTasksWithIds(controller: Controller, request: StringArrayRequest): Promise<Empty> {
	if (!request.value || request.value.length === 0) {
		throw new Error("Missing task IDs")
	}

	for (const id of request.value) {
		await deleteTaskWithId(controller, id)
	}

	return Empty.create()
}

/**
 * Deletes a single task with the specified ID
 * @param controller The controller instance
 * @param id The task ID to delete
 */
async function deleteTaskWithId(controller: Controller, id: string): Promise<void> {
	// Clear current task if it matches the ID being deleted
	if (id === controller.task?.taskId) {
		await controller.clearTask()
		Logger.debug("cleared task")
	}

	// Remove task from state FIRST — this updates the in-memory cache
	// immediately so the next postStateToWebview() sends the updated list.
	try {
		await controller.deleteTaskFromState(id)
	} catch (error) {
		Logger.warn(`[TaskService.deleteTasksWithIds] Failed to delete SDK/history task ${id}:`, error)
		// Still try to clear Orvanta CEO index rows that point at this task.
	}

	await deleteLinkedCeoSessions(id)

	// Always update webview state so the history list and recents refresh
	await controller.postStateToWebview()
}

/** Drop CEO session index entries whose participant taskId matches the deleted task. */
async function deleteLinkedCeoSessions(taskId: string): Promise<void> {
	const root = await resolveOrvantaWorkspaceRoot()
	if (!root) {
		return
	}
	try {
		const page = await listSessions(root, { page: 1, pageSize: 200 })
		for (const session of page.sessions) {
			const linked = session.participantSummaries.some((participant) => participant.taskId === taskId)
			if (!linked && session.sessionId !== taskId) {
				continue
			}
			try {
				await deleteCeoSession(root, session.sessionId)
			} catch (error) {
				Logger.warn(`[TaskService.deleteTasksWithIds] Failed to delete CEO session ${session.sessionId}:`, error)
			}
		}
	} catch (error) {
		Logger.warn("[TaskService.deleteTasksWithIds] Failed to scan CEO sessions after task delete:", error)
	}
}
