import type { ClineMessage } from "@shared/ExtensionMessage"
import type { OrvantaRosterAgent } from "@shared/proto/cline/orvanta"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApprovalNeededToast, resolvePendingAgentApproval } from "./ApprovalNeededToast"

const ask: ClineMessage = {
	ts: 42,
	type: "ask",
	ask: "tool",
	agentId: "implementer",
	text: JSON.stringify({ tool: "editedExistingFile", path: "hello.py" }),
}

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(() => ({
		turnState: { phase: "awaiting_approval", anchorTs: 42, seq: 1 },
		clineMessages: [ask],
	})),
}))

import { useExtensionState } from "@/context/ExtensionStateContext"

const agents: OrvantaRosterAgent[] = [
	{ id: "coordinator", displayName: "Coordinator", role: "lead", status: "idle" },
	{ id: "implementer", displayName: "Dave", role: "implementer", status: "running" },
]

describe("resolvePendingAgentApproval", () => {
	it("returns owning agent for awaiting_approval ask", () => {
		expect(resolvePendingAgentApproval({ phase: "awaiting_approval", anchorTs: 42 }, [ask])).toEqual({
			agentId: "implementer",
			anchorTs: 42,
			phase: "awaiting_approval",
			summary: "cần duyệt công cụ",
		})
	})

	it("defaults missing agentId to coordinator", () => {
		const legacy: ClineMessage = { ...ask, agentId: undefined, agent_id: undefined }
		expect(resolvePendingAgentApproval({ phase: "awaiting_approval", anchorTs: 42 }, [legacy])?.agentId).toBe("coordinator")
	})

	it("returns null when turn is not waiting", () => {
		expect(resolvePendingAgentApproval({ phase: "streaming", anchorTs: 42 }, [ask])).toBeNull()
	})
})

describe("ApprovalNeededToast", () => {
	beforeEach(() => {
		vi.mocked(useExtensionState).mockReturnValue({
			turnState: { phase: "awaiting_approval", anchorTs: 42, seq: 1 },
			clineMessages: [ask],
		} as ReturnType<typeof useExtensionState>)
	})

	it("shows toast when focused on another channel and navigates on click", () => {
		const onSelectAgent = vi.fn()
		render(<ApprovalNeededToast agents={agents} focusAgentId="team-feed" onSelectAgent={onSelectAgent} />)

		expect(screen.getByTestId("approval-needed-toast")).toBeInTheDocument()
		expect(screen.getByText(/Dave cần duyệt công cụ/)).toBeInTheDocument()
		fireEvent.click(screen.getByText(/Bấm để mở Agent và duyệt/))
		expect(onSelectAgent).toHaveBeenCalledWith("implementer")
	})

	it("hides toast when already viewing the owning Agent", () => {
		render(<ApprovalNeededToast agents={agents} focusAgentId="implementer" onSelectAgent={vi.fn()} />)
		expect(screen.queryByTestId("approval-needed-toast")).not.toBeInTheDocument()
	})

	it("can be dismissed until the next pending ask", () => {
		render(<ApprovalNeededToast agents={agents} focusAgentId="coordinator" onSelectAgent={vi.fn()} />)
		fireEvent.click(screen.getByLabelText("Đóng"))
		expect(screen.queryByTestId("approval-needed-toast")).not.toBeInTheDocument()
	})
})
