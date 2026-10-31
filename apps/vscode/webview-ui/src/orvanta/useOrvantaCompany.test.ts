import type { OrvantaAgentProfile, OrvantaCompanyResponse } from "@shared/proto/cline/orvanta"
import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { OrvantaServiceClient } from "@/services/grpc-client"
import { useOrvantaCompany } from "./useOrvantaCompany"

vi.mock("@/services/grpc-client", () => ({
	OrvantaServiceClient: {
		getCompany: vi.fn(),
		subscribeCompany: vi.fn(),
		createCompany: vi.fn(),
		listAgentProfiles: vi.fn(),
		upsertAgentProfile: vi.fn(),
		deleteAgentProfile: vi.fn(),
	},
}))

describe("useOrvantaCompany", () => {
	const mockGetCompany = vi.mocked(OrvantaServiceClient.getCompany)
	const mockSubscribeCompany = vi.mocked(OrvantaServiceClient.subscribeCompany)
	const mockCreateCompany = vi.mocked(OrvantaServiceClient.createCompany)
	const mockListAgentProfiles = vi.mocked(OrvantaServiceClient.listAgentProfiles)
	const mockUpsertAgentProfile = vi.mocked(OrvantaServiceClient.upsertAgentProfile)

	beforeEach(() => {
		vi.clearAllMocks()
		mockListAgentProfiles.mockResolvedValue({ profiles: [] })
		mockSubscribeCompany.mockReturnValue(vi.fn())
	})

	it("initializes with loading and subscribes on mount", async () => {
		let streamCallback: ((resp: OrvantaCompanyResponse) => void) | undefined
		const unsubscribe = vi.fn()

		mockGetCompany.mockResolvedValue({
			status: "missing",
			errors: [],
			id: "",
			name: "",
			purpose: "",
			teamName: "",
			agents: [],
		})

		mockSubscribeCompany.mockImplementation((_req, callbacks) => {
			streamCallback = callbacks.onResponse
			return unsubscribe
		})

		const { result } = renderHook(() => useOrvantaCompany())

		await act(async () => {
			await Promise.resolve()
		})

		expect(mockGetCompany).toHaveBeenCalled()
		expect(mockSubscribeCompany).toHaveBeenCalled()

		// Stream emits ready state
		await act(async () => {
			streamCallback?.({
				status: "ready",
				errors: [],
				id: "corp-1",
				name: "Acme",
				purpose: "Build great things",
				teamName: "acme",
				agents: [],
			})
			await Promise.resolve()
		})

		expect(result.current.loading).toBe(false)
		expect(result.current.company.status).toBe("ready")
		expect(result.current.company.name).toBe("Acme")
		expect(mockListAgentProfiles).toHaveBeenCalled()
	})

	it("loads agent profiles when company is ready", async () => {
		const profile = {
			id: "implementer",
			displayName: "Dave",
			role: "teammate",
			description: "dev",
			instructions: "Implement features",
			filePath: "org/agents/implementer/profile.md",
			autoApprovalJson: JSON.stringify({ enabled: true, editFiles: true }),
		} as OrvantaAgentProfile

		mockGetCompany.mockResolvedValue({
			status: "ready",
			errors: [],
			id: "corp-1",
			name: "Acme",
			purpose: "Build",
			teamName: "acme",
			agents: [],
		})
		mockListAgentProfiles.mockResolvedValue({ profiles: [profile] })

		const { result } = renderHook(() => useOrvantaCompany())

		await act(async () => {
			await Promise.resolve()
			await Promise.resolve()
		})

		expect(result.current.agentProfiles.implementer?.instructions).toBe("Implement features")
		expect(result.current.agentProfiles.implementer?.autoApprovalJson).toContain("editFiles")
	})

	it("createCompany updates company on success", async () => {
		mockGetCompany.mockResolvedValue({
			status: "missing",
			errors: [],
			id: "",
			name: "",
			purpose: "",
			teamName: "",
			agents: [],
		})

		const readyCompany: OrvantaCompanyResponse = {
			status: "ready",
			errors: [],
			id: "corp-new",
			name: "New Corp",
			purpose: "Valid purpose for testing",
			teamName: "new-corp",
			agents: [],
		}
		mockCreateCompany.mockResolvedValue(readyCompany)

		const { result } = renderHook(() => useOrvantaCompany())

		await act(async () => {
			await result.current.createCompany("New Corp", "Valid purpose for testing")
		})

		expect(mockCreateCompany).toHaveBeenCalledWith({
			name: "New Corp",
			purpose: "Valid purpose for testing",
		})
		expect(result.current.company.status).toBe("ready")
		expect(result.current.company.id).toBe("corp-new")
		expect(result.current.createError).toBeUndefined()
		expect(mockListAgentProfiles).toHaveBeenCalled()
	})

	it("createCompany sets createError on failure", async () => {
		mockGetCompany.mockResolvedValue({
			status: "missing",
			errors: [],
			id: "",
			name: "",
			purpose: "",
			teamName: "",
			agents: [],
		})

		mockCreateCompany.mockResolvedValue({
			status: "missing",
			errors: ["Tên đã tồn tại"],
			id: "",
			name: "",
			purpose: "",
			teamName: "",
			agents: [],
		})

		const { result } = renderHook(() => useOrvantaCompany())

		await act(async () => {
			await result.current.createCompany("Existing Corp", "Valid purpose for testing")
		})

		expect(result.current.createError).toBe("Tên đã tồn tại")
	})

	it("marks company broken when getCompany fails", async () => {
		mockGetCompany.mockRejectedValue(new Error("Unauthorized"))

		const { result } = renderHook(() => useOrvantaCompany())

		await act(async () => {
			await Promise.resolve()
			await Promise.resolve()
		})

		expect(result.current.loading).toBe(false)
		expect(result.current.company.status).toBe("broken")
		expect(result.current.company.errors[0]).toContain("Unauthorized")
	})

	it("saveAgentProfile upserts and keeps returned profile in agentProfiles", async () => {
		mockGetCompany.mockResolvedValue({
			status: "ready",
			errors: [],
			id: "corp-1",
			name: "Acme",
			purpose: "Build",
			teamName: "acme",
			agents: [],
		})
		mockListAgentProfiles.mockResolvedValue({ profiles: [] })

		const saved = {
			id: "implementer",
			displayName: "Dave Updated",
			role: "teammate",
			description: "dev",
			instructions: "New instructions",
			filePath: "org/agents/implementer/profile.md",
			autoApprovalJson: JSON.stringify({ enabled: true, editFiles: true }),
		} as OrvantaAgentProfile
		mockUpsertAgentProfile.mockResolvedValue(saved)
		mockListAgentProfiles.mockResolvedValueOnce({ profiles: [] }).mockResolvedValue({ profiles: [saved] })

		const { result } = renderHook(() => useOrvantaCompany())

		await act(async () => {
			await Promise.resolve()
			await Promise.resolve()
		})

		let ok = false
		await act(async () => {
			ok = await result.current.saveAgentProfile(saved)
		})

		expect(ok).toBe(true)
		expect(mockUpsertAgentProfile).toHaveBeenCalledWith(saved)
		expect(result.current.agentProfiles.implementer?.displayName).toBe("Dave Updated")
		expect(result.current.agentProfiles.implementer?.instructions).toBe("New instructions")
	})
})
