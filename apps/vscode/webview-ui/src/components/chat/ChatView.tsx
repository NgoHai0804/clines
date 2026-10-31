import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import { combineHookSequences } from "@shared/combineHookSequences"
import { getApiMetrics, getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { BooleanRequest, StringRequest } from "@shared/proto/cline/common"
import type { OrvantaRosterAgent } from "@shared/proto/cline/orvanta"
import { AskResponseRequest } from "@shared/proto/cline/task"
import { useCallback, useEffect, useMemo, useRef } from "react"
import { useMount } from "react-use"
import { AgentBadge } from "@/components/common/AgentBadge"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useShowNavbar } from "@/context/PlatformContext"
import { useNormalizedApiConfiguration } from "@/hooks/useNormalizedApiConfiguration"
import { FileServiceClient, TaskServiceClient, UiServiceClient } from "@/services/grpc-client"
import { Navbar } from "../menu/Navbar"
// Import utilities and hooks from the new structure
import {
	ActionButtons,
	CHAT_CONSTANTS,
	ChatLayout,
	convertHtmlToMarkdown,
	filterVisibleMessages,
	groupLowStakesTools,
	groupMessages,
	InputSection,
	MessagesArea,
	QueuedPrompts,
	TaskSection,
	useChatState,
	useMessageHandlers,
	useScrollBehavior,
	WelcomeSection,
} from "./chat-view"
import { filterMessagesForAgentChannel, resolveAgentChannelTaskHeader } from "./chat-view/utils/filterAgentChannelMessages"
import { isAgentTurnFinished } from "./chat-view/utils/isAgentTurnFinished"
import {
	hasPendingMessageConfirmation,
	isPendingResponseUnconfirmed,
	withPendingUserMessage,
} from "./chat-view/utils/pendingResponse"

interface ChatViewProps {
	isHidden: boolean
	showAnnouncement: boolean
	hideAnnouncement: () => void
	showHistoryView: () => void
	focusAgent?: OrvantaRosterAgent
	onResetFocusAgent?: () => void
	contextTask?: { id: string; title: string }
	contextDecision?: { id: string; title: string }
	onClearContextTask?: () => void
	onClearContextDecision?: () => void
	/** Viewing a reopened history/CEO session — teammate transcripts may lack agentId stamps. */
	historyBrowse?: boolean
}

// Use constants from the imported module
const MAX_IMAGES_AND_FILES_PER_MESSAGE = CHAT_CONSTANTS.MAX_IMAGES_AND_FILES_PER_MESSAGE
const QUICK_WINS_HISTORY_THRESHOLD = 3

const ChatView = ({
	isHidden,
	showAnnouncement,
	hideAnnouncement,
	showHistoryView,
	focusAgent,
	onResetFocusAgent,
	contextTask,
	contextDecision,
	onClearContextTask,
	onClearContextDecision,
	historyBrowse = false,
}: ChatViewProps) => {
	const showNavbar = useShowNavbar()
	const {
		version,
		clineMessages: messages,
		taskHistory,
		telemetrySetting,
		mode,
		userInfo,
		hooksEnabled,
		checkpointRestoreInput,
		queuedPrompts,
		turnState,
		cloudSessionsEnabled,
		cloudTaskTarget,
		currentCloudTask,
	} = useExtensionState()
	const isProdHostedApp = userInfo?.apiBaseUrl === "https://app.cline.bot"
	const shouldShowQuickWins = isProdHostedApp && (!taskHistory || taskHistory.length < QUICK_WINS_HISTORY_THRESHOLD)

	// Use custom hooks for state management
	const chatState = useChatState(messages)
	const {
		setInputValue,
		selectedImages,
		setSelectedImages,
		selectedFiles,
		setSelectedFiles,
		sendingDisabled,
		enableButtons,
		expandedRows,
		setExpandedRows,
		pendingUserMessage,
		setPendingUserMessage,
		pendingResponse,
		setPendingResponse,
		textAreaRef,
	} = chatState

	const selectedAgentId = focusAgent?.id

	const displayMessages = useMemo(() => {
		const raw = withPendingUserMessage(messages, pendingUserMessage)
		const filtered = filterMessagesForAgentChannel(raw, selectedAgentId, {
			includeUnattributedForTeammate: historyBrowse,
		})
		// Stable chronological order — CEO 1:1 bubbles must stay above the agent replies
		// they triggered even when pending/partial rows arrive out of sequence.
		return filtered
			.map((message, index) => ({ message, index }))
			.sort((a, b) => a.message.ts - b.message.ts || a.index - b.index)
			.map(({ message }) => message)
	}, [messages, pendingUserMessage, selectedAgentId, historyBrowse])

	useEffect(() => {
		if (pendingUserMessage && hasPendingMessageConfirmation(messages, pendingUserMessage)) {
			setPendingUserMessage((current) => (current === pendingUserMessage ? undefined : current))
		}
	}, [messages, pendingUserMessage, setPendingUserMessage])

	// Orvanta: no Resume Task button. Unexpected interrupts (mode rebuild, history reopen)
	// land in phase "resumable" — continue automatically once per turn seq.
	// Never auto-rerun when the agent already finished (green COMPLETED); the user must
	// send a new message to continue.
	const autoResumedSeqRef = useRef<number | null>(null)
	useEffect(() => {
		if (isHidden || turnState?.phase !== "resumable") {
			return
		}
		if (isAgentTurnFinished(messages)) {
			return
		}
		const seq = turnState.seq ?? 0
		if (autoResumedSeqRef.current === seq) {
			return
		}
		autoResumedSeqRef.current = seq
		void TaskServiceClient.askResponse(AskResponseRequest.create({ responseType: "yesButtonClicked" })).catch((err) =>
			console.error("Failed to auto-resume interrupted task:", err),
		)
	}, [isHidden, turnState?.phase, turnState?.seq, messages])

	useEffect(() => {
		if (!pendingResponse || isPendingResponseUnconfirmed(pendingResponse, turnState, messages.length)) {
			return
		}
		setPendingResponse((current) => (current?.id === pendingResponse.id ? undefined : current))
	}, [messages.length, pendingResponse, setPendingResponse, turnState])

	// Agent channels drop say:"task"; never promote a coordination tool's JSON into TaskHeader.
	// When the first row is already a task/message card, suppress the duplicate TaskHeader bubble.
	const { task, bodyStartIndex, suppressTaskHeader } = useMemo(
		() => resolveAgentChannelTaskHeader(displayMessages),
		[displayMessages],
	)

	// [+] / clearTask leaves ChatView mounted — drop optimistic CEO bubbles so the blank
	// tab does not keep painting the previous session's pending steer. Only gate on an
	// empty host transcript; placeholder task headers are still truthy objects.
	useEffect(() => {
		if (messages.length === 0) {
			setPendingUserMessage(undefined)
			setPendingResponse(undefined)
		}
	}, [messages.length, setPendingUserMessage, setPendingResponse])
	const modifiedMessages = useMemo(() => {
		const slicedMessages = displayMessages.slice(bodyStartIndex)
		// Only combine hook sequences if hooks are enabled
		const withHooks = hooksEnabled ? combineHookSequences(slicedMessages) : slicedMessages
		return combineApiRequests(combineCommandSequences(withHooks))
	}, [displayMessages, bodyStartIndex, hooksEnabled])
	// has to be after api_req_finished are all reduced into api_req_started messages
	const apiMetrics = useMemo(() => getApiMetrics(modifiedMessages), [modifiedMessages])

	const lastApiReqTotalTokens = useMemo(() => getLastApiReqTotalTokens(modifiedMessages) || undefined, [modifiedMessages])
	const lastAppliedCheckpointRestoreSessionId = useRef<string | undefined>(checkpointRestoreInput?.sessionId)

	useEffect(() => {
		if (!checkpointRestoreInput || checkpointRestoreInput.sessionId === lastAppliedCheckpointRestoreSessionId.current) {
			return
		}
		lastAppliedCheckpointRestoreSessionId.current = checkpointRestoreInput.sessionId
		setInputValue(checkpointRestoreInput.text)
		setSelectedImages(checkpointRestoreInput.images ?? [])
		setSelectedFiles(checkpointRestoreInput.files ?? [])
		setTimeout(() => {
			textAreaRef.current?.focus()
		}, 0)
	}, [checkpointRestoreInput, setInputValue, setSelectedImages, setSelectedFiles, textAreaRef])

	useEffect(() => {
		const handleCopy = async (e: ClipboardEvent) => {
			const targetElement = e.target as HTMLElement | null
			// If the copy event originated from an input or textarea,
			// let the default browser behavior handle it.
			if (
				targetElement &&
				(targetElement.tagName === "INPUT" || targetElement.tagName === "TEXTAREA" || targetElement.isContentEditable)
			) {
				return
			}

			if (window.getSelection) {
				const selection = window.getSelection()
				if (selection && selection.rangeCount > 0) {
					const range = selection.getRangeAt(0)
					const commonAncestor = range.commonAncestorContainer
					let textToCopy: string | null = null

					// Check if the selection is inside an element where plain text copy is preferred
					let currentElement =
						commonAncestor.nodeType === Node.ELEMENT_NODE
							? (commonAncestor as HTMLElement)
							: commonAncestor.parentElement
					let preferPlainTextCopy = false
					while (currentElement) {
						if (currentElement.tagName === "PRE" && currentElement.querySelector("code")) {
							preferPlainTextCopy = true
							break
						}
						// Check computed white-space style
						const computedStyle = window.getComputedStyle(currentElement)
						if (
							computedStyle.whiteSpace === "pre" ||
							computedStyle.whiteSpace === "pre-wrap" ||
							computedStyle.whiteSpace === "pre-line"
						) {
							// If the element itself or an ancestor has pre-like white-space,
							// and the selection is likely contained within it, prefer plain text.
							// This helps with elements like the TaskHeader's text display.
							preferPlainTextCopy = true
							break
						}

						// Stop searching if we reach a known chat message boundary or body
						if (
							currentElement.classList.contains("chat-row-assistant-message-container") ||
							currentElement.classList.contains("chat-row-user-message-container") ||
							currentElement.tagName === "BODY"
						) {
							break
						}
						currentElement = currentElement.parentElement
					}

					if (preferPlainTextCopy) {
						// For code blocks or elements with pre-formatted white-space, get plain text.
						textToCopy = selection.toString()
					} else {
						// For other content, use the existing HTML-to-Markdown conversion
						const clonedSelection = range.cloneContents()
						const div = document.createElement("div")
						div.appendChild(clonedSelection)
						const selectedHtml = div.innerHTML
						textToCopy = await convertHtmlToMarkdown(selectedHtml)
					}

					if (textToCopy !== null) {
						try {
							FileServiceClient.copyToClipboard(StringRequest.create({ value: textToCopy })).catch((err) => {
								console.error("Error copying to clipboard:", err)
							})
							e.preventDefault()
						} catch (error) {
							console.error("Error copying to clipboard:", error)
						}
					}
				}
			}
		}
		document.addEventListener("copy", handleCopy)

		return () => {
			document.removeEventListener("copy", handleCopy)
		}
	}, [])
	// Button state is now managed by useButtonState hook

	// handleFocusChange is already provided by chatState

	// Use message handlers hook
	const messageHandlers = useMessageHandlers(messages, chatState, focusAgent)

	const { selectedModelInfo } = useNormalizedApiConfiguration(mode)

	// Cloud sandboxes cannot read local files; only images (sent inline) can be attached.
	const imagesOnly =
		!!currentCloudTask || (messages.length === 0 && cloudSessionsEnabled && cloudTaskTarget?.target === "cloud")

	const selectFilesAndImages = useCallback(async () => {
		try {
			const response = await FileServiceClient.selectFiles(
				BooleanRequest.create({
					value: selectedModelInfo.supportsImages,
				}),
			)
			if (response && imagesOnly) {
				response.values2 = []
			}
			if (
				response &&
				response.values1 &&
				response.values2 &&
				(response.values1.length > 0 || response.values2.length > 0)
			) {
				const currentTotal = selectedImages.length + selectedFiles.length
				const availableSlots = MAX_IMAGES_AND_FILES_PER_MESSAGE - currentTotal

				if (availableSlots > 0) {
					// Prioritize images first
					const imagesToAdd = Math.min(response.values1.length, availableSlots)
					if (imagesToAdd > 0) {
						setSelectedImages((prevImages) => [...prevImages, ...response.values1.slice(0, imagesToAdd)])
					}

					// Use remaining slots for files
					const remainingSlots = availableSlots - imagesToAdd
					if (remainingSlots > 0) {
						setSelectedFiles((prevFiles) => [...prevFiles, ...response.values2.slice(0, remainingSlots)])
					}
				}
			}
		} catch (error) {
			console.error("Error selecting images & files:", error)
		}
	}, [selectedModelInfo.supportsImages, imagesOnly])

	const shouldDisableFilesAndImages = selectedImages.length + selectedFiles.length >= MAX_IMAGES_AND_FILES_PER_MESSAGE

	// Subscribe to show webview events from the backend
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToShowWebview(
			{},
			{
				onResponse: (event: any) => {
					// Only focus if not hidden and preserveEditorFocus is false
					if (!isHidden && !event.preserveEditorFocus) {
						textAreaRef.current?.focus()
					}
				},
				onError: (error: any) => {
					console.error("Error in showWebview subscription:", error)
				},
				onComplete: () => {
					console.log("showWebview subscription completed")
				},
			},
		)

		return cleanup
	}, [isHidden])

	// Set up addToInput subscription
	useEffect(() => {
		const cleanup = UiServiceClient.subscribeToAddToInput(
			{},
			{
				onResponse: (event: any) => {
					if (event.value) {
						setInputValue((prevValue) => {
							const newText = event.value
							const newTextWithNewline = newText + "\n"
							return prevValue ? `${prevValue}\n${newTextWithNewline}` : newTextWithNewline
						})
						// Add scroll to bottom after state update
						// Auto focus the input and start the cursor on a new line for easy typing
						setTimeout(() => {
							if (textAreaRef.current) {
								textAreaRef.current.scrollTop = textAreaRef.current.scrollHeight
								textAreaRef.current.focus()
							}
						}, 0)
					}
				},
				onError: (error: any) => {
					console.error("Error in addToInput subscription:", error)
				},
				onComplete: () => {
					console.log("addToInput subscription completed")
				},
			},
		)

		return cleanup
	}, [])

	useMount(() => {
		// NOTE: the vscode window needs to be focused for this to work
		textAreaRef.current?.focus()
	})

	useEffect(() => {
		const timer = setTimeout(() => {
			if (!isHidden && !sendingDisabled && !enableButtons) {
				textAreaRef.current?.focus()
			}
		}, 50)
		return () => {
			clearTimeout(timer)
		}
	}, [isHidden, sendingDisabled, enableButtons])

	const visibleMessages = useMemo(() => {
		return filterVisibleMessages(modifiedMessages)
	}, [modifiedMessages])

	const groupedMessages = useMemo(() => {
		return groupLowStakesTools(groupMessages(visibleMessages))
	}, [visibleMessages])

	// Use scroll behavior hook
	const scrollBehavior = useScrollBehavior(displayMessages, visibleMessages, groupedMessages, expandedRows, setExpandedRows)
	const { scrollToBottomSmooth, scrollToBottomAuto, disableAutoScrollRef } = scrollBehavior

	// When a prompt gets queued, the queue banner mounts (or grows) in the footer, which
	// shrinks the messages area and visually covers the bottom of the conversation. No new
	// chat row is added, so the list-length-based auto-scroll never fires — re-pin to the
	// bottom here so the latest content stays visible.
	const queuedPromptCount = queuedPrompts?.length ?? 0
	const taskTs = task?.ts
	const prevQueuedPromptCountRef = useRef(queuedPromptCount)
	const prevQueuedPromptTaskTsRef = useRef(taskTs)
	useEffect(() => {
		const previousCount = prevQueuedPromptCountRef.current
		const previousTaskTs = prevQueuedPromptTaskTsRef.current
		prevQueuedPromptCountRef.current = queuedPromptCount
		prevQueuedPromptTaskTsRef.current = taskTs
		// A task switch can grow the count without a send from this webview (the newly
		// displayed task may already have queued prompts) — don't hijack its scroll position.
		if (taskTs !== previousTaskTs || queuedPromptCount <= previousCount) {
			return
		}
		// Queueing is a deliberate send, so re-engage bottom pinning like handleSendMessage does.
		disableAutoScrollRef.current = false
		scrollToBottomSmooth()
		// Settle with an instant scroll once the footer's layout change has landed.
		setTimeout(() => {
			if (!disableAutoScrollRef.current) {
				scrollToBottomAuto()
			}
		}, 50)
	}, [queuedPromptCount, taskTs, scrollToBottomSmooth, scrollToBottomAuto, disableAutoScrollRef])

	const placeholderText = useMemo(() => {
		if (focusAgent) {
			const isLead = focusAgent.role === "lead" || focusAgent.id === "coordinator"
			return isLead ? "Chỉ đạo Coordinator điều phối..." : `Chỉ đạo 1:1 tới ${focusAgent.displayName || focusAgent.id}...`
		}
		const text = task ? "Type a message..." : "Type your task here..."
		return text
	}, [task, focusAgent])

	return (
		<ChatLayout isHidden={isHidden}>
			{/* Chat Body: scrolls independently */}
			<div className="flex-1 min-h-0 w-full overflow-hidden flex flex-col relative">
				{showNavbar && <Navbar startNewTask={messageHandlers.startNewTask} />}
				{task && !suppressTaskHeader ? (
					<TaskSection apiMetrics={apiMetrics} messageHandlers={messageHandlers} task={task} />
				) : !task ? (
					<WelcomeSection
						hideAnnouncement={hideAnnouncement}
						isVisible={!isHidden}
						shouldShowQuickWins={shouldShowQuickWins}
						showAnnouncement={showAnnouncement}
						showHistoryView={showHistoryView}
						taskHistory={taskHistory}
						telemetrySetting={telemetrySetting}
						version={version}
					/>
				) : null}
				{task && (
					<MessagesArea
						chatState={chatState}
						groupedMessages={groupedMessages}
						messageHandlers={messageHandlers}
						modifiedMessages={modifiedMessages}
						scrollBehavior={scrollBehavior}
						selectedAgentId={selectedAgentId}
						task={task}
					/>
				)}
				{focusAgent && focusAgent.id !== "coordinator" && focusAgent.role !== "lead" && modifiedMessages.length === 0 && (
					<div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-xs text-muted-foreground gap-3">
						<AgentBadge
							agentId={focusAgent.id}
							displayName={focusAgent.displayName}
							role={focusAgent.role}
							size="md"
						/>
						<div className="font-semibold text-foreground text-sm">
							Kênh làm việc của {focusAgent.displayName || focusAgent.id}
						</div>
						<p className="max-w-xs text-[11px] text-muted-foreground/80">
							Chưa có nhật ký hoạt động nào từ tác nhân này trong phiên làm việc. Bạn có thể nhập tin nhắn bên dưới
							để chỉ đạo 1:1 trực tiếp qua mailbox.
						</p>
					</div>
				)}
			</div>

			{/* Chat Footer: Sát hoàn toàn với phần bên dưới */}
			<footer className="shrink-0 w-full bg-(--vscode-sideBar-background) border-t border-border-panel/40 flex flex-col z-10">
				<ActionButtons
					chatState={chatState}
					messageHandlers={messageHandlers}
					messages={displayMessages}
					mode={mode}
					task={task}
				/>
				<QueuedPrompts items={queuedPrompts} />
				<InputSection
					chatState={chatState}
					contextDecision={contextDecision}
					contextTask={contextTask}
					contextUsage={
						task
							? {
									tokensIn: apiMetrics.totalTokensIn,
									tokensOut: apiMetrics.totalTokensOut,
									cacheWrites: apiMetrics.totalCacheWrites,
									cacheReads: apiMetrics.totalCacheReads,
									lastApiReqTotalTokens,
									contextWindow: selectedModelInfo.contextWindow,
									compactDisabled: messageHandlers.errorRecoveryAvailable,
									compactTask: messageHandlers.compactTask,
								}
							: undefined
					}
					focusAgent={focusAgent}
					messageHandlers={messageHandlers}
					onClearContextDecision={onClearContextDecision}
					onClearContextTask={onClearContextTask}
					onResetFocusAgent={onResetFocusAgent}
					placeholderText={placeholderText}
					scrollBehavior={scrollBehavior}
					selectFilesAndImages={selectFilesAndImages}
					shouldDisableFilesAndImages={shouldDisableFilesAndImages}
				/>
			</footer>
		</ChatLayout>
	)
}

export default ChatView
