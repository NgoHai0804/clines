import { OrvantaAgentProfile, type OrvantaCompanyResponse } from "@shared/proto/cline/orvanta"
import { fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import AgentsView, {
	AGENTS_SPLIT_DIVIDER,
	AGENTS_SPLIT_MIN_EDITOR,
	AGENTS_SPLIT_MIN_TREE,
	AGENTS_SPLIT_STORAGE_KEY,
	clampAgentsSplitTreeHeight,
} from "./AgentsView"

describe("AgentsView", () => {
	afterEach(() => {
		localStorage.removeItem(AGENTS_SPLIT_STORAGE_KEY)
		document.body.style.cursor = ""
		document.body.style.userSelect = ""
	})

	const mockCompany: OrvantaCompanyResponse = {
		company: {
			name: "Acme Corp",
			purpose: "Build great software",
			roster: {
				agents: [
					{
						id: "coordinator",
						displayName: "Company Coordinator",
						role: "lead",
						status: "running",
						reportsTo: undefined,
					},
					{
						id: "dev-lead",
						displayName: "Tech Lead",
						role: "lead",
						status: "idle",
						reportsTo: "coordinator",
					},
					{
						id: "developer-1",
						displayName: "Frontend Dev",
						role: "teammate",
						status: "idle",
						reportsTo: "dev-lead",
					},
				],
			},
		},
		profiles: {
			coordinator: {
				id: "coordinator",
				displayName: "Company Coordinator",
				role: "lead",
				description: "Điều phối viên",
				instructions: "## Coordinator\n- Điều phối toàn bộ hoạt động",
			} as OrvantaAgentProfile,
			"dev-lead": {
				id: "dev-lead",
				displayName: "Tech Lead",
				role: "lead",
				description: "Trưởng nhóm kỹ thuật",
				instructions: "## Lead\n- Quản lý kiến trúc",
				reportsTo: "coordinator",
			} as OrvantaAgentProfile,
			"developer-1": {
				id: "developer-1",
				displayName: "Frontend Dev",
				role: "teammate",
				description: "Lập trình viên giao diện",
				instructions: "## Dev\n- Lập trình React",
				reportsTo: "dev-lead",
			} as OrvantaAgentProfile,
		},
	}

	it("renders split view with Tree Chart at top and Editor at bottom", () => {
		render(<AgentsView company={mockCompany} />)

		expect(screen.getByTestId("agents-view")).toBeInTheDocument()
		expect(screen.getByTestId("agent-tree-chart")).toBeInTheDocument()
		expect(screen.getByTestId("split-divider")).toBeInTheDocument()
		expect(screen.getByTestId("agent-editor-panel")).toBeInTheDocument()
	})

	it("keeps the editor in document flow so the detail pane has height", () => {
		render(<AgentsView company={mockCompany} />)

		const editor = screen.getByTestId("agent-editor-panel")
		const detailPane = screen.getByTestId("agents-detail-pane")
		expect(editor.className).not.toMatch(/\babsolute\b/)
		expect(editor.className).toMatch(/\bh-full\b/)
		expect(editor.className).toMatch(/\boverflow-hidden\b/)
		expect(detailPane.className).toMatch(/\bflex-1\b/)
		expect(detailPane.className).toMatch(/\bmin-h-0\b/)
		expect(detailPane.className).toMatch(/\boverflow-hidden\b/)
		expect(detailPane).toContainElement(screen.getByTestId("agent-editor-scroll"))
		expect(screen.getByText(/Sửa agent:/)).toBeVisible()
		expect(screen.getByTestId("editor-tab-profile")).toBeVisible()
	})

	it("shows coordinator details when the real proto company shape has agents but no nested profiles", () => {
		const protoCompany: OrvantaCompanyResponse = {
			status: "ready",
			errors: [],
			id: "co-1",
			name: "Acme",
			purpose: "Build",
			teamName: "Core",
			agents: [
				{
					id: "coordinator",
					displayName: "Coordinator",
					role: "lead",
					status: "idle",
					reportsTo: undefined,
				},
			],
			tasksJson: "",
		}

		render(<AgentsView company={protoCompany} />)

		expect(screen.getByTestId("agent-editor-panel")).toBeVisible()
		expect(screen.getByPlaceholderText("Tên agent")).toHaveValue("Coordinator")
	})

	it("loads disk profile fields into the editor instead of roster stubs", () => {
		const protoCompany: OrvantaCompanyResponse = {
			status: "ready",
			errors: [],
			id: "co-1",
			name: "Acme",
			purpose: "Build",
			teamName: "Core",
			agents: [
				{
					id: "coordinator",
					displayName: "Coordinator",
					role: "lead",
					status: "idle",
				},
				{
					id: "implementer",
					displayName: "Dave",
					role: "teammate",
					status: "idle",
					reportsTo: "coordinator",
				},
			],
			tasksJson: "",
		}
		const profiles = {
			implementer: OrvantaAgentProfile.create({
				id: "implementer",
				displayName: "Dave Saved",
				role: "teammate",
				description: "from disk",
				instructions: "Persisted instructions from profile.md",
				filePath: "org/agents/implementer/profile.md",
				modelId: "claude-sonnet-4",
				maxIterations: 55,
			}),
		}

		render(<AgentsView company={protoCompany} profiles={profiles} />)
		fireEvent.click(screen.getByTestId("agent-node-implementer"))

		expect(screen.getByPlaceholderText("Tên agent")).toHaveValue("Dave Saved")
		expect(screen.getByTestId("profile-instructions-textarea")).toHaveValue("Persisted instructions from profile.md")
	})

	it("clamps the split so the editor never collapses below its minimum", () => {
		const container = 800
		const maxTree = container - AGENTS_SPLIT_DIVIDER - AGENTS_SPLIT_MIN_EDITOR
		expect(clampAgentsSplitTreeHeight(10, container)).toBe(AGENTS_SPLIT_MIN_TREE)
		expect(clampAgentsSplitTreeHeight(9999, container)).toBe(maxTree)
		expect(clampAgentsSplitTreeHeight(300, container)).toBe(300)
	})

	it("resizes the tree panel when dragging the split divider", () => {
		render(<AgentsView company={mockCompany} />)

		const view = screen.getByTestId("agents-view")
		Object.defineProperty(view, "clientHeight", { configurable: true, value: 800 })

		const treePanel = screen.getByTestId("agents-tree-panel")
		const startHeight = Number.parseInt(treePanel.style.height, 10)
		expect(startHeight).toBeGreaterThan(0)

		const divider = screen.getByTestId("split-divider")
		fireEvent.mouseDown(divider, { clientY: 300 })
		fireEvent.mouseMove(window, { clientY: 380 })
		fireEvent.mouseUp(window)

		const resized = Number.parseInt(treePanel.style.height, 10)
		expect(resized).toBe(clampAgentsSplitTreeHeight(startHeight + 80, 800))
		expect(screen.getByTestId("agent-editor-panel")).toBeVisible()
	})

	it("does not let a drag shrink the editor below the minimum", () => {
		render(<AgentsView company={mockCompany} />)

		const view = screen.getByTestId("agents-view")
		Object.defineProperty(view, "clientHeight", { configurable: true, value: 800 })

		const divider = screen.getByTestId("split-divider")
		fireEvent.mouseDown(divider, { clientY: 200 })
		fireEvent.mouseMove(window, { clientY: 2000 })
		fireEvent.mouseUp(window)

		const treePanel = screen.getByTestId("agents-tree-panel")
		const height = Number.parseInt(treePanel.style.height, 10)
		expect(height).toBe(800 - AGENTS_SPLIT_DIVIDER - AGENTS_SPLIT_MIN_EDITOR)
	})

	it("defaults to selecting coordinator in editor with coordinator disabled id", () => {
		render(<AgentsView company={mockCompany} />)

		// Coordinator should be active in editor
		const idInput = screen.getByPlaceholderText("ví dụ: reviewer") as HTMLInputElement
		expect(idInput.value).toBe("coordinator")
		expect(idInput).toBeDisabled()
	})

	it("selects agent when clicked in tree and updates bottom editor", () => {
		render(<AgentsView company={mockCompany} />)

		// Click "Tech Lead" card in tree
		const devLeadCard = screen.getByTestId("agent-node-dev-lead")
		fireEvent.click(devLeadCard)

		// Bottom editor should now show Tech Lead
		const nameInput = screen.getByPlaceholderText("Tên agent") as HTMLInputElement
		expect(nameInput.value).toBe("Tech Lead")
	})

	it("opens template picker and creates a new agent draft when template is chosen", () => {
		render(<AgentsView company={mockCompany} />)

		// Click "+ Thêm Agent"
		fireEvent.click(screen.getByTestId("add-agent-button"))

		// Modal should appear
		expect(screen.getByTestId("template-picker-modal")).toBeInTheDocument()

		// Pick "Reviewer" template
		fireEvent.click(screen.getByTestId("template-card-reviewer"))

		// Editor should now show new draft for reviewer
		const nameInput = screen.getByPlaceholderText("Tên agent") as HTMLInputElement
		expect(nameInput.value).toBe("Code Reviewer")

		const idInput = screen.getByPlaceholderText("ví dụ: reviewer") as HTMLInputElement
		expect(idInput.value).toBe("reviewer")
		expect(idInput).not.toBeDisabled()
	})

	it("calls onSaveAgentProfile when saving in editor", async () => {
		const onSave = vi.fn().mockResolvedValue(true)
		render(<AgentsView company={mockCompany} onSaveAgentProfile={onSave} />)

		// Select Tech Lead
		fireEvent.click(screen.getByTestId("agent-node-dev-lead"))

		// Edit display name
		const nameInput = screen.getByPlaceholderText("Tên agent")
		fireEvent.change(nameInput, { target: { value: "Lead Architect" } })

		// Click Save
		const saveButton = screen.getByTestId("editor-save-button")
		fireEvent.click(saveButton)

		expect(onSave).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "dev-lead",
				displayName: "Lead Architect",
			}),
		)
	})

	it("calls onDeleteAgentProfile when deleting an agent in editor", async () => {
		const onDelete = vi.fn().mockResolvedValue(true)
		render(<AgentsView company={mockCompany} onDeleteAgentProfile={onDelete} />)

		// Select Frontend Dev
		fireEvent.click(screen.getByTestId("agent-node-developer-1"))

		// Click fire button
		const fireBtn = screen.getAllByTestId("quick-fire-button")[0]
		fireEvent.click(fireBtn)

		// Confirm in modal
		const confirmBtn = screen.getByTestId("confirm-delete-button")
		fireEvent.click(confirmBtn)

		expect(onDelete).toHaveBeenCalledWith("developer-1")
	})
})
