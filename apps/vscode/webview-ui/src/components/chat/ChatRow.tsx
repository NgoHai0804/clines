import { GeneratedMediaContent } from "@cline/ui"
import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import {
	ClineApiReqInfo,
	ClineAskQuestion,
	ClineAskUseMcpServer,
	ClineMessage,
	ClinePlanModeResponse,
	ClineSayTool,
	COMPLETION_RESULT_CHANGES_FLAG,
} from "@shared/ExtensionMessage"
import { BooleanRequest, StringRequest } from "@shared/proto/cline/common"
import { Mode } from "@shared/storage/types"
import { IconClipboardList, IconEye, IconMarkdown, IconPackage } from "@tabler/icons-react"
import deepEqual from "fast-deep-equal"
import {
	BellIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleXIcon,
	FileCode2Icon,
	FilePlus2Icon,
	FoldVerticalIcon,
	ImageUpIcon,
	LightbulbIcon,
	Link2Icon,
	LoaderCircleIcon,
	PencilIcon,
	SearchIcon,
	SettingsIcon,
	SquareArrowOutUpRightIcon,
	SquareMinusIcon,
	TerminalIcon,
	TriangleAlertIcon,
} from "lucide-react"
import { MouseEvent, memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useSize } from "react-use"
import { isOptionsAskActive } from "@/components/chat/chat-view/shared/buttonConfig"
import {
	canonicalAgentId,
	getCoordinationCardKind,
	isCoordinatorChannel,
} from "@/components/chat/chat-view/utils/filterAgentChannelMessages"
import { canRestoreWorkspaceFromMessage } from "@/components/chat/chat-view/utils/messageUtils"
import { OptionsButtons } from "@/components/chat/OptionsButtons"
import { CloudProvisioningRow } from "@/components/cloud/CloudProvisioningRow"
import { WithCopyButton } from "@/components/common/CopyButton"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import Thumbnails from "@/components/common/Thumbnails"
import McpResponseDisplay from "@/components/mcp/chat-display/McpResponseDisplay"
import McpResourceRow from "@/components/mcp/configuration/tabs/installed/server-row/McpResourceRow"
import McpToolRow from "@/components/mcp/configuration/tabs/installed/server-row/McpToolRow"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import { FileServiceClient, UiServiceClient } from "@/services/grpc-client"
import { findMatchingResourceOrTemplate } from "@/utils/mcp"
import CodeAccordian, { cleanPathPrefix } from "../common/CodeAccordian"
import { CommandOutputContent, CommandOutputRow } from "./CommandOutputRow"
import CompactionRow from "./CompactionRow"
import { CompletionOutputRow } from "./CompletionOutputRow"
import { CHAT_HEADER_META, CHAT_HEADER_ROW, CHAT_HEADER_TITLE, CHAT_ROW_ICON_PX, CHAT_ROW_LUCIDE } from "./chatRowStyles"
import { DiffEditRow } from "./DiffEditRow"
import ErrorRow from "./ErrorRow"
import { FeatureTip } from "./FeatureTip"
import HookMessage from "./HookMessage"
import { MarkdownRow } from "./MarkdownRow"
import NewTaskPreview from "./NewTaskPreview"
import PlanCompletionOutputRow from "./PlanCompletionOutputRow"
import QuoteButton from "./QuoteButton"
import ReportBugPreview from "./ReportBugPreview"
import { RequestStartRow } from "./RequestStartRow"
import SearchResultsDisplay from "./SearchResultsDisplay"
import SubagentStatusRow from "./SubagentStatusRow"
import { ThinkingRow } from "./ThinkingRow"
import UserMessage from "./UserMessage"

interface ChatRowProps {
	message: ClineMessage
	isExpanded: boolean
	onToggleExpand: (ts: number, options?: { preserveAutoScroll?: boolean }) => void
	lastModifiedMessage?: ClineMessage
	isLast: boolean
	onHeightChange: (isTaller: boolean) => void
	onLastRowContentChange: () => void
	inputValue?: string
	sendMessageFromChatRow?: (text: string, images: string[], files: string[]) => void
	onSetQuote: (text: string) => void
	onCancelCommand?: () => void
	mode?: Mode
	reasoningContent?: string
	responseStarted?: boolean
	retryFailedRequest?: () => Promise<boolean>
	selectedAgentId?: string
	isStickyClone?: boolean
}

export interface QuoteButtonState {
	visible: boolean
	top: number
	left: number
	selectedText: string
}

interface ChatRowContentProps extends Omit<ChatRowProps, "onHeightChange" | "onLastRowContentChange"> {
	onLastRowContentChange?: () => void
}

export const ProgressIndicator = () => <LoaderCircleIcon {...CHAT_ROW_LUCIDE} className="mr-2 shrink-0 animate-spin" />
const InvisibleSpacer = () => <div aria-hidden className="h-px" />

const ChatRow = memo(
	(props: ChatRowProps) => {
		const { isLast, onHeightChange } = props
		// Store the previous height to compare with the current height
		// This allows us to detect changes without causing re-renders
		const prevHeightRef = useRef(0)

		const [chatrow, { height }] = useSize(
			<div className="relative pt-2.5 px-4">
				<ChatRowContent {...props} />
			</div>,
		)

		useEffect(() => {
			// used for partials command output etc.
			// NOTE: it's important we don't distinguish between partial or complete here since our scroll effects in chatview need to handle height change during partial -> complete
			const isInitialRender = prevHeightRef.current === 0 // prevents scrolling when new element is added since we already scroll for that
			// height starts off at Infinity
			if (isLast && height !== 0 && height !== Number.POSITIVE_INFINITY && height !== prevHeightRef.current) {
				if (!isInitialRender) {
					onHeightChange(height > prevHeightRef.current)
				}
				prevHeightRef.current = height
			}
		}, [height, isLast, onHeightChange])

		// we cannot return null as virtuoso does not support it so we use a separate visibleMessages array to filter out messages that should not be rendered
		return chatrow
	},
	// memo does shallow comparison of props, so we need to do deep comparison of arrays/objects whose properties might change
	deepEqual,
)

export default ChatRow

interface TeamRunTaskCardProps {
	tool: { tool?: string; content?: string; path?: string }
	message?: { agentId?: string; agentDisplayName?: string; ts?: number }
	type?: "assign" | "handoff" | "message"
	selectedAgentId?: string
	omitDomId?: boolean
}

interface TeamRunTaskPayload {
	agentId?: string
	assignee?: string
	toAgentId?: string
	to?: string
	recipient?: string
	fromAgentId?: string
	from?: string
	instruction?: string
	description?: string
	prompt?: string
	task?: string
	taskId?: string
	deliverableArtifactPath?: string
	context?: unknown
	summary?: string
	body?: string
	title?: string
	taskTitle?: string
	subject?: string
	content?: string
	reportText?: string
	status?: string
	output?: unknown
}

type TaskDetailViewMode = "pretty" | "markdown"

/** Shared detail box: Đẹp (markdown render, default) | Markdown (raw source). */
const TaskDetailSection = memo(({ title, content }: { title: string; content: string }) => {
	const [viewMode, setViewMode] = useState<TaskDetailViewMode>("pretty")
	const boxClass =
		"bg-surface-secondary/50 rounded p-2.5 text-foreground/90 border border-border/50 select-text text-[11px] leading-relaxed"

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between gap-2">
				<span className={CHAT_HEADER_TITLE}>{title}</span>
				<div
					aria-label="Chế độ hiển thị"
					className="inline-flex shrink-0 rounded border border-border/50 overflow-hidden"
					role="group">
					<button
						aria-label="Đẹp"
						className={`p-1 transition-colors cursor-pointer ${
							viewMode === "pretty"
								? "bg-(--vscode-button-background) text-(--vscode-button-foreground)"
								: "bg-transparent text-muted-foreground hover:text-foreground"
						}`}
						onClick={() => setViewMode("pretty")}
						title="Đẹp"
						type="button">
						<IconEye size={12} stroke={1.5} />
					</button>
					<button
						aria-label="Markdown"
						className={`p-1 transition-colors cursor-pointer border-l border-border/50 ${
							viewMode === "markdown"
								? "bg-(--vscode-button-background) text-(--vscode-button-foreground)"
								: "bg-transparent text-muted-foreground hover:text-foreground"
						}`}
						onClick={() => setViewMode("markdown")}
						title="Markdown"
						type="button">
						<IconMarkdown size={12} stroke={1.5} />
					</button>
				</div>
			</div>
			{viewMode === "pretty" ? (
				<div className={`${boxClass} [&_.inline-markdown-block]:text-[11px] [&_p:last-child]:mb-0`}>
					<MarkdownBlock markdown={content} />
				</div>
			) : (
				<div className={`${boxClass} whitespace-pre-wrap font-mono`}>{content}</div>
			)}
		</div>
	)
})
TaskDetailSection.displayName = "TaskDetailSection"

const cleanAgentName = (id?: string, fallback = "Coordinator"): string => {
	if (!id) return fallback
	const trimmed = id.trim()
	if (
		/^\d+/.test(trimmed) ||
		trimmed.includes("_") ||
		trimmed.toLowerCase() === "coordinator" ||
		trimmed.toLowerCase() === "lead" ||
		trimmed.toLowerCase() === "parent" ||
		trimmed.toLowerCase() === "system" ||
		trimmed.toLowerCase() === "agent"
	) {
		return "Coordinator"
	}
	// Dev-6551ae1053d2-1 → Dev; Reviewer-395529902aae-1 → Reviewer
	const instance = trimmed.match(/^([A-Za-z][A-Za-z0-9]*)-[0-9a-f]{6,}(?:-\d+)?$/i)
	if (instance) {
		const base = instance[1]
		return base.charAt(0).toUpperCase() + base.slice(1)
	}
	if (trimmed.toLowerCase() === "coder") return "Coder"
	if (trimmed.toLowerCase() === "reviewer") return "Reviewer"
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1)
}

function toolActorName(message: ClineMessage): string {
	const id = message.agentId ?? message.agent_id
	const display = message.agentDisplayName ?? message.agent_display_name
	if (id) {
		return cleanAgentName(id, display || "Cline")
	}
	return display?.trim() || "Cline"
}

const TeamRunTaskCard = memo(({ tool, message, type = "assign", selectedAgentId, omitDomId }: TeamRunTaskCardProps) => {
	const [isExpanded, setIsExpanded] = useState(false)
	let parsed: TeamRunTaskPayload = {}
	try {
		parsed = JSON.parse(tool.content || "{}") as TeamRunTaskPayload
	} catch {}

	const rawSenderId = canonicalAgentId(parsed.fromAgentId || parsed.from || message?.agentId) || "coordinator"
	const recipientId =
		canonicalAgentId(
			parsed.toAgentId ||
				parsed.assignee ||
				parsed.to ||
				parsed.recipient ||
				(type === "assign" || type === "handoff" ? parsed.agentId : undefined) ||
				(type === "handoff" || (type === "message" && !isCoordinatorChannel(rawSenderId)) ? "coordinator" : ""),
		) || (type === "handoff" || type === "message" ? "coordinator" : "")

	const rawInstruction =
		parsed.instruction ||
		parsed.description ||
		parsed.prompt ||
		parsed.task ||
		parsed.summary ||
		parsed.body ||
		parsed.content ||
		parsed.subject ||
		tool.path ||
		""
	const firstLine = rawInstruction
		? rawInstruction
				.split("\n")[0]
				.replace(/^[#\s*-]+/, "")
				.slice(0, 100)
		: ""
	const summaryText =
		parsed.title || parsed.taskTitle || parsed.subject || firstLine || (rawInstruction ? rawInstruction.slice(0, 140) : "")

	// Drop empty ghost cards or dummy placeholder cards like "@agent"
	if (
		!recipientId ||
		recipientId.toLowerCase() === "agent" ||
		(!parsed.taskId && !rawInstruction && !parsed.title && !parsed.taskTitle && !parsed.task) ||
		(!parsed.taskId && (!rawInstruction || rawInstruction.trim().length === 0))
	) {
		return null
	}

	const isRecipient = Boolean(
		selectedAgentId &&
			(canonicalAgentId(recipientId) === canonicalAgentId(selectedAgentId) ||
				// Dev-abc… vs Dev when roster id differs from instance id
				cleanAgentName(recipientId).toLowerCase() === cleanAgentName(selectedAgentId).toLowerCase()),
	)

	const toolName =
		tool.tool || (type === "handoff" ? "orvanta_submit_handoff" : type === "message" ? "team_send_message" : "team_run_task")
	const kind = getCoordinationCardKind(toolName, rawSenderId, recipientId)
	const status = parsed.status?.toLowerCase() ?? ""
	const output =
		parsed.output && typeof parsed.output === "object" && !Array.isArray(parsed.output)
			? (parsed.output as Record<string, unknown>)
			: undefined
	const outputStatus = typeof output?.status === "string" ? output.status.toLowerCase() : ""
	const outputText = typeof output?.text === "string" ? output.text.trim() : ""
	const outputMode = typeof output?.mode === "string" ? output.mode : ""
	const resultText = (parsed.reportText || (kind === "report" ? rawInstruction : "") || outputText || "").trim()
	const hasResult = Boolean(resultText)
	const isPendingDispatch =
		status === "queued" ||
		status === "dispatched" ||
		status === "joined" ||
		outputStatus === "queued" ||
		outputStatus === "dispatched"
	const isCompleted =
		kind === "report" ||
		status === "completed" ||
		status === "done" ||
		outputStatus === "completed" ||
		outputStatus === "done" ||
		(outputMode === "sync" && hasResult) ||
		(hasResult && !isPendingDispatch)

	// Agent channel: slip stays "Nhận việc" / "Tin nhắn" — only the received task.
	// Coordinator: Completed chrome + "Kết quả" when the reply is folded into this card.
	const showCompletionUi = isCompleted && !isRecipient

	const headerIcon = (
		<IconClipboardList
			className={`${showCompletionUi ? "text-success" : "text-indigo-400"} shrink-0`}
			size={CHAT_ROW_ICON_PX}
			stroke={1.5}
		/>
	)
	const cardColorClass = showCompletionUi ? "border-success/40 bg-success/10" : "border-indigo-500/30 bg-indigo-500/10"

	const headerTitle = isRecipient
		? type === "message"
			? "Tin nhắn"
			: "Nhận việc"
		: type === "message"
			? "Nhắn agent"
			: "Giao việc"

	const teammateChannelId =
		kind === "report"
			? rawSenderId
			: recipientId && recipientId !== "coordinator" && recipientId !== "agent" && !/^\d+/.test(recipientId)
				? recipientId
				: ""
	const isKnownTeammate = Boolean(teammateChannelId) && teammateChannelId.toLowerCase() !== selectedAgentId?.toLowerCase()

	return (
		<div
			className={`rounded-md border ${cardColorClass} p-2.5 text-xs flex flex-col gap-1.5 my-1.5 transition-all`}
			data-task-id={parsed.taskId}
			data-task-status={showCompletionUi ? "completed" : "assigned"}
			data-ts={message?.ts}
			id={omitDomId ? undefined : `message-${message?.ts || ""}`}>
			{/* Collapsed: mô tả task + agent + trạng thái; mũi tên mở chi tiết */}
			<div className="flex items-center justify-between gap-2">
				<div
					className="flex items-center gap-1.5 min-w-0 flex-1 cursor-pointer select-none"
					onClick={() => setIsExpanded(!isExpanded)}>
					<button
						className="text-muted-foreground hover:text-foreground p-0.5 shrink-0"
						title={isExpanded ? "Thu gọn chi tiết" : "Xem toàn bộ nội dung"}
						type="button">
						{isExpanded ? <ChevronDownIcon {...CHAT_ROW_LUCIDE} /> : <ChevronRightIcon {...CHAT_ROW_LUCIDE} />}
					</button>
					<span className="shrink-0">{headerIcon}</span>
					<span className={`${CHAT_HEADER_TITLE} truncate`}>{headerTitle}</span>
					{parsed.taskId?.trim() && (
						<span className="shrink-0 font-mono text-[10px] text-muted-foreground bg-surface-secondary px-1.5 py-0.2 rounded border border-border/50">
							#{parsed.taskId.trim()}
						</span>
					)}
					<span
						className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded border ${
							showCompletionUi
								? "text-success bg-success/15 border-success/35"
								: "text-indigo-300 bg-indigo-500/15 border-indigo-500/30"
						}`}>
						{showCompletionUi ? "Completed" : "Assigned"}
					</span>
				</div>
				<div className="flex items-center gap-1.5 shrink-0">
					{isKnownTeammate && (
						<button
							className={`rounded px-2 py-0.5 text-[11px] cursor-pointer font-mono transition-colors ${
								showCompletionUi
									? "bg-success/20 text-success hover:bg-success/30"
									: "bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30"
							}`}
							onClick={() => {
								window.postMessage({ type: "orvanta_switch_channel", channelId: teammateChannelId }, "*")
							}}
							title={`Chuyển tới kênh @${cleanAgentName(teammateChannelId)}`}
							type="button">
							@{cleanAgentName(teammateChannelId)}
						</button>
					)}
				</div>
			</div>

			{summaryText && (
				<div
					className="text-[11.5px] text-foreground/80 line-clamp-2 leading-relaxed pl-6 cursor-pointer hover:text-foreground transition-colors"
					onClick={() => setIsExpanded(!isExpanded)}
					title="Bấm để xem đầy đủ chi tiết">
					{summaryText}
				</div>
			)}

			{isExpanded && (
				<div
					className={`border-t pt-2.5 flex flex-col gap-2 text-[11px] text-muted-foreground pl-1 ${
						showCompletionUi ? "border-success/25" : "border-indigo-500/20"
					}`}>
					{parsed.taskId?.trim() && (
						<div className="flex items-center gap-1 font-mono text-[11px]">
							<span className="opacity-60">Mã nhiệm vụ:</span>
							<span className="text-foreground font-semibold">#{parsed.taskId.trim()}</span>
						</div>
					)}
					{parsed.deliverableArtifactPath && (
						<div className="flex items-center gap-1.5 font-mono text-[11px] text-indigo-300">
							<IconPackage className="shrink-0" size={CHAT_ROW_ICON_PX} stroke={1.5} />
							<span>Sản phẩm bàn giao:</span>
							<span className="font-semibold underline select-all">{parsed.deliverableArtifactPath}</span>
						</div>
					)}
					{rawInstruction && kind !== "report" && (
						<TaskDetailSection content={rawInstruction} title="Nội dung yêu cầu chi tiết:" />
					)}
					{showCompletionUi && hasResult && <TaskDetailSection content={resultText} title="Kết quả:" />}
					{parsed.context != null && (
						<div className="flex flex-col gap-1">
							<span className={CHAT_HEADER_TITLE}>Ngữ cảnh bổ sung:</span>
							<div className="bg-surface-secondary/30 rounded p-2 text-foreground/80 font-mono text-[10.5px] select-text">
								{typeof parsed.context === "string" ? parsed.context : JSON.stringify(parsed.context, null, 2)}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	)
})

export const ChatRowContent = memo(
	({
		message,
		isExpanded,
		onToggleExpand,
		lastModifiedMessage,
		isLast,
		inputValue,
		sendMessageFromChatRow,
		onSetQuote,
		onCancelCommand,
		onLastRowContentChange,
		mode,
		reasoningContent,
		responseStarted,
		retryFailedRequest,
		selectedAgentId,
		isStickyClone,
	}: ChatRowContentProps) => {
		const {
			backgroundEditEnabled: backgroundEditSetting,
			mcpServers,
			vscodeTerminalExecutionMode,
			clineMessages,
			showFeatureTips,
			enableCheckpointsSetting: checkpointsSetting,
			turnState,
			currentCloudTask,
		} = useExtensionState()
		// Cloud tasks edit files inside the sandbox: there is no local editor to
		// preview in, so diffs render inline, and no local workspace to checkpoint.
		const backgroundEditEnabled = backgroundEditSetting || !!currentCloudTask
		const enableCheckpointsSetting = checkpointsSetting && !currentCloudTask
		const [quoteButtonState, setQuoteButtonState] = useState<QuoteButtonState>({
			visible: false,
			top: 0,
			left: 0,
			selectedText: "",
		})
		const contentRef = useRef<HTMLDivElement>(null)

		// Command output expansion state (for all messages, but only used by command messages)
		const [isOutputFullyExpanded, setIsOutputFullyExpanded] = useState(false)
		const prevCommandExecutingRef = useRef<boolean>(false)

		const hasAutoExpandedRef = useRef(false)
		const hasAutoCollapsedRef = useRef(false)
		const prevIsLastRef = useRef(isLast)

		// Auto-expand completion output when it's the last message (runs once per message)
		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result"

			// Auto-expand if it's last and we haven't already auto-expanded
			if (isLast && isCompletionResult && !hasAutoExpandedRef.current) {
				hasAutoExpandedRef.current = true
				hasAutoCollapsedRef.current = false // Reset the auto-collapse flag when expanding
			}
		}, [isLast, message.ask, message.say])

		// Auto-collapse completion output ONCE when transitioning from last to not-last
		useEffect(() => {
			const isCompletionResult = message.ask === "completion_result" || message.say === "completion_result"
			const wasLast = prevIsLastRef.current

			// Only auto-collapse if transitioning from last to not-last, and we haven't already auto-collapsed
			if (wasLast && !isLast && isCompletionResult && !hasAutoCollapsedRef.current) {
				hasAutoCollapsedRef.current = true
				hasAutoExpandedRef.current = false // Reset the auto-expand flag when collapsing
			}

			prevIsLastRef.current = isLast
		}, [isLast, message.ask, message.say])

		const [cost, _apiReqCancelReason, apiReqStreamingFailedMessage] = useMemo(() => {
			if (message.text != null && message.say === "api_req_started") {
				const info: ClineApiReqInfo = JSON.parse(message.text)
				return [info.cost, info.cancelReason, info.streamingFailedMessage]
			}
			return [undefined, undefined, undefined]
		}, [message.text, message.say])

		// when resuming task last won't be api_req_failed but a resume_task message so api_req_started will show loading spinner. that's why we just remove the last api_req_started that failed without streaming anything
		const apiRequestFailedMessage =
			isLast && lastModifiedMessage?.ask === "api_req_failed" ? lastModifiedMessage?.text : undefined

		const type = message.type === "ask" ? message.ask : message.say

		const isCommandMessage = type === "command"
		// Check if command has output to determine if it's actually executing
		const commandHasOutput = message.text?.includes(COMMAND_OUTPUT_STRING) ?? false
		// A command is executing if it has output but hasn't completed yet
		const isCommandExecuting = isCommandMessage && !message.commandCompleted && commandHasOutput
		// A command is pending if it hasn't started (no output) and hasn't completed
		const isCommandPending = isCommandMessage && isLast && !message.commandCompleted && !commandHasOutput
		const isCommandCompleted = isCommandMessage && message.commandCompleted === true

		const isMcpServerResponding = isLast && lastModifiedMessage?.say === "mcp_server_request_started"

		const handleToggle = useCallback(() => {
			onToggleExpand(message.ts)
		}, [onToggleExpand, message.ts])

		// --- Quote Button Logic ---
		// MOVE handleQuoteClick INSIDE ChatRowContent
		const handleQuoteClick = useCallback(() => {
			onSetQuote(quoteButtonState.selectedText)
			window.getSelection()?.removeAllRanges() // Clear the browser selection
			setQuoteButtonState({ visible: false, top: 0, left: 0, selectedText: "" })
		}, [onSetQuote, quoteButtonState.selectedText]) // <-- Use onSetQuote from props

		const handleMouseUp = useCallback((event: MouseEvent<HTMLDivElement>) => {
			// Get the target element immediately, before the timeout
			const targetElement = event.target as Element
			const isClickOnButton = !!targetElement.closest(".quote-button-class")

			// Delay the selection check slightly
			setTimeout(() => {
				// Now, check the selection state *after* the browser has likely updated it
				const selection = window.getSelection()
				const selectedText = selection?.toString().trim() ?? ""

				let shouldShowButton = false
				let buttonTop = 0
				let buttonLeft = 0
				let textToQuote = ""

				// Condition 1: Check if there's a valid, non-collapsed selection within bounds
				// Ensure contentRef.current still exists in case component unmounted during timeout
				if (selectedText && contentRef.current && selection && selection.rangeCount > 0 && !selection.isCollapsed) {
					const range = selection.getRangeAt(0)
					const rangeRect = range.getBoundingClientRect()
					// Re-check ref inside timeout and ensure containerRect is valid
					const containerRect = contentRef.current?.getBoundingClientRect()

					if (containerRect) {
						// Check if containerRect was successfully obtained
						const tolerance = 5 // Allow for a small pixel overflow (e.g., for margins)
						const isSelectionWithin =
							rangeRect.top >= containerRect.top &&
							rangeRect.left >= containerRect.left &&
							rangeRect.bottom <= containerRect.bottom + tolerance && // Added tolerance
							rangeRect.right <= containerRect.right

						if (isSelectionWithin) {
							shouldShowButton = true // Mark that we should show the button
							const buttonHeight = 30
							// Calculate the raw top position relative to the container, placing it above the selection
							const calculatedTop = rangeRect.top - containerRect.top - buttonHeight - 5 // Subtract button height and a small margin
							// Allow the button to potentially have a negative top value
							buttonTop = calculatedTop
							buttonLeft = Math.max(0, rangeRect.left - containerRect.left) // Still prevent going left of container
							textToQuote = selectedText
						}
					}
				}

				// Decision: Set the state based on whether we should show or hide
				if (shouldShowButton) {
					// Scenario A: Valid selection exists -> Show button
					setQuoteButtonState({
						visible: true,
						top: buttonTop,
						left: buttonLeft,
						selectedText: textToQuote,
					})
				} else if (!isClickOnButton) {
					// Scenario B: No valid selection AND click was NOT on button -> Hide button
					setQuoteButtonState({ visible: false, top: 0, left: 0, selectedText: "" })
				}
				// Scenario C (Click WAS on button): Do nothing here, handleQuoteClick takes over.
			}, 0) // Delay of 0ms pushes execution after current event cycle
		}, []) // Dependencies remain empty

		const [icon, title] = useMemo(() => {
			switch (type) {
				case "error":
					return [
						<span className="codicon codicon-error text-error mb-[-1.5px] text-[12px]" />,
						<span className={`${CHAT_HEADER_TITLE} text-error`}>Error</span>,
					]
				case "mistake_limit_reached":
					return [
						<CircleXIcon {...CHAT_ROW_LUCIDE} className="text-error shrink-0" />,
						<span className={`${CHAT_HEADER_TITLE} text-error`}>Cline is having trouble...</span>,
					]
				case "command":
					return [
						<TerminalIcon {...CHAT_ROW_LUCIDE} className="text-foreground shrink-0" />,
						<span className={CHAT_HEADER_TITLE}>wants to execute this command:</span>,
					]
				case "use_mcp_server":
					const mcpServerUse = JSON.parse(message.text || "{}") as ClineAskUseMcpServer
					const mcpActor =
						message.agentDisplayName ??
						message.agent_display_name ??
						(message.agentId ? `@${message.agentId}` : "Coordinator")
					return [
						isMcpServerResponding ? (
							<ProgressIndicator />
						) : (
							<span className="codicon codicon-server text-foreground mb-[-1.5px] text-[12px]" />
						),
						<span className={`ph-no-capture wrap-break-word ${CHAT_HEADER_TITLE}`}>
							{mcpActor} muốn {mcpServerUse.type === "use_mcp_tool" ? "dùng công cụ" : "truy cập tài nguyên"} trên
							MCP server <code className="break-all">{mcpServerUse.serverName}</code>:
						</span>,
					]
				case "api_req_started":
					return [null, null]
				case "followup":
					const followupActor =
						message.agentDisplayName ??
						message.agent_display_name ??
						(message.agentId ? `@${message.agentId}` : "Coordinator")
					return [
						<span className="codicon codicon-question text-foreground mb-[-1.5px] text-[12px]" />,
						<span className={CHAT_HEADER_TITLE}>{followupActor} có câu hỏi:</span>,
					]
				default:
					return [null, null]
			}
		}, [type, isMcpServerResponding, message.text])

		const tool = useMemo(() => {
			if (message.ask === "tool" || message.say === "tool") {
				return JSON.parse(message.text || "{}") as ClineSayTool
			}
			return null
		}, [message.ask, message.say, message.text])

		const conditionalRulesInfo = useMemo(() => {
			if (message.say !== "conditional_rules_applied" || !message.text) return null
			try {
				const parsed = JSON.parse(message.text) as unknown
				if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as any).rules)) {
					return null
				}
				return parsed as {
					rules: Array<{ name: string; matchedConditions: Record<string, string[]> }>
				}
			} catch {
				return null
			}
		}, [message.say, message.text])

		// Hooks must run unconditionally — tool / conditional-rules paths early-return below.
		// Channel switches can reuse a ChatRow fiber across message types when the agent
		// channel filter changes; skipping these effects caused "Rendered more hooks…".
		useEffect(() => {
			// If command was executing and now isn't, clean up
			if (isCommandMessage && prevCommandExecutingRef.current && !isCommandExecuting) {
				setIsOutputFullyExpanded(false)
			}

			// Update ref for next render
			prevCommandExecutingRef.current = isCommandExecuting
		}, [isCommandMessage, isCommandExecuting])

		// Auto-expand when command starts executing (only if running > 500ms)
		useEffect(() => {
			if (isCommandMessage && isCommandExecuting && !isExpanded) {
				// Wait 500ms before auto-expanding to avoid animating fast commands
				const timer = setTimeout(() => {
					// Expand after 500ms
					onToggleExpand(message.ts, { preserveAutoScroll: true })
				}, 500)

				return () => clearTimeout(timer)
			}
		}, [isCommandMessage, isCommandExecuting, isExpanded, onToggleExpand, message.ts])

		// Helper function to check if file is an image
		const isImageFile = (filePath: string): boolean => {
			const imageExtensions = [".png", ".jpg", ".jpeg", ".webp"]
			const extension = filePath.toLowerCase().split(".").pop()
			return extension ? imageExtensions.includes(`.${extension}`) : false
		}

		if (conditionalRulesInfo) {
			const names = conditionalRulesInfo.rules.map((r: { name: string }) => r.name).join(", ")
			return (
				<div className={CHAT_HEADER_ROW}>
					<span className={CHAT_HEADER_TITLE}>Conditional rules applied:</span>
					<span className="ph-no-capture wrap-break-word whitespace-pre-wrap">{names}</span>
				</div>
			)
		}

		if (tool) {
			const actor = toolActorName(message)
			const colorMap = {
				red: "var(--vscode-errorForeground)",
				yellow: "var(--vscode-editorWarning-foreground)",
				green: "var(--vscode-charts-green)",
			}
			const toolIcon = (name: string, color?: string, rotation?: number, title?: string) => (
				<span
					className={`codicon codicon-${name} ph-no-capture text-[12px] leading-none`}
					style={{
						color: color ? colorMap[color as keyof typeof colorMap] || color : "var(--vscode-foreground)",
						marginBottom: "-1.5px",
						transform: rotation ? `rotate(${rotation}deg)` : undefined,
					}}
					title={title}
				/>
			)

			switch (tool.tool as string) {
				case "editedExistingFile":
					const content = tool?.content || ""
					const isApplyingPatch = content?.startsWith("%%bash") && !content.endsWith("*** End Patch\nEOF")
					const editToolTitle = isApplyingPatch
						? `${actor} đang tạo patch sửa file này:`
						: `${actor} muốn sửa file này:`
					const isPurposeLockDenied =
						tool?.content?.includes("purpose_lock_denied") ||
						tool?.diff?.includes("purpose_lock_denied") ||
						Boolean(tool.path && tool.path.includes(".orvanta/org/agents") && tool.path.endsWith("profile.md"))
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								<PencilIcon {...CHAT_ROW_LUCIDE} className="shrink-0" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
								<span className={CHAT_HEADER_TITLE}>{editToolTitle}</span>
							</div>
							{isPurposeLockDenied && (
								<div className="rounded border border-rose-500/40 bg-rose-500/15 p-2.5 text-xs flex flex-col gap-1 my-2">
									<div className="flex items-center gap-2 font-semibold text-rose-400">
										<span>🔒</span>
										<span>Từ chối chỉnh sửa: File được bảo vệ bởi Purpose-Lock</span>
									</div>
									<div className={CHAT_HEADER_META}>
										Tác nhân không được phép tự ý thay đổi file cấu hình/hồ sơ <code>{tool.path}</code>. Hành
										động đã bị hệ thống bảo mật chặn lại.
									</div>
								</div>
							)}
							{backgroundEditEnabled && tool.path && (tool.diff || tool.content) ? (
								<DiffEditRow
									canOpenFile={!currentCloudTask}
									isLoading={message.partial}
									patch={tool.diff || tool.content!}
									path={tool.path}
									startLineNumbers={tool.startLineNumbers}
								/>
							) : (
								<CodeAccordian
									// isLoading={message.partial}
									code={tool.content}
									isExpanded={isExpanded}
									onToggleExpand={handleToggle}
									path={tool.path!}
								/>
							)}
						</div>
					)
				case "fileDeleted":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								<SquareMinusIcon {...CHAT_ROW_LUCIDE} className="shrink-0" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
								<span className={CHAT_HEADER_TITLE}>{actor} wants to delete this file:</span>
							</div>
							<CodeAccordian
								// isLoading={message.partial}
								code={tool.content}
								isExpanded={isExpanded}
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "newFileCreated":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								<FilePlus2Icon {...CHAT_ROW_LUCIDE} className="shrink-0" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
								<span className={CHAT_HEADER_TITLE}>{actor} wants to create a new file:</span>
							</div>
							{backgroundEditEnabled && tool.path && tool.content ? (
								<DiffEditRow
									canOpenFile={!currentCloudTask}
									patch={tool.content}
									path={tool.path}
									startLineNumbers={tool.startLineNumbers}
								/>
							) : (
								<CodeAccordian
									code={tool.content!}
									isExpanded={isExpanded}
									isLoading={message.partial}
									onToggleExpand={handleToggle}
									path={tool.path!}
								/>
							)}
						</div>
					)
				case "readFile":
					const isImage = isImageFile(tool.path || "")
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								{isImage ? (
									<ImageUpIcon {...CHAT_ROW_LUCIDE} className="shrink-0" />
								) : (
									<FileCode2Icon {...CHAT_ROW_LUCIDE} className="shrink-0" />
								)}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
								<span className={CHAT_HEADER_TITLE}>{actor} wants to read this file:</span>
							</div>
							<div className="bg-code rounded-sm overflow-hidden border border-editor-group-border">
								<div
									className={cn("text-description flex items-center cursor-pointer select-none py-2 px-2.5", {
										"cursor-default select-text": isImage,
									})}
									onClick={() => {
										if (!isImage) {
											FileServiceClient.openFile(StringRequest.create({ value: tool.content })).catch(
												(err) => console.error("Failed to open file:", err),
											)
										}
									}}>
									{tool.path?.startsWith(".") && <span>.</span>}
									{tool.path && !tool.path.startsWith(".") && <span>/</span>}
									<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis mr-2 text-left [direction: rtl]">
										{`${cleanPathPrefix(tool.path ?? "")}\u200E`}
										{tool.readLineStart != null ? (
											<span className="opacity-80">
												{" "}
												({tool.readLineStart}
												{tool.readLineEnd != null ? `-${tool.readLineEnd}` : "+"})
											</span>
										) : null}
									</span>
									<div className="grow" />
									{!isImage && <SquareArrowOutUpRightIcon {...CHAT_ROW_LUCIDE} className="shrink-0" />}
								</div>
							</div>
						</div>
					)
				case "listFilesTopLevel":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								{toolIcon("folder-opened")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
								<span className={CHAT_HEADER_TITLE}>
									{message.type === "ask"
										? `${actor} wants to view the top level files in this directory:`
										: `${actor} viewed the top level files in this directory:`}
								</span>
							</div>
							<CodeAccordian
								code={tool.content!}
								isExpanded={isExpanded}
								language="shell-session"
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "listFilesRecursive":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								{toolIcon("folder-opened")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
								<span className={CHAT_HEADER_TITLE}>
									{message.type === "ask"
										? `${actor} wants to recursively view all files in this directory:`
										: `${actor} recursively viewed all files in this directory:`}
								</span>
							</div>
							<CodeAccordian
								code={tool.content!}
								isExpanded={isExpanded}
								language="shell-session"
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "listCodeDefinitionNames":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								{toolIcon("file-code")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This file is outside of your workspace")}
								<span className={CHAT_HEADER_TITLE}>
									{message.type === "ask"
										? `${actor} wants to view source code definition names used in this directory:`
										: `${actor} viewed source code definition names used in this directory:`}
								</span>
							</div>
							<CodeAccordian
								code={tool.content!}
								isExpanded={isExpanded}
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "searchFiles":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								{toolIcon("search")}
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This is outside of your workspace")}
								<span className={CHAT_HEADER_TITLE}>
									{actor} wants to search this directory for <code className="break-all">{tool.regex}</code>:
								</span>
							</div>
							<SearchResultsDisplay
								content={tool.content!}
								filePattern={tool.filePattern}
								isExpanded={isExpanded}
								onToggleExpand={handleToggle}
								path={tool.path!}
							/>
						</div>
					)
				case "summarizeTask":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								<FoldVerticalIcon {...CHAT_ROW_LUCIDE} className="shrink-0" />
								<span className={CHAT_HEADER_TITLE}>{actor} is condensing the conversation:</span>
							</div>
							<div className="bg-code overflow-hidden border border-editor-group-border rounded-[3px]">
								<div
									aria-label={isExpanded ? "Collapse summary" : "Expand summary"}
									className="text-description py-2 px-2.5 cursor-pointer select-none"
									onClick={handleToggle}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											e.stopPropagation()
											handleToggle()
										}
									}}>
									{isExpanded ? (
										<div>
											<div className="flex items-center mb-2">
												<span className={`${CHAT_HEADER_TITLE} mr-1`}>Summary:</span>
												<div className="grow" />
												<ChevronDownIcon {...CHAT_ROW_LUCIDE} className="my-0.5 shrink-0" />
											</div>
											<span className="ph-no-capture wrap-break-word whitespace-pre-wrap">
												{tool.content}
											</span>
										</div>
									) : (
										<div className="flex items-center">
											<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis text-left flex-1 mr-2 [direction:rtl]">
												{`${tool.content}\u200E`}
											</span>
											<ChevronRightIcon {...CHAT_ROW_LUCIDE} className="my-0.5 shrink-0" />
										</div>
									)}
								</div>
							</div>
						</div>
					)
				case "webFetch":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								<Link2Icon {...CHAT_ROW_LUCIDE} className="shrink-0" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This URL is external")}
								<span className={CHAT_HEADER_TITLE}>
									{message.type === "ask"
										? `${actor} wants to fetch content from this URL:`
										: `${actor} fetched content from this URL:`}
								</span>
							</div>
							<div
								className="bg-code rounded-xs overflow-hidden border border-editor-group-border py-2 px-2.5 cursor-pointer select-none"
								onClick={() => {
									// Open the URL in the default browser using gRPC
									if (tool.path) {
										UiServiceClient.openUrl(StringRequest.create({ value: tool.path })).catch((err) => {
											console.error("Failed to open URL:", err)
										})
									}
								}}>
								<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis mr-2 [direction:rtl] text-left text-link underline">
									{`${tool.path}\u200E`}
								</span>
							</div>
						</div>
					)
				case "webSearch":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								<SearchIcon {...CHAT_ROW_LUCIDE} className="rotate-90 shrink-0" />
								{tool.operationIsLocatedInWorkspace === false &&
									toolIcon("sign-out", "yellow", -90, "This search is external")}
								<span className={CHAT_HEADER_TITLE}>
									{message.type === "ask"
										? `${actor} wants to search the web for:`
										: `${actor} searched the web for:`}
								</span>
							</div>
							<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs select-text py-2.25 px-2.5">
								<span className="ph-no-capture whitespace-nowrap overflow-hidden text-ellipsis mr-2 text-left [direction:rtl]">
									{`${tool.path}\u200E`}
								</span>
							</div>
						</div>
					)
				case "useSkill":
					return (
						<div>
							<div className={CHAT_HEADER_ROW}>
								<LightbulbIcon {...CHAT_ROW_LUCIDE} className="shrink-0" />
								<span className={CHAT_HEADER_TITLE}>{actor} đã nạp kỹ năng:</span>
							</div>
							<div className="bg-code border border-editor-group-border overflow-hidden rounded-xs py-2.25 px-2.5">
								<span className="ph-no-capture font-medium">{tool.path}</span>
							</div>
						</div>
					)
				case "team_run_task": {
					return (
						<TeamRunTaskCard
							message={message}
							omitDomId={isStickyClone}
							selectedAgentId={selectedAgentId}
							tool={tool}
							type="assign"
						/>
					)
				}
				case "orvanta_submit_handoff": {
					return (
						<TeamRunTaskCard
							message={message}
							omitDomId={isStickyClone}
							selectedAgentId={selectedAgentId}
							tool={tool}
							type="handoff"
						/>
					)
				}
				case "team_send_message": {
					return (
						<TeamRunTaskCard
							message={message}
							omitDomId={isStickyClone}
							selectedAgentId={selectedAgentId}
							tool={tool}
							type="message"
						/>
					)
				}
				case "orvanta_request_decision": {
					let parsed: any = {}
					try {
						parsed = JSON.parse(tool.content || "{}")
					} catch {}
					const decTitle = parsed.title || tool.path || "Quyết định mới"
					return (
						<div className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-xs flex items-center justify-between gap-2 my-1">
							<div className="flex items-center gap-1.5 min-w-0">
								<span className="text-amber-400">📬</span>
								<span className="truncate">
									Xin CEO: <strong>{decTitle}</strong>
								</span>
							</div>
							<button
								className="rounded bg-amber-500/20 px-2 py-0.5 text-[11px] text-amber-300 hover:bg-amber-500/30 shrink-0 cursor-pointer"
								onClick={() => {
									window.postMessage(
										{
											type: "orvanta_switch_tab",
											tab: "inbox",
											focusDecision: parsed.decisionId || tool.path,
										},
										"*",
									)
								}}
								type="button">
								Xem Inbox
							</button>
						</div>
					)
				}
				default: {
					if (tool.content?.includes("purpose_lock_denied") || tool.diff?.includes("purpose_lock_denied")) {
						let reason = ""
						try {
							const parsed = JSON.parse(tool.content || "{}")
							reason = parsed.reason || ""
						} catch {}
						return (
							<div className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-xs flex items-center justify-between gap-2 my-1">
								<div className="flex items-center gap-1.5 min-w-0">
									<span className="text-rose-400">🔒</span>
									<span className="truncate">
										Bị khóa: <strong>{tool.tool}</strong> {tool.path ? `· ${tool.path}` : ""}
									</span>
								</div>
								{reason && <span className="text-[11px] text-muted-foreground truncate">{reason}</span>}
							</div>
						)
					}
					return <InvisibleSpacer />
				}
			}
		}

		if (message.ask === "command" || message.say === "command") {
			return (
				<CommandOutputRow
					icon={icon}
					isBackgroundExec={vscodeTerminalExecutionMode === "backgroundExec"}
					isCommandCompleted={isCommandCompleted}
					isCommandExecuting={isCommandExecuting}
					isCommandPending={isCommandPending}
					isOutputFullyExpanded={isOutputFullyExpanded}
					message={message}
					onCancelCommand={onCancelCommand}
					onOutputChange={onLastRowContentChange}
					setIsOutputFullyExpanded={setIsOutputFullyExpanded}
					title={title}
				/>
			)
		}

		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
		}

		if (message.ask === "use_mcp_server" || message.say === "use_mcp_server") {
			const useMcpServer = JSON.parse(message.text || "{}") as ClineAskUseMcpServer
			const server = mcpServers.find((server) => server.name === useMcpServer.serverName)
			return (
				<div>
					<div className={CHAT_HEADER_ROW}>
						{icon}
						{title}
					</div>

					<div className="bg-code rounded-xs py-2 px-2.5 mt-2">
						{useMcpServer.type === "access_mcp_resource" && (
							<McpResourceRow
								item={{
									...(findMatchingResourceOrTemplate(
										useMcpServer.uri || "",
										server?.resources,
										server?.resourceTemplates,
									) || {
										name: "",
										mimeType: "",
										description: "",
									}),
									uri: useMcpServer.uri || "",
								}}
							/>
						)}

						{useMcpServer.type === "use_mcp_tool" && (
							<div>
								<div onClick={(e) => e.stopPropagation()}>
									<McpToolRow
										serverName={useMcpServer.serverName}
										tool={{
											name: useMcpServer.toolName || "",
											description:
												server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.description ||
												"",
											autoApprove:
												server?.tools?.find((tool) => tool.name === useMcpServer.toolName)?.autoApprove ||
												false,
										}}
									/>
								</div>
								{useMcpServer.arguments && useMcpServer.arguments !== "{}" && (
									<div className="mt-2">
										<div className="mb-1 opacity-80 uppercase">Arguments</div>
										<CodeAccordian
											code={useMcpServer.arguments}
											isExpanded={true}
											language="json"
											onToggleExpand={handleToggle}
										/>
									</div>
								)}
							</div>
						)}
					</div>
				</div>
			)
		}

		switch (message.type) {
			case "say":
				switch (message.say) {
					case "api_req_started":
						return (
							<RequestStartRow
								apiReqStreamingFailedMessage={apiReqStreamingFailedMessage}
								apiRequestFailedMessage={apiRequestFailedMessage}
								clineMessages={clineMessages}
								cost={cost}
								handleToggle={handleToggle}
								isExpanded={isExpanded}
								message={message}
								mode={mode}
								reasoningContent={reasoningContent}
								responseStarted={responseStarted}
								retryFailedRequest={retryFailedRequest}
							/>
						)
					case "api_req_finished":
						return <InvisibleSpacer /> // we should never see this message type
					case "mcp_server_response":
						return <McpResponseDisplay responseText={message.text || ""} />
					case "mcp_notification":
						return (
							<div className="flex items-start gap-2 py-2.5 px-3 bg-quote rounded-sm text-base text-foreground opacity-90 mb-2">
								<BellIcon {...CHAT_ROW_LUCIDE} className="mt-0.5 shrink-0 text-notification-foreground" />
								<div className="wrap-break-word flex-1">
									<span className="font-medium">MCP Notification: </span>
									<span className="ph-no-capture">{message.text}</span>
								</div>
							</div>
						)
					case "text": {
						const hasText = !!message.text?.trim()
						return (
							<WithCopyButton
								onMouseUp={handleMouseUp}
								position="bottom-right"
								ref={contentRef}
								textToCopy={message.text}>
								{hasText && (
									<div className="flex items-center">
										<div className={cn("flex-1 min-w-0 pl-1")}>
											<MarkdownRow markdown={message.text} showCursor={false} />
										</div>
									</div>
								)}
								{!!message.images?.length && (
									<Thumbnails className={hasText ? "mt-2" : undefined} files={[]} images={message.images} />
								)}
								{!!message.media?.length && (
									<div className={cn("flex flex-col gap-2", hasText && "mt-2")}>
										{message.media.map((media) => (
											<GeneratedMediaContent
												className="max-h-96 max-w-full rounded-sm"
												key={media.id}
												media={media}
											/>
										))}
									</div>
								)}
								{quoteButtonState.visible && (
									<QuoteButton
										left={quoteButtonState.left}
										onClick={handleQuoteClick}
										top={quoteButtonState.top}
									/>
								)}
							</WithCopyButton>
						)
					}
					case "reasoning": {
						const isReasoningStreaming = message.partial === true
						const hasReasoningText = !!message.text?.trim()
						// Show feature tips throughout the entire thinking/reasoning phase
						const _showFeatureTip = isReasoningStreaming
						return (
							<div>
								<ThinkingRow
									agentDisplayName={message.agentDisplayName ?? message.agent_display_name}
									agentId={message.agentId ?? message.agent_id}
									agentRole={message.agentRole ?? message.agent_role}
									isExpanded={(isReasoningStreaming && hasReasoningText) || isExpanded}
									isStreaming={isReasoningStreaming}
									isVisible={true}
									onToggle={isReasoningStreaming ? undefined : handleToggle}
									reasoningContent={message.text}
									showChevron={!isReasoningStreaming || hasReasoningText}
									showTitle={true}
									title={isReasoningStreaming ? "Thinking..." : "Thinking"}
								/>
								{isReasoningStreaming && showFeatureTips === true && <FeatureTip />}
							</div>
						)
					}
					case "user_feedback":
						return (
							<UserMessage
								canRestoreWorkspace={
									!currentCloudTask && canRestoreWorkspaceFromMessage(clineMessages, message.ts)
								}
								files={message.files}
								// Edit-and-regenerate rebuilds the conversation as a local session, which
								// a cloud task cannot use; without a timestamp the row is read-only.
								images={message.images}
								messageTs={currentCloudTask ? undefined : message.ts}
								sendMessageFromChatRow={sendMessageFromChatRow}
								text={message.text}
							/>
						)
					case "user_feedback_diff":
						const tool = JSON.parse(message.text || "{}") as ClineSayTool
						return (
							<div className="w-full -mt-2.5">
								<CodeAccordian
									diff={tool.diff!}
									isExpanded={isExpanded}
									isFeedback={true}
									onToggleExpand={handleToggle}
								/>
							</div>
						)
					case "error":
						return <ErrorRow errorType="error" message={message} retryFailedRequest={retryFailedRequest} />
					case "diff_error":
						return <ErrorRow errorType="diff_error" message={message} />
					case "clineignore_error":
						return <ErrorRow errorType="clineignore_error" message={message} />
					case "load_mcp_documentation":
						return (
							<div className="text-foreground flex items-center opacity-70 text-[12px] py-1 px-0">
								<i className="codicon codicon-book mr-1.5" />
								Loading MCP documentation
							</div>
						)
					case "completion_result": {
						// Strip the legacy HAS_CHANGES sentinel that pre-SDK versions
						// persisted on completion message text.
						const hasLegacyChangesFlag = message.text?.endsWith(COMPLETION_RESULT_CHANGES_FLAG) ?? false
						const text = hasLegacyChangesFlag
							? message.text?.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length)
							: message.text

						return (
							<CompletionOutputRow
								handleQuoteClick={handleQuoteClick}
								quoteButtonState={quoteButtonState}
								showViewChanges={isLast && enableCheckpointsSetting}
								text={text || ""}
							/>
						)
					}
					case "plan_completion_result":
						// Turn-final plan-mode response inferred at turn end (SDK path)
						return <PlanCompletionOutputRow text={message.text || ""} />
					case "shell_integration_warning":
						return (
							<div className="flex flex-col bg-warning/20 p-2 rounded-xs border border-error">
								<div className="flex items-center mb-1">
									<TriangleAlertIcon {...CHAT_ROW_LUCIDE} className="mr-2 shrink-0 text-error" />
									<span className="font-medium text-foreground">Shell Integration Unavailable</span>
								</div>
								<div className="text-foreground opacity-80">
									Cline may have trouble viewing the command's output. Please update VSCode (
									<code>CMD/CTRL + Shift + P</code> → "Update") and make sure you're using a supported shell:
									zsh, bash, fish, or PowerShell (<code>CMD/CTRL + Shift + P</code> → "Terminal: Select Default
									Profile").
									<a
										className="px-1"
										href="https://github.com/cline/cline/wiki/Troubleshooting-%E2%80%90-Shell-Integration-Unavailable">
										Still having trouble?
									</a>
								</div>
							</div>
						)
					case "hook_status":
						return <HookMessage CommandOutput={CommandOutputContent} message={message} />
					case "hook_output_stream":
						// hook_output_stream messages are combined with hook_status messages, so we don't render them separately
						return <InvisibleSpacer />
					case "subagent":
						return <SubagentStatusRow isLast={isLast} lastModifiedMessage={lastModifiedMessage} message={message} />
					case "shell_integration_warning_with_suggestion":
						const isBackgroundModeEnabled = vscodeTerminalExecutionMode === "backgroundExec"
						return (
							<div className="p-2 bg-link/10 border border-link/30 rounded-xs">
								<div className="flex items-center mb-1">
									<LightbulbIcon {...CHAT_ROW_LUCIDE} className="mr-1.5 shrink-0 text-link" />
									<span className="font-medium text-foreground">Shell integration issues</span>
								</div>
								<div className="text-foreground opacity-90 mb-2">
									Since you're experiencing repeated shell integration issues, we recommend switching to
									Background Terminal mode for better reliability.
								</div>
								<button
									className={cn(
										"bg-button-background text-button-foreground border-0 rounded-xs py-1.5 px-3 text-[12px] flex items-center gap-1.5 cursor-pointer hover:bg-button-hover",
										{
											"cursor-default opacity-80 bg-success": isBackgroundModeEnabled,
										},
									)}
									disabled={isBackgroundModeEnabled}
									onClick={async () => {
										try {
											// Enable background terminal execution mode
											await UiServiceClient.setTerminalExecutionMode(BooleanRequest.create({ value: true }))
										} catch (error) {
											console.error("Failed to enable background terminal:", error)
										}
									}}>
									<SettingsIcon {...CHAT_ROW_LUCIDE} className="shrink-0" />
									{isBackgroundModeEnabled
										? "Background Terminal Enabled"
										: "Enable Background Terminal (Recommended)"}
								</button>
							</div>
						)
					case "compaction":
						return <CompactionRow message={message} />
					case "cloud_provisioning":
						return <CloudProvisioningRow active={lastModifiedMessage?.ts === message.ts} message={message} />
					default:
						return (
							<div>
								{title && (
									<div className={CHAT_HEADER_ROW}>
										{icon}
										{title}
									</div>
								)}
								<div className="pt-1">
									<MarkdownRow markdown={message.text} />
								</div>
							</div>
						)
				}
			case "ask":
				switch (message.ask) {
					case "mistake_limit_reached":
						return (
							<ErrorRow
								errorType="mistake_limit_reached"
								message={message}
								retryFailedRequest={retryFailedRequest}
							/>
						)
					case "completion_result":
						if (message.text) {
							const hasChanges = message.text.endsWith(COMPLETION_RESULT_CHANGES_FLAG) ?? false
							const text = hasChanges ? message.text.slice(0, -COMPLETION_RESULT_CHANGES_FLAG.length) : message.text
							return (
								<CompletionOutputRow
									handleQuoteClick={handleQuoteClick}
									quoteButtonState={quoteButtonState}
									text={text || ""}
								/>
							)
						}
						// Virtuoso cannot handle zero-height items; render a spacer instead of null
						return <InvisibleSpacer />
					case "followup":
						let question: string | undefined
						let options: string[] | undefined
						let selected: string | undefined
						try {
							const parsedMessage = JSON.parse(message.text || "{}") as ClineAskQuestion
							question = parsedMessage.question
							options = parsedMessage.options
							selected = parsedMessage.selected
						} catch (_e) {
							// legacy messages would pass question directly
							question = message.text
						}

						return (
							<div>
								{title && (
									<div className={CHAT_HEADER_ROW}>
										{icon}
										{title}
									</div>
								)}
								<WithCopyButton
									className="pt-1"
									onMouseUp={handleMouseUp}
									position="bottom-right"
									ref={contentRef}
									textToCopy={question}>
									<MarkdownRow markdown={question} />
									{quoteButtonState.visible && (
										<QuoteButton
											left={quoteButtonState.left}
											onClick={() => {
												handleQuoteClick()
											}}
											top={quoteButtonState.top}
										/>
									)}
								</WithCopyButton>
								<div className="pt-3">
									<OptionsButtons
										inputValue={inputValue}
										isActive={isOptionsAskActive(message, turnState, isLast, lastModifiedMessage)}
										options={options}
										selected={selected}
									/>
								</div>
							</div>
						)
					case "new_task":
						return (
							<div>
								<div className={CHAT_HEADER_ROW}>
									<FilePlus2Icon {...CHAT_ROW_LUCIDE} className="shrink-0" />
									<span className={CHAT_HEADER_TITLE}>Cline wants to start a new task:</span>
								</div>
								<NewTaskPreview context={message.text || ""} />
							</div>
						)
					case "condense":
						return (
							<div>
								<div className={CHAT_HEADER_ROW}>
									<FilePlus2Icon {...CHAT_ROW_LUCIDE} className="shrink-0" />
									<span className={CHAT_HEADER_TITLE}>Cline wants to condense your conversation:</span>
								</div>
								<NewTaskPreview context={message.text || ""} />
							</div>
						)
					case "report_bug":
						return (
							<div>
								<div className={CHAT_HEADER_ROW}>
									<FilePlus2Icon {...CHAT_ROW_LUCIDE} className="shrink-0" />
									<span className={CHAT_HEADER_TITLE}>Cline wants to create a Github issue:</span>
								</div>
								<ReportBugPreview data={message.text || ""} />
							</div>
						)
					case "plan_mode_respond": {
						let response: string | undefined
						let options: string[] | undefined
						let selected: string | undefined
						try {
							const parsedMessage = JSON.parse(message.text || "{}") as ClinePlanModeResponse
							response = parsedMessage.response
							options = parsedMessage.options
							selected = parsedMessage.selected
						} catch (_e) {
							// legacy messages would pass response directly
							response = message.text
						}
						return (
							<div>
								<PlanCompletionOutputRow text={response || message.text || ""} />
								<OptionsButtons
									inputValue={inputValue}
									isActive={isOptionsAskActive(message, turnState, isLast, lastModifiedMessage)}
									options={options}
									selected={selected}
								/>
							</div>
						)
					}
					default:
						return <InvisibleSpacer />
				}
		}
	},
)
