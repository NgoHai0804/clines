import { ClineMessage } from "@shared/ExtensionMessage"
import React, { useMemo } from "react"
import Thumbnails from "@/components/common/Thumbnails"
import { CEO_USER_BUBBLE_CLASS } from "../UserMessage"
import { highlightText } from "./Highlights"

interface TaskHeaderProps {
	task: ClineMessage
	totalCost: number
	onClose: () => void
}

/**
 * Whether the header may show the task's cost. Kept for callers/tests that still
 * gate cost display elsewhere; the CEO brief itself is a plain chat bubble.
 */
export function isTaskCostAvailable(input: {
	isCloudTask: boolean
	cloudUsageAvailable: boolean | undefined
	localCostAvailable: boolean
}): boolean {
	if (input.isCloudTask) {
		return input.cloudUsageAvailable === true
	}
	return input.localCostAvailable
}

/**
 * CEO session brief — same teal bubble as in-stream user messages.
 * No copy/delete/cost/close chrome (those lived in the old TaskHeader card).
 */
const TaskHeader: React.FC<TaskHeaderProps> = ({ task }) => {
	const highlightedText = useMemo(() => highlightText(task.text, false), [task.text])
	const text = (task.text || "").trim()
	// Guard against promoting api_req stubs / raw JSON (e.g. "{}") into the CEO bubble.
	const looksLikeRawJson =
		text === "{}" ||
		((text.startsWith("{") || text.startsWith("[")) &&
			(() => {
				try {
					const parsed = JSON.parse(text)
					return parsed !== null && typeof parsed === "object"
				} catch {
					return false
				}
			})())
	const hasAttachments = Boolean((task.images && task.images.length > 0) || (task.files && task.files.length > 0))
	if ((!text && !hasAttachments) || (looksLikeRawJson && !hasAttachments)) {
		return null
	}

	return (
		<div className="py-2 px-4">
			<div
				className={CEO_USER_BUBBLE_CLASS}
				data-testid="task-header-bubble"
				style={{
					whiteSpace: "pre-line",
					wordWrap: "break-word",
				}}>
				{text ? <span className="ph-no-capture block">{highlightedText}</span> : null}
				{hasAttachments ? (
					<Thumbnails files={task.files ?? []} images={task.images ?? []} style={{ marginTop: text ? "8px" : 0 }} />
				) : null}
			</div>
		</div>
	)
}

export default TaskHeader
