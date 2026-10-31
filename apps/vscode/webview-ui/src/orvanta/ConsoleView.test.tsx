import type { OrvantaRosterAgent } from "@shared/proto/cline/orvanta"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import ConsoleView from "./ConsoleView"

vi.mock("./useWarRoom", () => ({
	useWarRoom: () => ({
		snapshot: {
			companyName: "Acme Corp",
			purposeOneLiner: "Build great products",
			cards: [
				{
					id: "coordinator",
					displayName: "Coordinator",
					role: "lead",
					status: "running",
					taskTitle: "Sprint 4 Planning",
					elapsedSeconds: 42,
					buffer: [{ kind: "progress", text: "Coordinating team" }],
					isEphemeral: false,
					inputTokens: 100,
					outputTokens: 50,
					cost: 0.01,
				},
				{
					id: "implementer",
					displayName: "Dave",
					role: "implementer",
					status: "idle",
					taskTitle: "Refactor auth",
					elapsedSeconds: 0,
					buffer: [{ kind: "tool_result", text: "Finished auth tests" }],
					isEphemeral: false,
					inputTokens: 200,
					outputTokens: 100,
					cost: 0.02,
				},
			],
		},
		syncStatus: "live",
		lastUpdatedAt: undefined,
		pauseStatus: "running",
		needsAttention: [],
		canPauseRuntime: false,
		requestRuntimePause: vi.fn(),
		requestRuntimeResume: vi.fn(),
		pauseError: undefined,
		paused: false,
		filter: "all",
		setPaused: vi.fn(),
		setFilter: vi.fn(),
	}),
}))
vi.mock("@/context/ExtensionStateContext", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/context/ExtensionStateContext")>()
	return {
		...actual,
		useExtensionState: () => ({
			currentTaskItem: undefined,
			taskHistory: [],
		}),
	}
})

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		newTask: vi.fn().mockResolvedValue({}),
		askResponse: vi.fn().mockResolvedValue({}),
		showTaskWithId: vi.fn().mockResolvedValue({}),
		clearTask: vi.fn().mockResolvedValue({}),
	},
	OrvantaServiceClient: {
		sendAgentDirectMessage: vi.fn().mockResolvedValue({ success: true }),
		listCeoSessions: vi.fn().mockResolvedValue({ sessions: [] }),
		subscribeWarRoom: vi.fn(() => () => {}),
	},
}))

describe("ConsoleView", () => {
	const mockAgents: OrvantaRosterAgent[] = [
		{
			id: "coordinator",
			displayName: "Coordinator",
			role: "lead",
			status: "running",
		},
		{
			id: "implementer",
			displayName: "Dave",
			role: "implementer",
			status: "idle",
		},
	]

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("renders #team-feed view by default when focusAgentId is team-feed", () => {
		const onSelectAgent = vi.fn()
		render(
			<ConsoleView agents={mockAgents} companyName="Acme Corp" focusAgentId="team-feed" onSelectAgent={onSelectAgent}>
				<div data-testid="mock-chat-view">Mock ChatView</div>
			</ConsoleView>,
		)

		// Team feed view should be present
		expect(screen.getByTestId("team-feed-view")).toBeInTheDocument()
		expect(screen.getByText("(Acme Corp)")).toBeInTheDocument()
		expect(screen.getByTestId("feed-card-implementer")).toBeInTheDocument()
		fireEvent.click(screen.getByTestId("feed-card-implementer"))
		expect(onSelectAgent).toHaveBeenCalledWith("implementer")

		// Children (ChatView container) should be hidden
		const chatContainer = screen.getByTestId("mock-chat-view").parentElement?.parentElement
		expect(chatContainer).toHaveStyle({ display: "none" })
	})

	it("renders agent channel header and displays chatview when an agent channel is focused", () => {
		const onSelectAgent = vi.fn()
		render(
			<ConsoleView agents={mockAgents} companyName="Acme Corp" focusAgentId="implementer" onSelectAgent={onSelectAgent}>
				<div data-testid="mock-chat-view">Mock ChatView</div>
			</ConsoleView>,
		)

		// Agent header should be visible
		const agentHeader = screen.getByTestId("agent-channel-header")
		expect(agentHeader).toBeInTheDocument()
		expect(within(agentHeader).getByText("Dave")).toBeInTheDocument()
		expect(within(agentHeader).getByText("@implementer")).toBeInTheDocument()
		expect(within(agentHeader).getByText("Chỉ đạo 1:1 qua Mailbox")).toBeInTheDocument()

		// ChatView should be visible
		const chatContainer = screen.getByTestId("mock-chat-view").parentElement?.parentElement
		expect(chatContainer).toHaveStyle({ display: "flex" })

		// Clicking "Quay lại #team-feed" triggers callback
		const backBtn = screen.getByTitle("Quay lại #team-feed")
		fireEvent.click(backBtn)
		expect(onSelectAgent).toHaveBeenCalledWith("team-feed")
	})
	it("handles fallback gracefully when focusAgentId is not in agents roster", () => {
		const onSelectAgent = vi.fn()
		render(
			<ConsoleView agents={mockAgents} companyName="Acme Corp" focusAgentId="unknown-agent" onSelectAgent={onSelectAgent}>
				<div data-testid="mock-chat-view">Mock ChatView</div>
			</ConsoleView>,
		)

		// When agent is not found, fallback to team feed or hide agent header
		expect(screen.queryByTestId("agent-channel-header")).not.toBeInTheDocument()
	})

	it("verifies zero decorative emojis exist in rendered ConsoleView", () => {
		const { container } = render(
			<ConsoleView agents={mockAgents} companyName="Acme Corp" focusAgentId="team-feed" onSelectAgent={vi.fn()}>
				<div data-testid="mock-chat-view">Mock ChatView</div>
			</ConsoleView>,
		)

		const content = container.textContent || ""
		expect(content).not.toContain("★")
		expect(content).not.toContain("«")
		expect(content).not.toContain("»")
		expect(content).not.toContain("▲")
		expect(content).not.toContain("▼")
		expect(content).not.toContain("📢")
		expect(content).not.toContain("🎉")
		expect(content).not.toContain("⭐")
		expect(content).not.toContain("💻")
	})

	it("supports keyboard shortcut Ctrl+B to toggle sidebar collapse", () => {
		localStorage.clear()
		render(
			<ConsoleView agents={mockAgents} companyName="Acme Corp" focusAgentId="team-feed" onSelectAgent={vi.fn()}>
				<div data-testid="mock-chat-view">Mock ChatView</div>
			</ConsoleView>,
		)

		const sidebar = screen.getByTestId("orvanta-team-sidebar")
		expect(sidebar).toHaveAttribute("data-collapsed", "false")

		// Press Ctrl+B
		fireEvent.keyDown(window, { key: "b", ctrlKey: true })
		expect(sidebar).toHaveAttribute("data-collapsed", "true")

		// Press Ctrl+B again
		fireEvent.keyDown(window, { key: "b", ctrlKey: true })
		expect(sidebar).toHaveAttribute("data-collapsed", "false")
	})

	it("triggers onHire when quick hire button is clicked in TeamSidebar", () => {
		const onHire = vi.fn()
		render(
			<ConsoleView
				agents={mockAgents}
				companyName="Acme Corp"
				focusAgentId="team-feed"
				onHire={onHire}
				onSelectAgent={vi.fn()}>
				<div data-testid="mock-chat-view">Mock ChatView</div>
			</ConsoleView>,
		)

		const hireBtn = screen.getByTestId("quick-hire-button")
		expect(hireBtn).toBeInTheDocument()
		fireEvent.click(hireBtn)
		expect(onHire).toHaveBeenCalled()
	})
	it("renders ChromeTabBar at the root and toggles history drawer", () => {
		render(
			<ConsoleView agents={mockAgents} companyName="Acme Corp" focusAgentId="team-feed" onSelectAgent={vi.fn()}>
				<div data-testid="mock-chat-view">Mock ChatView</div>
			</ConsoleView>,
		)

		expect(screen.getByTestId("chrome-tab-bar")).toBeInTheDocument()
		expect(screen.getByText("Phiên làm việc mới")).toBeInTheDocument()

		// History drawer is initially closed
		expect(screen.queryByTestId("console-history-drawer")).not.toBeInTheDocument()

		// Click history button on tab bar
		const historyBtn = screen.getByLabelText("Mở lịch sử cuộc trò chuyện")
		fireEvent.click(historyBtn)

		// Drawer should now be visible
		expect(screen.getByTestId("console-history-drawer")).toBeInTheDocument()
	})
})
