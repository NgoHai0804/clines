import type React from "react"
import { useMemo } from "react"
import Thumbnails from "@/components/common/Thumbnails"
import { highlightText } from "./task-header/Highlights"

interface UserMessageProps {
	text?: string
	files?: string[]
	images?: string[]
	messageTs?: number
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	/** Kept for ChatRow compatibility; CEO bubbles are display-only. */
	canRestoreWorkspace?: boolean
}

/** Shared CEO / user bubble chrome — teal focus fill so it never reads as plain chat text. */
export const CEO_USER_BUBBLE_CLASS =
	"relative px-2.5 py-2 rounded-sm text-sm border border-[var(--vscode-focusBorder,#007fd4)] bg-[color-mix(in_srgb,var(--vscode-focusBorder,#007fd4)_22%,var(--vscode-badge-background,#3c3c3c))] text-[var(--vscode-foreground)]"

/**
 * CEO / user chat bubble — plain messaging style (teal focus fill, no action chrome).
 */
const UserMessage: React.FC<UserMessageProps> = ({ text, images, files }) => {
	const highlightedText = useMemo(() => highlightText(text), [text])

	return (
		<div
			className={`${CEO_USER_BUBBLE_CLASS} my-1 chat-row-user-message-container`}
			data-testid="user-message-bubble"
			style={{
				whiteSpace: "pre-line",
				wordWrap: "break-word",
			}}>
			<span className="ph-no-capture" style={{ display: "block" }}>
				{highlightedText}
			</span>
			{((images && images.length > 0) || (files && files.length > 0)) && (
				<Thumbnails files={files ?? []} images={images ?? []} style={{ marginTop: "8px" }} />
			)}
		</div>
	)
}

export default UserMessage
