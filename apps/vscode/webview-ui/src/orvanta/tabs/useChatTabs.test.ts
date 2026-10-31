import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskServiceClient } from "@/services/grpc-client"
import { DEFAULT_TAB_TITLE } from "./types"
import { useChatTabs } from "./useChatTabs"

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		showTaskWithId: vi.fn().mockResolvedValue({}),
		clearTask: vi.fn().mockResolvedValue({}),
	},
}))

describe("useChatTabs", () => {
	beforeEach(() => {
		localStorage.clear()
		vi.clearAllMocks()
	})

	it("initializes with 1 default tab when storage is empty", () => {
		const { result } = renderHook(() => useChatTabs({ initialFocusAgentId: "coordinator" }))
		expect(result.current.tabs).toHaveLength(1)
		expect(result.current.tabs[0].title).toBe(DEFAULT_TAB_TITLE)
		expect(result.current.tabs[0].activeAgentId).toBe("coordinator")
		expect(result.current.activeTabId).toBe(result.current.tabs[0].id)
	})

	it("creates a new tab and calls clearTask", async () => {
		const { result } = renderHook(() => useChatTabs())
		await act(async () => {
			await result.current.createNewTab("implementer")
		})

		expect(result.current.tabs).toHaveLength(2)
		expect(result.current.activeTab.activeAgentId).toBe("implementer")
		expect(TaskServiceClient.clearTask).toHaveBeenCalled()
	})

	it("does not copy the previous tab's task/session onto a new tab", async () => {
		const { result } = renderHook(() => useChatTabs())
		await act(async () => {
			result.current.updateActiveTab({
				taskId: "task-old",
				title: "Old session",
				sessionId: "sess-old",
				agentTasks: { coordinator: "task-old" },
			})
			await result.current.createNewTab("team-feed")
		})

		expect(result.current.tabs).toHaveLength(2)
		expect(result.current.activeTab.taskId).toBeUndefined()
		expect(result.current.activeTab.sessionId).toBeUndefined()
		expect(result.current.activeTab.agentTasks).toEqual({})
		expect(result.current.activeTab.title).toBe("Phiên làm việc mới")
		expect(TaskServiceClient.clearTask).toHaveBeenCalled()
	})

	it("switches tabs and calls showTaskWithId for task tabs", async () => {
		const { result } = renderHook(() => useChatTabs())
		let firstTabId: string

		await act(async () => {
			firstTabId = result.current.activeTabId
			result.current.updateActiveTab({ taskId: "task-100", title: "Task 100" })
			await result.current.createNewTab("reviewer")
		})

		expect(result.current.tabs).toHaveLength(2)

		await act(async () => {
			await result.current.selectTab(firstTabId)
		})

		expect(result.current.activeTabId).toBe(firstTabId)
		expect(TaskServiceClient.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "task-100" }))
	})

	it("closes a tab and activates neighbor", async () => {
		const { result } = renderHook(() => useChatTabs())
		let tab2Id = ""

		await act(async () => {
			const tab2 = await result.current.createNewTab("coordinator")
			tab2Id = tab2.id
		})

		expect(result.current.tabs).toHaveLength(2)
		expect(result.current.activeTabId).toBe(tab2Id)

		await act(async () => {
			await result.current.closeTab(tab2Id)
		})

		expect(result.current.tabs).toHaveLength(1)
		expect(result.current.activeTabId).toBe(result.current.tabs[0].id)
	})

	it("resets to a single blank tab when closing the only remaining tab", async () => {
		const { result } = renderHook(() => useChatTabs())
		const singleTabId = result.current.activeTabId

		await act(async () => {
			await result.current.closeTab(singleTabId)
		})

		expect(result.current.tabs).toHaveLength(1)
		expect(result.current.tabs[0].title).toBe(DEFAULT_TAB_TITLE)
		expect(TaskServiceClient.clearTask).toHaveBeenCalled()
	})

	it("opens a task from history into existing or new tab", async () => {
		const { result } = renderHook(() => useChatTabs())

		// Reuses initial empty tab
		await act(async () => {
			await result.current.openTaskInTab("task-past-1", "Past Task 1", "implementer")
		})

		expect(result.current.tabs).toHaveLength(1)
		expect(result.current.tabs[0].taskId).toBe("task-past-1")
		expect(result.current.tabs[0].title).toBe("Past Task 1")
		expect(TaskServiceClient.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "task-past-1" }))

		// Creates a second tab when already has task
		await act(async () => {
			await result.current.openTaskInTab("task-past-2", "Past Task 2", "reviewer")
		})

		expect(result.current.tabs).toHaveLength(2)
		expect(result.current.activeTab.taskId).toBe("task-past-2")
	})

	it("resets tab taskId and calls clearTask when active task is deleted", async () => {
		const { result } = renderHook(() => useChatTabs())

		await act(async () => {
			await result.current.openTaskInTab("task-to-delete", "Task To Delete", "coordinator")
		})

		expect(result.current.activeTab.taskId).toBe("task-to-delete")

		await act(async () => {
			await result.current.handleTaskDeleted("task-to-delete")
		})

		expect(result.current.activeTab.taskId).toBeUndefined()
		expect(result.current.activeTab.title).toBe(DEFAULT_TAB_TITLE)
		expect(TaskServiceClient.clearTask).toHaveBeenCalled()
	})

	it("switches agents within the same tab without clearing or swapping the live backend task", async () => {
		const { result } = renderHook(() => useChatTabs({ initialFocusAgentId: "coordinator" }))

		// First, bind task-coord-1 to coordinator
		await act(async () => {
			result.current.bindTaskToActiveAgent("task-coord-1", "Auth Feature")
		})

		expect(result.current.activeTab.agentTasks.coordinator).toBe("task-coord-1")
		vi.clearAllMocks()

		// Switch to implementer (no per-agent binding) — UI focus only; keep live task
		await act(async () => {
			result.current.switchAgentInActiveTab("implementer")
		})

		expect(result.current.activeTab.activeAgentId).toBe("implementer")
		expect(result.current.activeTab.taskId).toBe("task-coord-1")
		expect(TaskServiceClient.clearTask).not.toHaveBeenCalled()
		expect(TaskServiceClient.showTaskWithId).not.toHaveBeenCalled()

		// Bind task-impl-2 to implementer (bookkeeping only)
		await act(async () => {
			result.current.bindTaskToActiveAgent("task-impl-2")
		})

		expect(result.current.activeTab.agentTasks.implementer).toBe("task-impl-2")
		vi.clearAllMocks()

		// Switch back to coordinator — update local taskId from binding; do not tear down runtime
		await act(async () => {
			result.current.switchAgentInActiveTab("coordinator")
		})

		expect(result.current.activeTab.activeAgentId).toBe("coordinator")
		expect(result.current.activeTab.taskId).toBe("task-coord-1")
		expect(TaskServiceClient.clearTask).not.toHaveBeenCalled()
		expect(TaskServiceClient.showTaskWithId).not.toHaveBeenCalled()
	})

	it("handles sessionId round-trip and openSessionInTab", async () => {
		const { result } = renderHook(() => useChatTabs())

		await act(async () => {
			await result.current.openSessionInTab(
				"sess-ui-001",
				"Multi Agent Session",
				[
					{ agentSlug: "coordinator", taskId: "task-c-1", agentNumericId: 1 },
					{ agentSlug: "implementer", taskId: "task-i-2", agentNumericId: 2 },
				],
				"implementer",
			)
		})

		expect(result.current.activeTab.sessionId).toBe("sess-ui-001")
		expect(result.current.activeTab.historyBrowse).toBe(true)
		expect(result.current.activeTab.activeAgentId).toBe("implementer")
		expect(result.current.activeTab.taskId).toBe("task-i-2")
		expect(result.current.activeTab.agentTasks.coordinator).toBe("task-c-1")
		expect(result.current.activeTab.agentTasks.implementer).toBe("task-i-2")
		expect(TaskServiceClient.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "task-i-2" }))

		vi.clearAllMocks()
		// History browse: switching agent loads that agent's transcript
		await act(async () => {
			result.current.switchAgentInActiveTab("coordinator")
		})
		expect(result.current.activeTab.activeAgentId).toBe("coordinator")
		expect(result.current.activeTab.taskId).toBe("task-c-1")
		expect(TaskServiceClient.showTaskWithId).toHaveBeenCalledWith(expect.objectContaining({ value: "task-c-1" }))

		// Must not clobber implementer binding when backend reports coordinator task
		await act(async () => {
			result.current.bindTaskToActiveAgent("task-c-1", "Multi Agent Session", "sess-ui-001")
		})
		expect(result.current.activeTab.agentTasks.implementer).toBe("task-i-2")
		expect(result.current.activeTab.agentTasks.coordinator).toBe("task-c-1")
	})

	it("safely decodes valid and corrupted localStorage without crashing", () => {
		// Corrupted JSON in localStorage
		localStorage.setItem("orvanta_console_tabs_state_v1", "{ corrupt json: ")
		const { result: r1 } = renderHook(() => useChatTabs())
		expect(r1.current.tabs).toHaveLength(1)
		expect(r1.current.tabs[0].title).toBe(DEFAULT_TAB_TITLE)

		// Legacy storage format with valid data
		localStorage.clear()
		localStorage.setItem(
			"orvanta_console_tabs_state",
			JSON.stringify({
				tabs: [
					{
						id: "tab-legacy-1",
						title: "Legacy Tab",
						activeAgentId: "coordinator",
						taskId: "task-leg-1",
					},
				],
				activeTabId: "tab-legacy-1",
			}),
		)

		const { result: r2 } = renderHook(() => useChatTabs())
		expect(r2.current.tabs).toHaveLength(1)
		expect(r2.current.tabs[0].title).toBe("Legacy Tab")
		expect(r2.current.tabs[0].agentTasks.coordinator).toBe("task-leg-1")
		expect(r2.current.tabs[0].taskId).toBe("task-leg-1")
	})

	it("manages drafts in independent storage and cleans up on closeTab", async () => {
		const { result } = renderHook(() => useChatTabs())
		const tabId = result.current.activeTabId

		await act(async () => {
			result.current.setDraftInput(tabId, "Working on a new feature draft...")
		})

		expect(result.current.activeTab.draftInput).toBe("Working on a new feature draft...")

		// Verify draft is stored in independent storage
		const draftsRaw = localStorage.getItem("orvanta_console_drafts_v1")
		expect(draftsRaw).toBeTruthy()
		expect(draftsRaw).toContain("Working on a new feature draft...")

		// When tab is closed, drafts should be cleaned up
		await act(async () => {
			await result.current.closeTab(tabId)
		})

		const draftsAfterClose = JSON.parse(localStorage.getItem("orvanta_console_drafts_v1") || "{}")
		expect(draftsAfterClose[tabId]).toBeUndefined()
	})
})
