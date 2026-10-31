import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	KNOWLEDGE_DIRNAME,
	MANDATORY_DENY_WRITE_PATHS,
	PURPOSE_FILE,
	WORKSPACE_DIRNAME,
	WORKSPACE_TMP_DIRNAME,
} from "@cline/shared"
import { afterEach, describe, expect, it } from "vitest"
import {
	CannotDeleteCoordinatorError,
	CompanyAlreadyExistsError,
	CompanyNameMismatchError,
	createCompany,
	deleteCompany,
	getAgent,
	getAgentMemory,
	getAgentProfile,
	initCompanyKnowledge,
	listAgentProfiles,
	loadCompany,
	pathExists,
	pickWorkspaceRoot,
	removeAgent,
	saveAgentMemory,
	upsertAgent,
} from "./workspace-store"

const PURPOSE = "Xây công ty AI theo từng repo, giữ agent đúng mục tiêu."

const created: string[] = []

afterEach(async () => {
	await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "orvanta-ws-"))
	created.push(dir)
	return dir
}

describe("pickWorkspaceRoot", () => {
	it("returns the folder that already has .orvanta", async () => {
		const a = await tempWorkspace()
		const b = await tempWorkspace()
		await mkdir(join(b, WORKSPACE_DIRNAME))
		expect(await pickWorkspaceRoot([a, b])).toBe(b)
	})

	it("falls back to the first folder", async () => {
		const a = await tempWorkspace()
		expect(await pickWorkspaceRoot([a])).toBe(a)
	})
})

describe("workspace-store", () => {
	it("loads missing when the folder is empty", async () => {
		const root = await tempWorkspace()
		expect(await loadCompany(root)).toEqual({ status: "missing" })
	})

	it("loads missing when .orvanta only has runtime local storage", async () => {
		const root = await tempWorkspace()
		const marker = join(root, WORKSPACE_DIRNAME, "local", "sdk", "db", "sessions.db")
		await mkdir(join(marker, ".."), { recursive: true })
		await writeFile(marker, "sdk", "utf8")
		expect(await loadCompany(root)).toEqual({ status: "missing" })
	})

	it("creates a company into an existing .orvanta that only has local storage", async () => {
		const root = await tempWorkspace()
		const marker = join(root, WORKSPACE_DIRNAME, "local", "sdk", "db", "sessions.db")
		await mkdir(join(marker, ".."), { recursive: true })
		await writeFile(marker, "sdk", "utf8")
		const createdCompany = await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		expect(createdCompany.status).toBe("ready")
		expect(await pathExists(marker)).toBe(true)
		expect(await readFile(marker, "utf8")).toBe("sdk")
	})

	it("creates then loads a ready company", async () => {
		const root = await tempWorkspace()
		const createdCompany = await createCompany(root, {
			name: "Orvanta",
			purpose: PURPOSE,
		})
		expect(createdCompany.status).toBe("ready")
		if (createdCompany.status !== "ready") {
			return
		}
		expect(createdCompany.company.name).toBe("Orvanta")
		expect(createdCompany.company.teamName).toBe("orvanta")
		expect(createdCompany.roster.agents).toHaveLength(1)
		expect(createdCompany.roster.agents[0]?.id).toBe("coordinator")
		expect(await loadCompany(root)).toEqual(createdCompany)
	})

	it("is broken when purpose.md is missing", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		await rm(join(root, WORKSPACE_DIRNAME, PURPOSE_FILE))
		const loaded = await loadCompany(root)
		expect(loaded.status).toBe("broken")
		if (loaded.status === "broken") {
			expect(loaded.errors).toContain("thiếu purpose.md")
		}
	})

	it("rejects create when a company already exists", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		await expect(createCompany(root, { name: "Other", purpose: PURPOSE })).rejects.toBeInstanceOf(CompanyAlreadyExistsError)
	})

	it("leaves no .orvanta.tmp after a successful create", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		expect(await pathExists(join(root, WORKSPACE_TMP_DIRNAME))).toBe(false)
		expect(await pathExists(join(root, WORKSPACE_DIRNAME))).toBe(true)
	})

	it("deletes company when confirmed name matches, rejects mismatch", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Acme Corp", purpose: PURPOSE })
		await expect(deleteCompany(root, "Wrong Name")).rejects.toBeInstanceOf(CompanyNameMismatchError)
		expect((await loadCompany(root)).status).toBe("ready")

		await deleteCompany(root, "Acme Corp")
		expect((await loadCompany(root)).status).toBe("missing")
		expect(await pathExists(join(root, WORKSPACE_DIRNAME))).toBe(false)
	})
	it("upserts a new teammate agent, creates profile.md and memory.md, and adds to roster", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		const created = await upsertAgent(root, {
			id: "reviewer",
			displayName: "Code Reviewer",
			role: "teammate",
			instructions: "Review code thoroughly and accurately.",
		})
		expect(created.id).toBe("reviewer")
		expect(created.displayName).toBe("Code Reviewer")
		expect(created.role).toBe("teammate")
		for (const p of MANDATORY_DENY_WRITE_PATHS) {
			expect(created.scopePaths.denyWrite).toContain(p)
		}

		// check profile.md and memory.md on disk
		const profilePath = join(root, WORKSPACE_DIRNAME, "org", "agents", "reviewer", "profile.md")
		const memoryPath = join(root, WORKSPACE_DIRNAME, "org", "agents", "reviewer", "workspace", "memory.md")
		expect(await pathExists(profilePath)).toBe(true)
		expect(await pathExists(memoryPath)).toBe(true)

		// check listAgentProfiles
		const profiles = await listAgentProfiles(root)
		expect(profiles).toHaveLength(2)
		expect(profiles[0].id).toBe("coordinator")
		expect(profiles[1].id).toBe("reviewer")

		// check roster has reviewer
		const loaded = await loadCompany(root)
		if (loaded.status === "ready") {
			expect(loaded.roster.agents).toHaveLength(2)
			expect(loaded.roster.agents.find((a) => a.id === "reviewer")).toBeDefined()
		}
	})

	it("preserves mandatory denyWrite paths even if user specifies custom denyWrite", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		const created = await upsertAgent(root, {
			id: "reviewer",
			displayName: "Reviewer",
			role: "teammate",
			instructions: "Review code.",
			scopePaths: {
				allow: ["src/**"],
				denyWrite: ["secret.txt"],
			},
		})
		for (const p of MANDATORY_DENY_WRITE_PATHS) {
			expect(created.scopePaths.denyWrite).toContain(p)
		}
		expect(created.scopePaths.denyWrite).toContain("secret.txt")
	})

	it("rejects uppercase id, empty instructions, or second lead", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })

		// Uppercase id
		await expect(
			upsertAgent(root, {
				id: "Reviewer",
				displayName: "Reviewer",
				role: "teammate",
				instructions: "Review code.",
			}),
		).rejects.toThrow()

		// Empty instructions
		await expect(
			upsertAgent(root, {
				id: "reviewer",
				displayName: "Reviewer",
				role: "teammate",
				instructions: "",
			}),
		).rejects.toThrow()

		// Second lead
		await expect(
			upsertAgent(root, {
				id: "reviewer",
				displayName: "Reviewer",
				role: "lead",
				instructions: "Lead reviewer.",
			}),
		).rejects.toThrow("Không thể có hai lead")
	})

	it("updates existing agent prompt and frontmatter", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		await upsertAgent(root, {
			id: "reviewer",
			displayName: "Reviewer",
			role: "teammate",
			instructions: "Old prompt.",
		})

		const updated = await upsertAgent(root, {
			id: "reviewer",
			displayName: "Senior Reviewer",
			role: "teammate",
			instructions: "New updated prompt.",
			modelId: "anthropic/claude-3-7-sonnet",
		})
		expect(updated.displayName).toBe("Senior Reviewer")
		expect(updated.instructions).toBe("New updated prompt.")
		expect(updated.modelId).toBe("anthropic/claude-3-7-sonnet")

		const detail = await getAgent(root, "reviewer")
		expect(detail).toBeDefined()
		expect(detail?.profile.displayName).toBe("Senior Reviewer")
		expect(detail?.profile.instructions).toBe("New updated prompt.")
	})

	it("deletes teammate agent, removes folder and updates roster", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		await upsertAgent(root, {
			id: "reviewer",
			displayName: "Reviewer",
			role: "teammate",
			instructions: "Review code.",
		})
		expect(await listAgentProfiles(root)).toHaveLength(2)

		await removeAgent(root, "reviewer")

		expect(await listAgentProfiles(root)).toHaveLength(1)
		const agentDir = join(root, WORKSPACE_DIRNAME, "org", "agents", "reviewer")
		expect(await pathExists(agentDir)).toBe(false)

		const loaded = await loadCompany(root)
		if (loaded.status === "ready") {
			expect(loaded.roster.agents).toHaveLength(1)
			expect(loaded.roster.agents.find((a) => a.id === "reviewer")).toBeUndefined()
		}
	})

	it("rejects deleting coordinator with CannotDeleteCoordinatorError", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })
		await expect(removeAgent(root, "coordinator")).rejects.toBeInstanceOf(CannotDeleteCoordinatorError)

		// Coordinator files still intact
		const coordinatorProfile = join(root, WORKSPACE_DIRNAME, "org", "agents", "coordinator", "profile.md")
		expect(await pathExists(coordinatorProfile)).toBe(true)
	})

	it("saves full v0.0.2 profile fields and persists reportsTo in roster.json", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })

		const created = await upsertAgent(root, {
			id: "implementer",
			displayName: "Lead Implementer",
			description: "Implement features.",
			role: "teammate",
			reportsTo: "coordinator",
			providerId: "anthropic",
			modelId: "claude-3-7-sonnet-20250219",
			maxIterations: 40,
			temperature: 0.2,
			reasoningEffort: "medium",
			supportsImages: true,
			contextWindow: 200000,
			maxOutputTokens: 16384,
			rules: ["code-simplification", "test-driven-development"],
			skills: ["code-review-and-quality"],
			instructions: "Implement clean code.",
		})

		expect(created.reportsTo).toBe("coordinator")
		expect(created.reasoningEffort).toBe("medium")
		expect(created.supportsImages).toBe(true)
		expect(created.contextWindow).toBe(200000)
		expect(created.maxOutputTokens).toBe(16384)
		expect(created.rules).toEqual(["code-simplification", "test-driven-development"])
		expect(created.skills).toEqual(["code-review-and-quality"])

		// verify profile on disk
		const loadedProfile = await getAgentProfile(root, "implementer")
		expect(loadedProfile).toBeDefined()
		expect(loadedProfile?.reportsTo).toBe("coordinator")
		expect(loadedProfile?.reasoningEffort).toBe("medium")
		expect(loadedProfile?.supportsImages).toBe(true)
		expect(loadedProfile?.contextWindow).toBe(200000)
		expect(loadedProfile?.maxOutputTokens).toBe(16384)
		expect(loadedProfile?.rules).toEqual(["code-simplification", "test-driven-development"])
		expect(loadedProfile?.skills).toEqual(["code-review-and-quality"])

		// verify roster on disk has reportsTo
		const loaded = await loadCompany(root)
		expect(loaded.status).toBe("ready")
		if (loaded.status === "ready") {
			const coordinatorRoster = loaded.roster.agents.find((a) => a.id === "coordinator")
			expect(coordinatorRoster?.reportsTo).toBeNull()

			const implementerRoster = loaded.roster.agents.find((a) => a.id === "implementer")
			expect(implementerRoster?.reportsTo).toBe("coordinator")
		}
	})
	it("reads and writes agent memory independently with persistence", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })

		// Coordinator memory initially empty
		expect(await getAgentMemory(root, "coordinator")).toBe("")

		// Non-existent agent memory returns empty
		expect(await getAgentMemory(root, "unknown-agent")).toBe("")

		// Upsert implementer and reviewer
		await upsertAgent(root, {
			id: "implementer",
			displayName: "Implementer",
			role: "teammate",
			instructions: "Write code.",
		})
		await upsertAgent(root, {
			id: "reviewer",
			displayName: "Reviewer",
			role: "teammate",
			instructions: "Review code.",
		})

		// Save distinct memories
		const coordMemory = "# Coordinator Learnings\n- Always dispatch via team_run_task\n- Deliverables in artifacts/"
		const implMemory = "# Implementer Learnings\n- Use bun test, never npm test\n- Follow coding standards"
		const revMemory = "# Reviewer Learnings\n- Verify DoD strictly before approve\n- Max 2 retries"

		await saveAgentMemory(root, "coordinator", coordMemory)
		await saveAgentMemory(root, "implementer", implMemory)
		await saveAgentMemory(root, "reviewer", revMemory)

		// Verify memories are independent and exact
		expect(await getAgentMemory(root, "coordinator")).toBe(coordMemory)
		expect(await getAgentMemory(root, "implementer")).toBe(implMemory)
		expect(await getAgentMemory(root, "reviewer")).toBe(revMemory)

		// Verify getAgent also returns the memory
		const implementerDetail = await getAgent(root, "implementer")
		expect(implementerDetail?.memory).toBe(implMemory)

		// Updating agent profile does not wipe memory
		await upsertAgent(root, {
			id: "implementer",
			displayName: "Senior Implementer",
			role: "teammate",
			instructions: "Updated instructions.",
		})
		expect(await getAgentMemory(root, "implementer")).toBe(implMemory)
	})

	it("initializes company knowledge base without overwriting existing files", async () => {
		const root = await tempWorkspace()
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE })

		const knowledgeDir = join(root, WORKSPACE_DIRNAME, KNOWLEDGE_DIRNAME)
		const brandPath = join(knowledgeDir, "brand-guidelines.md")
		const codingPath = join(knowledgeDir, "coding-standards.md")

		// Knowledge files should exist from createCompany
		expect(await pathExists(brandPath)).toBe(true)
		expect(await pathExists(codingPath)).toBe(true)

		// Customize a file
		const customBrand = "# Custom Brand Voice\n- Bold and direct."
		await writeFile(brandPath, customBrand, "utf8")

		// Re-run initCompanyKnowledge
		await initCompanyKnowledge(root)

		// Custom content must be preserved
		const brandContent = await readFile(brandPath, "utf8")
		expect(brandContent).toBe(customBrand)
	})
})
