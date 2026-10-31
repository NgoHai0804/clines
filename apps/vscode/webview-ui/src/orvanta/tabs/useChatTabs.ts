import { EmptyRequest, StringRequest } from "@shared/proto/cline/common"
import { useCallback, useEffect, useRef, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import {
	type ChatTab,
	type ChatTabsState,
	CONSOLE_DRAFTS_STORAGE_KEY,
	CONSOLE_TABS_STORAGE_KEY,
	CONSOLE_TABS_STORAGE_KEY_V1,
	DEFAULT_TAB_TITLE,
	getTabActiveTaskId,
	MAX_DRAFT_LENGTH,
	MAX_TABS_COUNT,
} from "./types"

export interface UseChatTabsOptions {
	initialFocusAgentId?: string
	onActiveAgentChange?: (agentId: string) => void
}

function createDefaultTab(agentId = "team-feed"): ChatTab {
	const now = Date.now()
	return {
		id: `tab_${now}_${Math.random().toString(36).slice(2, 7)}`,
		title: DEFAULT_TAB_TITLE,
		activeAgentId: agentId,
		agentTasks: {},
		agentDrafts: {},
		agentIds: [agentId],
		createdAt: now,
		lastActiveAt: now,
	}
}

/**
 * Tải drafts độc lập từ localStorage với giới hạn an toàn.
 */
function loadPersistedDrafts(): Record<string, Record<string, string>> {
	if (typeof window === "undefined" || !window.localStorage) {
		return {}
	}
	try {
		const raw = localStorage.getItem(CONSOLE_DRAFTS_STORAGE_KEY)
		if (raw) {
			const parsed = JSON.parse(raw)
			if (parsed && typeof parsed === "object") {
				return parsed
			}
		}
	} catch {
		// Ignore corrupted drafts storage
	}
	return {}
}

/**
 * Lưu drafts độc lập vào localStorage với kiểm tra dung lượng.
 */
function savePersistedDrafts(draftsByTab: Record<string, Record<string, string>>) {
	if (typeof window === "undefined" || !window.localStorage) {
		return
	}
	try {
		const sanitized: Record<string, Record<string, string>> = {}
		for (const [tabId, drafts] of Object.entries(draftsByTab)) {
			if (drafts && typeof drafts === "object") {
				sanitized[tabId] = {}
				for (const [ag, text] of Object.entries(drafts)) {
					if (typeof text === "string" && text.length > 0) {
						sanitized[tabId][ag] = text.slice(0, MAX_DRAFT_LENGTH)
					}
				}
			}
		}
		localStorage.setItem(CONSOLE_DRAFTS_STORAGE_KEY, JSON.stringify(sanitized))
	} catch {
		// Ignore storage quota errors
	}
}

/**
 * Decoder an toàn cho localStorage: hỗ trợ cả V1 mới và legacy,
 * chống crash khi key hỏng, cô lập task pre-v0.1.1.
 */
function loadInitialTabsState(defaultAgentId = "team-feed"): ChatTabsState {
	if (typeof window === "undefined" || !window.localStorage) {
		const defaultTab = createDefaultTab(defaultAgentId)
		return { tabs: [defaultTab], activeTabId: defaultTab.id, isHistoryOpen: false }
	}

	const allDrafts = loadPersistedDrafts()

	try {
		// 1. Thử đọc storage V1 trước
		const rawV1 = localStorage.getItem(CONSOLE_TABS_STORAGE_KEY_V1)
		const rawLegacy = !rawV1 ? localStorage.getItem(CONSOLE_TABS_STORAGE_KEY) : null
		const raw = rawV1 || rawLegacy

		if (raw) {
			const parsed = JSON.parse(raw)
			if (Array.isArray(parsed.tabs) && parsed.tabs.length > 0) {
				const normalizedTabs: ChatTab[] = parsed.tabs.map((t: any) => {
					const activeAgentId =
						typeof t.activeAgentId === "string" && t.activeAgentId.trim() ? t.activeAgentId : defaultAgentId
					const agentTasks: Record<string, string> = {}

					if (t.agentTasks && typeof t.agentTasks === "object") {
						for (const [k, v] of Object.entries(t.agentTasks)) {
							if (typeof k === "string" && typeof v === "string" && v.trim()) {
								agentTasks[k] = v.trim()
							}
						}
					} else if (typeof t.taskId === "string" && t.taskId.trim()) {
						agentTasks[activeAgentId] = t.taskId.trim()
					}

					const tabId = typeof t.id === "string" ? t.id : `tab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`
					const tabDrafts =
						allDrafts[tabId] || (t.agentDrafts && typeof t.agentDrafts === "object" ? t.agentDrafts : {})
					const activeTaskId = agentTasks[activeAgentId]

					return {
						id: tabId,
						sessionId: typeof t.sessionId === "string" ? t.sessionId : undefined,
						title: typeof t.title === "string" && t.title.trim() ? t.title.trim() : DEFAULT_TAB_TITLE,
						activeAgentId,
						activeAgentNumericId: typeof t.activeAgentNumericId === "number" ? t.activeAgentNumericId : undefined,
						agentTasks,
						agentDrafts: tabDrafts,
						agentIds:
							Array.isArray(t.agentIds) && t.agentIds.length > 0
								? t.agentIds
								: Object.keys(agentTasks).length > 0
									? Object.keys(agentTasks)
									: [activeAgentId],
						createdAt: typeof t.createdAt === "number" ? t.createdAt : Date.now(),
						lastActiveAt: typeof t.lastActiveAt === "number" ? t.lastActiveAt : Date.now(),
						isRunning: Boolean(t.isRunning),
						historyBrowse: Boolean(t.historyBrowse),
						taskId: activeTaskId,
						draftInput: tabDrafts[activeAgentId] || "",
					}
				})

				const activeTabId = normalizedTabs.find((t) => t.id === parsed.activeTabId)?.id || normalizedTabs[0].id
				return { tabs: normalizedTabs, activeTabId, isHistoryOpen: false }
			}
		}
	} catch (e) {
		console.error("Failed to load console tabs from localStorage:", e)
	}

	const defaultTab = createDefaultTab(defaultAgentId)
	return { tabs: [defaultTab], activeTabId: defaultTab.id, isHistoryOpen: false }
}

export function useChatTabs(options?: UseChatTabsOptions) {
	const [state, setState] = useState<ChatTabsState>(() => loadInitialTabsState(options?.initialFocusAgentId || "team-feed"))

	const activeTab = state.tabs.find((t) => t.id === state.activeTabId) || state.tabs[0]
	const activeTabRef = useRef(activeTab)
	activeTabRef.current = activeTab

	useEffect(() => {
		try {
			// Lưu tabs vào V1 storage
			const tabsToPersist = state.tabs.map((t) => ({
				id: t.id,
				sessionId: t.sessionId,
				title: t.title,
				activeAgentId: t.activeAgentId,
				activeAgentNumericId: t.activeAgentNumericId,
				agentTasks: t.agentTasks,
				agentIds: t.agentIds,
				createdAt: t.createdAt,
				lastActiveAt: t.lastActiveAt,
				isRunning: t.isRunning,
				historyBrowse: t.historyBrowse,
			}))
			const payload = JSON.stringify({ tabs: tabsToPersist, activeTabId: state.activeTabId })
			localStorage.setItem(CONSOLE_TABS_STORAGE_KEY_V1, payload)
			localStorage.setItem(CONSOLE_TABS_STORAGE_KEY, payload)

			// Lưu drafts riêng biệt
			const draftsByTab: Record<string, Record<string, string>> = {}
			for (const t of state.tabs) {
				if (t.agentDrafts && Object.keys(t.agentDrafts).length > 0) {
					draftsByTab[t.id] = t.agentDrafts
				}
			}
			savePersistedDrafts(draftsByTab)
		} catch (e) {
			console.error("Failed to save console tabs to localStorage:", e)
		}
	}, [state.tabs, state.activeTabId])

	const switchTaskBackend = useCallback(async (taskId?: string) => {
		try {
			if (taskId) {
				await TaskServiceClient.showTaskWithId(StringRequest.create({ value: taskId }))
			} else {
				await TaskServiceClient.clearTask(EmptyRequest.create({}))
			}
		} catch (err) {
			console.error("Error switching task backend:", err)
		}
	}, [])

	const selectTab = useCallback(
		async (tabId: string) => {
			const targetTab = state.tabs.find((t) => t.id === tabId)
			if (!targetTab) return

			setState((prev) => ({
				...prev,
				activeTabId: tabId,
				tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, lastActiveAt: Date.now() } : t)),
			}))

			if (targetTab.activeAgentId && options?.onActiveAgentChange) {
				options.onActiveAgentChange(targetTab.activeAgentId)
			}
			await switchTaskBackend(getTabActiveTaskId(targetTab))
		},
		[state.tabs, options, switchTaskBackend],
	)

	/**
	 * Channel focus: update which Agent the Console is viewing.
	 * Live team: must NOT call showTaskWithId (kills teammate runtime) — ChatView filters
	 * the shared transcript by focusAgentId.
	 * History browse: each Agent has its own taskId — load that transcript via showTaskWithId.
	 */
	const switchAgentInActiveTab = useCallback(
		(newAgentId: string, numericId?: number) => {
			const currentTab = state.tabs.find((t) => t.id === state.activeTabId)
			if (!currentTab) return
			const boundTaskId = currentTab.agentTasks?.[newAgentId]
			const currentlyShown = getTabActiveTaskId(currentTab)
			const shouldLoadHistoryTask =
				Boolean(currentTab.historyBrowse) && Boolean(boundTaskId) && boundTaskId !== currentlyShown

			setState((prev) => ({
				...prev,
				tabs: prev.tabs.map((t) => {
					if (t.id !== prev.activeTabId) return t
					return {
						...t,
						activeAgentId: newAgentId,
						activeAgentNumericId: numericId ?? t.activeAgentNumericId,
						taskId: boundTaskId ?? t.taskId,
						draftInput: t.agentDrafts?.[newAgentId] ?? "",
						lastActiveAt: Date.now(),
					}
				}),
			}))

			if (options?.onActiveAgentChange) {
				options.onActiveAgentChange(newAgentId)
			}
			if (shouldLoadHistoryTask && boundTaskId) {
				void switchTaskBackend(boundTaskId)
			}
		},
		[state.tabs, state.activeTabId, options, switchTaskBackend],
	)

	const bindTaskToActiveAgent = useCallback((taskId: string, title?: string, sessionId?: string) => {
		setState((prev) => {
			const current = prev.tabs.find((t) => t.id === prev.activeTabId)
			if (!current) return prev

			const agentId = current.activeAgentId || "coordinator"
			// History browse: never overwrite a pre-bound agent→task map from the CEO session.
			const existingBinding = current.agentTasks?.[agentId]
			if (current.historyBrowse && existingBinding && existingBinding !== taskId) {
				return {
					...prev,
					tabs: prev.tabs.map((t) =>
						t.id === prev.activeTabId
							? {
									...t,
									sessionId: sessionId || t.sessionId,
									lastActiveAt: Date.now(),
								}
							: t,
					),
				}
			}

			const updatedAgentTasks = { ...(current.agentTasks || {}), [agentId]: taskId }
			const updatedAgentIds = Array.from(new Set([...(current.agentIds || []), agentId]))
			const newTitle = current.title === DEFAULT_TAB_TITLE && title ? title : current.title

			return {
				...prev,
				tabs: prev.tabs.map((t) =>
					t.id === prev.activeTabId
						? {
								...t,
								sessionId: sessionId || t.sessionId,
								taskId,
								title: newTitle,
								agentTasks: updatedAgentTasks,
								agentIds: updatedAgentIds,
								lastActiveAt: Date.now(),
							}
						: t,
				),
			}
		})
	}, [])

	const createNewTab = useCallback(
		async (agentId?: string) => {
			if (state.tabs.length >= MAX_TABS_COUNT) {
				const lastTab = state.tabs[state.tabs.length - 1]
				await selectTab(lastTab.id)
				return lastTab
			}

			const effectiveAgent = agentId || options?.initialFocusAgentId || "team-feed"
			const newTab = createDefaultTab(effectiveAgent)

			// Clear the host transcript BEFORE activating the blank tab. Otherwise the new
			// tab paints the still-loaded session, and ConsoleView's bindTask effect can
			// stamp that task/session onto the new tab (clone-on-+ bug).
			await switchTaskBackend(undefined)

			setState((prev) => ({
				...prev,
				tabs: [...prev.tabs, newTab],
				activeTabId: newTab.id,
			}))

			if (options?.onActiveAgentChange) {
				options.onActiveAgentChange(effectiveAgent)
			}
			return newTab
		},
		[state.tabs, options, selectTab, switchTaskBackend],
	)

	const closeTab = useCallback(
		async (tabId: string, event?: React.MouseEvent) => {
			if (event) {
				event.stopPropagation()
			}

			// Dọn dẹp drafts đã lưu cho tab này
			try {
				const drafts = loadPersistedDrafts()
				if (drafts[tabId]) {
					delete drafts[tabId]
					savePersistedDrafts(drafts)
				}
			} catch {
				// Best effort draft cleanup
			}

			setState((prev) => {
				const tabIndex = prev.tabs.findIndex((t) => t.id === tabId)
				if (tabIndex === -1) return prev

				if (prev.tabs.length <= 1) {
					const blankTab = createDefaultTab(options?.initialFocusAgentId || "team-feed")
					void switchTaskBackend(undefined)
					return { ...prev, tabs: [blankTab], activeTabId: blankTab.id }
				}

				const remaining = prev.tabs.filter((t) => t.id !== tabId)
				let nextActiveId = prev.activeTabId

				if (prev.activeTabId === tabId) {
					const neighborIndex = tabIndex > 0 ? tabIndex - 1 : 0
					const nextTab = remaining[neighborIndex]
					nextActiveId = nextTab.id
					const nextAgentTask = getTabActiveTaskId(nextTab)
					void switchTaskBackend(nextAgentTask)
					if (nextTab.activeAgentId && options?.onActiveAgentChange) {
						options.onActiveAgentChange(nextTab.activeAgentId)
					}
				}

				return { ...prev, tabs: remaining, activeTabId: nextActiveId }
			})
		},
		[options, switchTaskBackend],
	)

	const openTaskInTab = useCallback(
		async (
			taskId: string,
			title?: string,
			agentId?: string,
			sessionAgentTasks?: Record<string, string>,
			sessionId?: string,
		) => {
			const initialAgent = agentId || "coordinator"
			const agentTasksMap = sessionAgentTasks || { [initialAgent]: taskId }

			const existing = state.tabs.find(
				(t) =>
					(sessionId && t.sessionId === sessionId) ||
					t.taskId === taskId ||
					(t.agentTasks && Object.values(t.agentTasks).includes(taskId)),
			)
			if (existing) {
				await selectTab(existing.id)
				setState((prev) => ({
					...prev,
					isHistoryOpen: false,
					tabs: prev.tabs.map((t) =>
						t.id === existing.id
							? {
									...t,
									historyBrowse: true,
									activeAgentId: initialAgent,
									agentTasks: { ...t.agentTasks, ...agentTasksMap },
									agentIds: Array.from(new Set([...(t.agentIds || []), ...Object.keys(agentTasksMap)])),
									taskId: agentTasksMap[initialAgent] || t.taskId || taskId,
								}
							: t,
					),
				}))
				const bound = agentTasksMap[initialAgent] || taskId
				if (bound && bound !== getTabActiveTaskId(existing)) {
					await switchTaskBackend(bound)
				}
				if (options?.onActiveAgentChange) {
					options.onActiveAgentChange(initialAgent)
				}
				return
			}

			const currentActive = activeTabRef.current
			if (
				currentActive &&
				!currentActive.taskId &&
				Object.keys(currentActive.agentTasks || {}).length === 0 &&
				currentActive.title === DEFAULT_TAB_TITLE
			) {
				const updatedTab: ChatTab = {
					...currentActive,
					sessionId: sessionId || currentActive.sessionId,
					taskId,
					title: title || currentActive.title,
					activeAgentId: initialAgent,
					agentTasks: agentTasksMap,
					agentIds: Object.keys(agentTasksMap),
					historyBrowse: true,
					lastActiveAt: Date.now(),
				}

				setState((prev) => ({
					...prev,
					tabs: prev.tabs.map((t) => (t.id === currentActive.id ? updatedTab : t)),
					isHistoryOpen: false,
				}))

				if (options?.onActiveAgentChange) {
					options.onActiveAgentChange(initialAgent)
				}
				await switchTaskBackend(taskId)
				return
			}

			const now = Date.now()
			const newTab: ChatTab = {
				id: `tab_${now}_${Math.random().toString(36).slice(2, 7)}`,
				sessionId,
				taskId,
				title: title || DEFAULT_TAB_TITLE,
				activeAgentId: initialAgent,
				agentTasks: agentTasksMap,
				agentIds: Object.keys(agentTasksMap),
				historyBrowse: true,
				createdAt: now,
				lastActiveAt: now,
			}

			setState((prev) => ({
				...prev,
				tabs: [...prev.tabs, newTab],
				activeTabId: newTab.id,
				isHistoryOpen: false,
			}))

			if (options?.onActiveAgentChange) {
				options.onActiveAgentChange(initialAgent)
			}
			await switchTaskBackend(taskId)
		},
		[state.tabs, options, selectTab, switchTaskBackend],
	)

	const openSessionInTab = useCallback(
		async (
			sessionId: string,
			title: string,
			participants: Array<{ agentSlug: string; taskId?: string; agentNumericId?: number }>,
			preferredAgentSlug?: string,
		) => {
			const agentTasksMap: Record<string, string> = {}
			for (const p of participants) {
				if (p.taskId) {
					agentTasksMap[p.agentSlug] = p.taskId
				}
			}

			const initialAgent = preferredAgentSlug || participants[0]?.agentSlug || "coordinator"
			const initialTaskId = agentTasksMap[initialAgent] || Object.values(agentTasksMap)[0]

			await openTaskInTab(initialTaskId || "", title, initialAgent, agentTasksMap, sessionId)
		},
		[openTaskInTab],
	)

	const updateActiveTab = useCallback((updates: Partial<ChatTab>) => {
		setState((prev) => ({
			...prev,
			tabs: prev.tabs.map((t) => (t.id === prev.activeTabId ? { ...t, ...updates } : t)),
		}))
	}, [])

	const updateActiveTabTask = useCallback((taskId: string, title?: string, sessionId?: string) => {
		setState((prev) => ({
			...prev,
			tabs: prev.tabs.map((t) => {
				if (t.id !== prev.activeTabId) return t
				const agentId = t.activeAgentId || "coordinator"
				const updatedTasks = { ...(t.agentTasks || {}), [agentId]: taskId }
				return {
					...t,
					sessionId: sessionId || t.sessionId,
					taskId,
					title: title || t.title,
					agentTasks: updatedTasks,
					agentIds: Array.from(new Set([...(t.agentIds || []), agentId])),
				}
			}),
		}))
	}, [])

	const setDraftInput = useCallback((tabId: string, draftInput: string) => {
		setState((prev) => ({
			...prev,
			tabs: prev.tabs.map((t) => {
				if (t.id !== tabId) return t
				const currentAgent = t.activeAgentId || "coordinator"
				const truncatedDraft = draftInput.slice(0, MAX_DRAFT_LENGTH)
				const updatedDrafts = { ...(t.agentDrafts || {}), [currentAgent]: truncatedDraft }
				return { ...t, draftInput: truncatedDraft, agentDrafts: updatedDrafts }
			}),
		}))
	}, [])

	const handleTaskDeleted = useCallback(
		async (deletedTaskId: string) => {
			const activeTab = activeTabRef.current
			const shouldClearBackend =
				activeTab?.taskId === deletedTaskId || activeTab?.agentTasks?.[activeTab?.activeAgentId] === deletedTaskId

			setState((prev) => {
				return {
					...prev,
					tabs: prev.tabs.map((t) => {
						const hasTask = t.taskId === deletedTaskId || Object.values(t.agentTasks || {}).includes(deletedTaskId)
						if (!hasTask) return t

						const newAgentTasks = { ...(t.agentTasks || {}) }
						for (const [ag, tid] of Object.entries(newAgentTasks)) {
							if (tid === deletedTaskId) {
								delete newAgentTasks[ag]
							}
						}

						const remainingTaskCount = Object.keys(newAgentTasks).length
						const newCurrentTaskId = newAgentTasks[t.activeAgentId]

						return {
							...t,
							taskId: newCurrentTaskId,
							agentTasks: newAgentTasks,
							agentIds: Object.keys(newAgentTasks),
							title: remainingTaskCount === 0 ? DEFAULT_TAB_TITLE : t.title,
						}
					}),
				}
			})

			if (shouldClearBackend) {
				await switchTaskBackend(undefined)
			}
		},
		[switchTaskBackend],
	)

	const toggleHistory = useCallback((open?: boolean) => {
		setState((prev) => ({
			...prev,
			isHistoryOpen: open !== undefined ? open : !prev.isHistoryOpen,
		}))
	}, [])

	return {
		tabs: state.tabs,
		activeTab,
		activeTabId: state.activeTabId,
		isHistoryOpen: state.isHistoryOpen,
		selectTab,
		switchAgentInActiveTab,
		bindTaskToActiveAgent,
		createNewTab,
		closeTab,
		updateActiveTabTask,
		setDraftInput,
		openTaskInTab,
		openSessionInTab,
		updateActiveTab,
		handleTaskDeleted,
		toggleHistory,
	}
}
