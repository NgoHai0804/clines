import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KNOWLEDGE_DIRNAME, PURPOSE_FILE, ROSTER_FILE, WORKSPACE_DIRNAME, WORKSPACE_TMP_DIRNAME } from "./paths";
import {
	CompanyAlreadyExistsError,
	createCompany,
	deleteCompany,
	getAgentProfile,
	getAgentMemory,
	initCompanyKnowledge,
	loadCompany,
	pathExists,
	pickWorkspaceRoot,
	saveAgentMemory,
	removeAgent,
	upsertAgent,
    CompanyNameMismatchError,
} from "./workspace-store";

const PURPOSE =
	"Xây công ty AI theo từng repo, giữ agent đúng mục tiêu.";

const created: string[] = [];

afterEach(async () => {
	await Promise.all(
		created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

async function tempWorkspace(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "orvanta-ws-"));
	created.push(dir);
	return dir;
}

describe("pickWorkspaceRoot", () => {
	it("returns the folder that already has .orvanta", async () => {
		const a = await tempWorkspace();
		const b = await tempWorkspace();
		await mkdir(join(b, WORKSPACE_DIRNAME));
		expect(await pickWorkspaceRoot([a, b])).toBe(b);
	});

	it("falls back to the first folder", async () => {
		const a = await tempWorkspace();
		expect(await pickWorkspaceRoot([a])).toBe(a);
	});
});

describe("workspace-store", () => {
	it("loads missing when the folder is empty", async () => {
		const root = await tempWorkspace();
		expect(await loadCompany(root)).toEqual({ status: "missing" });
	});

	it("loads missing when .orvanta only has runtime local storage", async () => {
		const root = await tempWorkspace();
		const marker = join(root, WORKSPACE_DIRNAME, "local", "sdk", "db", "sessions.db");
		await mkdir(join(marker, ".."), { recursive: true });
		await writeFile(marker, "sdk", "utf8");
		expect(await loadCompany(root)).toEqual({ status: "missing" });
	});

	it("creates a company into an existing .orvanta that only has local storage", async () => {
		const root = await tempWorkspace();
		const marker = join(root, WORKSPACE_DIRNAME, "local", "sdk", "db", "sessions.db");
		await mkdir(join(marker, ".."), { recursive: true });
		await writeFile(marker, "sdk", "utf8");
		const createdCompany = await createCompany(root, {
			name: "Orvanta",
			purpose: PURPOSE,
		});
		expect(createdCompany.status).toBe("ready");
		expect(await pathExists(marker)).toBe(true);
		expect(await readFile(marker, "utf8")).toBe("sdk");
		expect(await loadCompany(root)).toEqual(createdCompany);
	});

	it("is broken when purpose.md is missing from an otherwise present company", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		await rm(join(root, WORKSPACE_DIRNAME, PURPOSE_FILE));
		const loaded = await loadCompany(root);
		expect(loaded.status).toBe("broken");
		if (loaded.status === "broken") {
			expect(loaded.errors).toContain("thiếu purpose.md");
		}
	});

	it("creates then loads a ready company", async () => {
		const root = await tempWorkspace();
		const createdCompany = await createCompany(root, {
			name: "Orvanta",
			purpose: PURPOSE,
		});
		expect(createdCompany.status).toBe("ready");
		if (createdCompany.status !== "ready") {
			return;
		}
		expect(createdCompany.company.name).toBe("Orvanta");
		expect(createdCompany.company.teamName).toBe("orvanta");
		expect(createdCompany.roster.agents).toHaveLength(1);
		expect(createdCompany.roster.agents[0]?.id).toBe("coordinator");
		expect(createdCompany.roster.agents[0]?.agentNumericId).toBe(1);
		expect(createdCompany.roster.nextAgentNumericId).toBe(2);
		expect(await loadCompany(root)).toEqual(createdCompany);
	});

	it("deletes the company only after exact name confirmation", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		await expect(deleteCompany(root, "wrong")).rejects.toBeInstanceOf(CompanyNameMismatchError);
		expect((await loadCompany(root)).status).toBe("ready");
		await deleteCompany(root, "Orvanta");
		expect((await loadCompany(root)).status).toBe("missing");
	});

	it("allocates unique authoritative IDs concurrently and never reuses retired IDs", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		const [first, second] = await Promise.all([
			upsertAgent(root, { id: "reviewer", role: "teammate", instructions: "Review code." }),
			upsertAgent(root, { id: "implementer", role: "teammate", instructions: "Write code." }),
		]);
		expect([first.agentNumericId, second.agentNumericId].sort()).toEqual([2, 3]);
		await removeAgent(root, first.id);
		const next = await upsertAgent(root, { id: "designer", role: "teammate", instructions: "Design systems." });
		expect(next.agentNumericId).toBe(4);
		const reloaded = await loadCompany(root);
		expect(reloaded.status).toBe("ready");
		if (reloaded.status === "ready") {
			expect(reloaded.roster.retiredAgents.map((agent) => agent.agentNumericId)).toContain(first.agentNumericId);
			expect(reloaded.roster.nextAgentNumericId).toBe(5);
		}
	});

	it("allocates unique IDs across independent Node writer processes", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		const sharedPackage = import.meta.dirname;
		const moduleUrl = pathToFileURL(join(sharedPackage, "workspace-store.ts")).href;
		const source = `import { upsertAgent } from ${JSON.stringify(moduleUrl)};\nawait upsertAgent(process.argv[2], { id: process.argv[3], role: "teammate", instructions: "test" });`;
		const script = join(root, "writer.mts");
		await writeFile(script, source, "utf8");
		const run = (id: string) => new Promise<void>((resolve, reject) => {
			const child = spawn("bun", [script, root, id], { stdio: ["ignore", "pipe", "pipe"] });
			let stderr = "";
			child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
			child.once("error", reject);
			child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr)));
		});
		await Promise.all([run("writer-one"), run("writer-two")]);
		const loaded = await loadCompany(root);
		expect(loaded.status).toBe("ready");
		if (loaded.status === "ready") {
			expect(loaded.roster.agents.filter((agent) => agent.id.startsWith("writer-")).map((agent) => agent.agentNumericId).sort()).toEqual([2, 3]);
			expect(loaded.roster.nextAgentNumericId).toBe(4);
		}
	});

	it("rejects reusing a retired slug, preventing ambiguous legacy resolution", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		const old = await upsertAgent(root, { id: "reviewer", role: "teammate", instructions: "Review." });
		await removeAgent(root, old.id);
		await expect(upsertAgent(root, { id: "reviewer", role: "teammate", instructions: "New reviewer." })).rejects.toThrow(/retired/i);
		const { resolveLegacyAgentSlug } = await import("./company-schema");
		const load = await loadCompany(root);
		expect(load.status).toBe("ready");
		if (load.status === "ready") expect(resolveLegacyAgentSlug(load.roster, "reviewer")).toEqual({ status: "resolved", agentNumericId: old.agentNumericId });
	});

	it("renames a slug without changing numeric identity and keeps an old-slug alias", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		const original = await upsertAgent(root, { id: "reviewer", role: "teammate", instructions: "Review code." });
		const renamed = await upsertAgent(root, {
			...original,
			id: "quality-reviewer",
			displayName: "Quality Reviewer",
			filePath: "org/agents/reviewer/profile.md",
		});
		expect(renamed.agentNumericId).toBe(original.agentNumericId);
		expect(renamed.filePath).toBe("org/agents/quality-reviewer/profile.md");
		expect(await pathExists(join(root, WORKSPACE_DIRNAME, "org", "agents", "reviewer"))).toBe(false);
		expect(await pathExists(join(root, WORKSPACE_DIRNAME, "org", "agents", "quality-reviewer", "profile.md"))).toBe(true);
		const reloaded = await loadCompany(root);
		expect(reloaded.status).toBe("ready");
		if (reloaded.status === "ready") {
			expect(reloaded.roster.agents.find((agent) => agent.id === "quality-reviewer")?.agentNumericId).toBe(original.agentNumericId);
			expect(reloaded.roster.agents.find((agent) => agent.id === "quality-reviewer")?.legacySlugs).toContain("reviewer");
		}
	});

	it("fails rename atomically when a child profile cannot be updated", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		const manager = await upsertAgent(root, { id: "manager", role: "teammate", instructions: "Manage." });
		await upsertAgent(root, { id: "member", role: "teammate", reportsTo: "manager", instructions: "Work." });
		const memberProfile = join(root, WORKSPACE_DIRNAME, "org", "agents", "member", "profile.md");
		await writeFile(memberProfile, "invalid profile", "utf8");
		await expect(upsertAgent(root, { ...manager, id: "team-lead", filePath: "org/agents/manager/profile.md" })).rejects.toThrow();
		expect(await pathExists(join(root, WORKSPACE_DIRNAME, "org", "agents", "manager", "profile.md"))).toBe(true);
		expect(await pathExists(join(root, WORKSPACE_DIRNAME, "org", "agents", "team-lead"))).toBe(false);
		const loaded = await loadCompany(root);
		expect(loaded.status).toBe("ready");
		if (loaded.status === "ready") expect(loaded.roster.agents.some((agent) => agent.id === "manager")).toBe(true);
	});

	it("updates reportsTo profile references and uses the renamed agent file path", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		const manager = await upsertAgent(root, { id: "manager", role: "teammate", instructions: "Manage." });
		await upsertAgent(root, { id: "member", role: "teammate", reportsTo: "manager", instructions: "Work." });
		await upsertAgent(root, { ...manager, id: "team-lead", filePath: "org/agents/manager/profile.md" });
		const member = await getAgentProfile(root, "member");
		expect(member?.reportsTo).toBe("team-lead");
		const loaded = await loadCompany(root);
		expect(loaded.status).toBe("ready");
		if (loaded.status === "ready") {
			expect(loaded.roster.agents.find((agent) => agent.id === "member")?.reportsTo).toBe("team-lead");
			expect(loaded.roster.agents.find((agent) => agent.id === "team-lead")?.agentFile).toBe("org/agents/team-lead/profile.md");
		}
	});

	it("updates an existing profile without reallocating its identity", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		const original = await upsertAgent(root, { id: "reviewer", role: "teammate", instructions: "Review code." });
		const updated = await upsertAgent(root, { id: "reviewer", role: "teammate", instructions: "Different." });
		expect(updated.agentNumericId).toBe(original.agentNumericId);
		expect(updated.instructions).toBe("Different.");
	});

	it("is broken when purpose.md is missing", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		await rm(join(root, WORKSPACE_DIRNAME, PURPOSE_FILE));
		const loaded = await loadCompany(root);
		expect(loaded.status).toBe("broken");
		if (loaded.status === "broken") {
			expect(loaded.errors).toContain("thiếu purpose.md");
		}
	});

	it("rejects create when a company already exists", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		await expect(
			createCompany(root, { name: "Other", purpose: PURPOSE }),
		).rejects.toBeInstanceOf(CompanyAlreadyExistsError);
	});

	it("preserves ID stability across reorder roster, restart, rename, retire, restore backup, and duplicate slug", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });

		// 1. Initial creation gives coordinator ID 1, nextAgentNumericId 2
		const architect = await upsertAgent(root, { id: "architect", role: "teammate", instructions: "Design." });
		const coder = await upsertAgent(root, { id: "coder", role: "teammate", instructions: "Code." });
		expect(architect.agentNumericId).toBe(2);
		expect(coder.agentNumericId).toBe(3);

		// 2. Reorder roster on disk (e.g., coder first, then coordinator, then architect)
		const rosterFile = join(root, WORKSPACE_DIRNAME, ROSTER_FILE);
		const currentRoster = JSON.parse(await readFile(rosterFile, "utf8"));
		currentRoster.agents = [currentRoster.agents[2], currentRoster.agents[0], currentRoster.agents[1]];
		await writeFile(rosterFile, JSON.stringify(currentRoster, null, "\t"), "utf8");

		// Reload (simulate restart): IDs must remain strictly attached to identities, not array indices
		const afterReorder = await loadCompany(root);
		expect(afterReorder.status).toBe("ready");
		if (afterReorder.status === "ready") {
			expect(afterReorder.roster.agents.find((a) => a.id === "coordinator")?.agentNumericId).toBe(1);
			expect(afterReorder.roster.agents.find((a) => a.id === "architect")?.agentNumericId).toBe(2);
			expect(afterReorder.roster.agents.find((a) => a.id === "coder")?.agentNumericId).toBe(3);
			expect(afterReorder.roster.nextAgentNumericId).toBe(4);
		}

		// 3. Rename: coder -> lead-coder
		const renamed = await upsertAgent(root, {
			...coder,
			id: "lead-coder",
			displayName: "Lead Coder",
			filePath: "org/agents/coder/profile.md",
		});
		expect(renamed.agentNumericId).toBe(3); // Same numeric ID!
		expect(renamed.filePath).toBe("org/agents/lead-coder/profile.md");

		// 4. Duplicate slug rejection:
		// Attempting to rename another agent to an existing agent's slug fails:
		await expect(upsertAgent(root, { ...architect, id: "lead-coder", filePath: "org/agents/architect/profile.md" })).rejects.toThrow();
		// Attempting to create a new agent with a slug that is an active agent's legacy alias fails:
		await expect(upsertAgent(root, { id: "coder", role: "teammate", instructions: "Dup alias." })).rejects.toThrow();

		// 5. Backup before retire
		const backupDir = await tempWorkspace();
		await cp(join(root, WORKSPACE_DIRNAME), join(backupDir, WORKSPACE_DIRNAME), { recursive: true });

		// 6. Retire: remove lead-coder
		await removeAgent(root, "lead-coder");
		const afterRetire = await loadCompany(root);
		expect(afterRetire.status).toBe("ready");
		if (afterRetire.status === "ready") {
			expect(afterRetire.roster.agents.find((a) => a.id === "lead-coder")).toBeUndefined();
			const tombstone = afterRetire.roster.retiredAgents.find((a) => a.id === "lead-coder");
			expect(tombstone).toBeDefined();
			expect(tombstone?.agentNumericId).toBe(3);
			expect(tombstone?.legacySlugs).toContain("coder");
			expect(afterRetire.roster.nextAgentNumericId).toBe(4); // ID 3 is never reused
		}

		// 7. New hire gets nextAgentNumericId (4), never reusing retired 3
		const tester = await upsertAgent(root, { id: "tester", role: "teammate", instructions: "Test." });
		expect(tester.agentNumericId).toBe(4);

		// 8. Restore backup: restoring previous state restores exact IDs and nextAgentNumericId
		await rm(join(root, WORKSPACE_DIRNAME), { recursive: true, force: true });
		await cp(join(backupDir, WORKSPACE_DIRNAME), join(root, WORKSPACE_DIRNAME), { recursive: true });
		const restored = await loadCompany(root);
		expect(restored.status).toBe("ready");
		if (restored.status === "ready") {
			expect(restored.roster.agents.find((a) => a.id === "lead-coder")?.agentNumericId).toBe(3);
			expect(restored.roster.agents.find((a) => a.id === "architect")?.agentNumericId).toBe(2);
			expect(restored.roster.nextAgentNumericId).toBe(4);
		}
	});

	it("leaves no .orvanta.tmp after a successful create", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });
		expect(await pathExists(join(root, WORKSPACE_TMP_DIRNAME))).toBe(false);
		expect(await pathExists(join(root, WORKSPACE_DIRNAME))).toBe(true);
	});
});


	it("reads and writes agent memory independently with persistence", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });

		// Coordinator memory initially empty
		expect(await getAgentMemory(root, "coordinator")).toBe("");
		expect(await getAgentMemory(root, "unknown-agent")).toBe("");

		const coordMemory = "# Coordinator Learnings\n- Always dispatch via team_run_task";
		const implMemory = "# Implementer Learnings\n- Use bun test";

		await saveAgentMemory(root, "coordinator", coordMemory);
		await saveAgentMemory(root, "implementer", implMemory);

		expect(await getAgentMemory(root, "coordinator")).toBe(coordMemory);
		expect(await getAgentMemory(root, "implementer")).toBe(implMemory);
	});

	it("initializes company knowledge base without overwriting existing files", async () => {
		const root = await tempWorkspace();
		await createCompany(root, { name: "Orvanta", purpose: PURPOSE });

		const knowledgeDir = join(root, WORKSPACE_DIRNAME, KNOWLEDGE_DIRNAME);
		const brandPath = join(knowledgeDir, "brand-guidelines.md");
		const codingPath = join(knowledgeDir, "coding-standards.md");

		expect(await pathExists(brandPath)).toBe(true);
		expect(await pathExists(codingPath)).toBe(true);

		const customBrand = "# Custom Brand Voice\n- Bold and direct.";
		await writeFile(brandPath, customBrand, "utf8");

		await initCompanyKnowledge(root);

		const brandContent = await readFile(brandPath, "utf8");
		expect(brandContent).toBe(customBrand);
	});