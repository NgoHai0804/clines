import type { OrvantaRosterAgent } from "@shared/proto/cline/orvanta"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"
import { ConsoleView } from "../ConsoleView"

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		newTask: vi.fn().mockResolvedValue({}),
		askResponse: vi.fn().mockResolvedValue({}),
		clearTask: vi.fn().mockResolvedValue({}),
		showTaskWithId: vi.fn().mockResolvedValue({}),
		deleteTasksWithIds: vi.fn().mockResolvedValue({}),
	},
	OrvantaServiceClient: {
		sendAgentDirectMessage: vi.fn().mockResolvedValue({ success: true }),
		getCompany: vi.fn().mockResolvedValue({
			status: "ready",
			company: { name: "Acme Corp" },
			purpose: "Build great products",
			agents: [
				{ id: "coordinator", displayName: "Coordinator (Lead)", role: "lead", status: "idle" },
				{ id: "implementer", displayName: "Frontend Developer", role: "teammate", status: "idle" },
			],
		}),
		listCeoSessions: vi.fn().mockResolvedValue({ success: true, status: "ready", sessions: [] }),
		subscribeCompany: vi.fn().mockReturnValue(vi.fn()),
	},
}))

vi.mock("../useWarRoom", () => ({
	useWarRoom: () => ({
		snapshot: {
			companyName: "Acme Corp",
			purposeOneLiner: "Build great products",
			cards: [],
		},
		paused: false,
		filter: "all",
		setPaused: vi.fn(),
		setFilter: vi.fn(),
	}),
}))

describe("v0.1.0 Chrome Tabs & History in ConsoleView", () => {
	const mockAgents: OrvantaRosterAgent[] = [
		{
			id: "coordinator",
			displayName: "Coordinator",
			role: "lead",
			status: "idle",
		},
		{
			id: "implementer",
			displayName: "Dave",
			role: "implementer",
			status: "running",
		},
	]

	const mockTaskHistory = [
		{
			id: "task-abc-123",
			ts: Date.now() - 1000 * 60 * 30, // 30 mins ago
			task: "Fix authorization middleware for v0.1.0",
			tokensIn: 800,
			tokensOut: 350,
			totalCost: 0.015,
		},
	]

	beforeEach(() => {
		localStorage.clear()
		vi.clearAllMocks()
	})

	const renderConsole = (focusAgentId = "team-feed", onSelectAgent = vi.fn()) => {
		return render(
			<ExtensionStateContext.Provider
				value={
					{
						currentTaskItem: undefined,
						taskHistory: mockTaskHistory,
					} as any
				}>
				<ConsoleView
					agents={mockAgents}
					companyName="Acme Corp"
					focusAgentId={focusAgentId}
					onSelectAgent={onSelectAgent}>
					<div data-testid="chat-view-container">Active Chat View</div>
				</ConsoleView>
			</ExtensionStateContext.Provider>,
		)
	}

	it("renders ChromeTabBar at the top spanning entire Console root", () => {
		renderConsole()

		const tabBar = screen.getByTestId("chrome-tab-bar")
		expect(tabBar).toBeInTheDocument()

		// Initial tab exists
		expect(within(tabBar).getByText("Phiên làm việc mới")).toBeInTheDocument()

		// History button exists
		expect(screen.getByLabelText("Mở lịch sử cuộc trò chuyện")).toBeInTheDocument()

		// New tab button [+] exists
		expect(screen.getByLabelText("Tạo cuộc trò chuyện mới")).toBeInTheDocument()
	})

	it("creates a new tab when [+] is clicked and switches active tab", async () => {
		renderConsole()

		const plusBtn = screen.getByLabelText("Tạo cuộc trò chuyện mới")
		fireEvent.click(plusBtn)

		const tabs = screen.getAllByRole("tab")
		expect(tabs).toHaveLength(2)

		// Newly created tab is active
		expect(tabs[1]).toHaveAttribute("aria-selected", "true")
	})

	it("opens History Drawer, displays past sessions and loads them into a tab", async () => {
		const onSelectAgent = vi.fn()
		renderConsole("team-feed", onSelectAgent)

		// Open history drawer
		const historyBtn = screen.getByLabelText("Mở lịch sử cuộc trò chuyện")
		fireEvent.click(historyBtn)

		const drawer = screen.getByTestId("console-history-drawer")
		expect(drawer).toBeInTheDocument()
		expect(within(drawer).getByText("Fix authorization middleware for v0.1.0")).toBeInTheDocument()
		expect(within(drawer).getByText(".orvanta/local/history")).toBeInTheDocument()

		// Click on the past task to open it
		fireEvent.click(within(drawer).getByText("Fix authorization middleware for v0.1.0"))

		// Drawer closes and tab title is updated
		expect(screen.queryByTestId("console-history-drawer")).not.toBeInTheDocument()
		expect(screen.getByText("Fix authorization middleware for v0.1.0")).toBeInTheDocument()
	})

	it("closes a tab when [x] is clicked", () => {
		renderConsole()

		// Create a second tab
		const plusBtn = screen.getByLabelText("Tạo cuộc trò chuyện mới")
		fireEvent.click(plusBtn)

		let tabs = screen.getAllByRole("tab")
		expect(tabs).toHaveLength(2)

		// Close the second tab
		const closeButtons = screen.getAllByLabelText(/Đóng tab/)
		fireEvent.click(closeButtons[1])

		tabs = screen.getAllByRole("tab")
		expect(tabs).toHaveLength(1)
	})

	it("deletes a task in History Drawer and resets open tab if that task was active", async () => {
		renderConsole()

		// Open history drawer and load past task
		fireEvent.click(screen.getByLabelText("Mở lịch sử cuộc trò chuyện"))
		const drawer = screen.getByTestId("console-history-drawer")
		fireEvent.click(within(drawer).getByText("Fix authorization middleware for v0.1.0"))

		// Tab now has the past task title
		expect(screen.getByText("Fix authorization middleware for v0.1.0")).toBeInTheDocument()

		// Reopen history drawer and delete the task
		fireEvent.click(screen.getByLabelText("Mở lịch sử cuộc trò chuyện"))
		const deleteBtns = screen.getAllByLabelText("Xóa cuộc trò chuyện")
		fireEvent.click(deleteBtns[0])

		// Click confirm delete
		const confirmBtn = screen.getByRole("button", { name: "Xóa" })
		fireEvent.click(confirmBtn)

		// Expect TaskServiceClient.deleteTasksWithIds was called
		expect(TaskServiceClient.deleteTasksWithIds).toHaveBeenCalled()
	})

	it("manages multi-agent conversation within the same CEO session tab", async () => {
		const onSelectAgent = vi.fn()
		renderConsole("coordinator", onSelectAgent)

		// Initially focused on coordinator
		expect(screen.getAllByText("Coordinator").length).toBeGreaterThanOrEqual(1)

		// Click on Implementer in sidebar
		const implementerButton = screen.getByText("Dave")
		fireEvent.click(implementerButton)

		expect(onSelectAgent).toHaveBeenCalledWith("implementer")
	})
})
