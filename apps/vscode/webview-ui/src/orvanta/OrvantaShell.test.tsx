import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import OrvantaShell from "./OrvantaShell"

let mockCompanyStatus = "missing"
let mockPendingCount = 0

vi.mock("./HomeView", () => ({
	default: () => <div data-testid="mock-home-view">Mock HomeView</div>,
}))

vi.mock("./AgentsView", () => ({
	default: () => <div data-testid="mock-agents-view">Mock AgentsView</div>,
}))

vi.mock("./InboxView", () => ({
	default: () => <div data-testid="mock-inbox-view">Mock InboxView</div>,
}))

vi.mock("./useOrvantaCompany", () => ({
	useOrvantaCompany: () => ({
		company: {
			status: mockCompanyStatus,
			errors: [],
			id: "co-1",
			name: "Test",
			purpose: "Purpose",
			teamName: "team",
			agents: [],
		},
		loading: false,
		creating: false,
		createError: undefined,
		agentProfiles: {},
		createCompany: vi.fn(),
		saveAgentProfile: vi.fn(),
		deleteAgentProfile: vi.fn(),
	}),
}))

vi.mock("./useOrvantaInbox", () => ({
	useOrvantaInbox: () => ({
		pending: mockPendingCount > 0 ? [{ id: "dec-1", title: "Test Decision", urgency: "normal" }] : [],
		deferred: [],
		history: [],
		pendingCount: mockPendingCount,
		loading: false,
		error: null,
		resolveDecision: vi.fn(),
		requestDecision: vi.fn(),
		refresh: vi.fn(),
	}),
}))

vi.mock("./useWarRoom", () => ({
	useWarRoom: () => ({
		snapshot: null,
		paused: false,
		filter: "all",
		setPaused: vi.fn(),
		setFilter: vi.fn(),
	}),
}))

describe("OrvantaShell", () => {
	it("renders 4 tabs: Home, Agents, Inbox, Console", () => {
		mockCompanyStatus = "missing"
		mockPendingCount = 0
		render(<OrvantaShell activeTab="home" onTabChange={vi.fn()} />)
		expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Agents" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Inbox" })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Console" })).toBeInTheDocument()
	})

	it("disables Agents, Inbox when company missing; Console remains enabled", () => {
		mockCompanyStatus = "missing"
		render(<OrvantaShell activeTab="home" onTabChange={vi.fn()} />)
		const agentsBtn = screen.getByRole("button", { name: "Agents" })
		const inboxBtn = screen.getByRole("button", { name: "Inbox" })
		const consoleBtn = screen.getByRole("button", { name: "Console" })

		expect(agentsBtn).toBeDisabled()
		expect(agentsBtn).toHaveAttribute("title", "Lập công ty để mở Agents")

		expect(inboxBtn).toBeDisabled()
		expect(inboxBtn).toHaveAttribute("title", "Lập công ty trên Home để mở Inbox")

		expect(consoleBtn).toBeEnabled()
		expect(consoleBtn).toHaveAttribute("title", "Trung tâm tác chiến đa kênh (Console)")
	})

	it("enables Agents tab when company is ready and calls onTabChange when clicked", () => {
		mockCompanyStatus = "ready"
		const onTabChange = vi.fn()
		render(<OrvantaShell activeTab="home" onTabChange={onTabChange} />)

		const agentsBtn = screen.getByRole("button", { name: "Agents" })
		expect(agentsBtn).toBeEnabled()
		expect(agentsBtn).toHaveAttribute("title", "Sơ đồ tổ chức & quản lý Agents")

		fireEvent.click(agentsBtn)
		expect(onTabChange).toHaveBeenCalledWith("agents")
	})

	it("enables Inbox tab and displays badge when company is ready and has pending decisions", () => {
		mockCompanyStatus = "ready"
		mockPendingCount = 3
		const onTabChange = vi.fn()
		render(<OrvantaShell activeTab="home" onTabChange={onTabChange} />)

		const inboxBtn = screen.getByRole("button", { name: "Inbox, 3 pending" })
		expect(inboxBtn).toBeEnabled()
		expect(screen.getByText("3")).toBeInTheDocument()

		fireEvent.click(inboxBtn)
		expect(onTabChange).toHaveBeenCalledWith("inbox")
	})

	it("enables Home and Console tabs and calls onTabChange when clicked", () => {
		const onTabChange = vi.fn()
		render(<OrvantaShell activeTab="home" onTabChange={onTabChange} />)

		const consoleBtn = screen.getByRole("button", { name: "Console" })
		expect(consoleBtn).toBeEnabled()
		fireEvent.click(consoleBtn)
		expect(onTabChange).toHaveBeenCalledWith("console")
	})

	it("renders HomeView when activeTab is home", () => {
		render(<OrvantaShell activeTab="home" onTabChange={vi.fn()} />)
		expect(screen.getByTestId("mock-home-view")).toBeInTheDocument()
	})

	it("renders AgentsView when activeTab is agents", () => {
		render(<OrvantaShell activeTab="agents" onTabChange={vi.fn()} />)
		expect(screen.getByTestId("mock-agents-view")).toBeInTheDocument()
	})

	it("renders InboxView when activeTab is inbox", () => {
		render(<OrvantaShell activeTab="inbox" onTabChange={vi.fn()} />)
		expect(screen.getByTestId("mock-inbox-view")).toBeInTheDocument()
	})

	it("does not render HomeView, AgentsView, or InboxView when activeTab is console", () => {
		render(<OrvantaShell activeTab="console" onTabChange={vi.fn()} />)
		expect(screen.queryByTestId("mock-home-view")).not.toBeInTheDocument()
		expect(screen.queryByTestId("mock-agents-view")).not.toBeInTheDocument()
		expect(screen.queryByTestId("mock-inbox-view")).not.toBeInTheDocument()
	})

	it("switches smoothly between tabs and calls onTabChange", () => {
		mockCompanyStatus = "ready"
		const onTabChange = vi.fn()
		const { rerender } = render(<OrvantaShell activeTab="home" onTabChange={onTabChange} />)

		// Click Agents tab
		fireEvent.click(screen.getByRole("button", { name: "Agents" }))
		expect(onTabChange).toHaveBeenCalledWith("agents")

		// Re-render with activeTab="agents"
		rerender(<OrvantaShell activeTab="agents" onTabChange={onTabChange} />)
		expect(screen.getByTestId("mock-agents-view")).toBeInTheDocument()

		// Click Console tab
		fireEvent.click(screen.getByRole("button", { name: "Console" }))
		expect(onTabChange).toHaveBeenCalledWith("console")

		// Re-render with activeTab="console"
		rerender(<OrvantaShell activeTab="console" onTabChange={onTabChange} />)
		expect(screen.queryByTestId("mock-agents-view")).not.toBeInTheDocument()
	})
})
