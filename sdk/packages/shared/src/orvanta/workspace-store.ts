import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
	type AgentProfile,
	AgentProfileSchema,
	ensureMandatoryDenyWrite,
	parseAgentProfile,
	serializeAgentProfile,
} from "./agent-profile";

import {
	type CompanyJson,
	type CompanyLoad,
	type CreateCompanyInput,
	CreateCompanyInputSchema,
	DEFAULT_COMPANY_POLICIES,
	defaultCoordinatorRoster,
	parseRoster,
	RosterJsonSchema,
	type RosterJson,
	slugifyTeamName,
	validateLoadedCompany,
} from "./company-schema";
import {
	COMPANY_FILE,
	COORDINATOR_AGENT_ID,
	COORDINATOR_MEMORY_FILE,
	COORDINATOR_PROFILE_FILE,
	KNOWLEDGE_DIRNAME,
	PROJECT_LAYOUT_VERSION,
	PROJECT_LAYOUT_VERSION_FILE,
	PURPOSE_FILE,
	ROSTER_FILE,
	SCHEMA_VERSION,
	ROSTER_SCHEMA_VERSION,
	VERSION_FILE,
	VERSION_FILE_CONTENTS,
	WORKSPACE_DIRNAME,
	WORKSPACE_TMP_DIRNAME,
} from "./paths";
import { COORDINATOR_PROFILE_TEMPLATE } from "./templates/coordinator";
import {
	getAgentMemory as readAcceptedAgentMemory,
	renameAgentMemoryDir,
	saveAgentMemory as writeAcceptedAgentMemory,
} from "./agent-memory-store";

export class CompanyAlreadyExistsError extends Error {
	constructor(workspaceRoot: string) {
		super(`Công ty đã tồn tại trong ${workspaceRoot}`);
		this.name = "CompanyAlreadyExistsError";
	}
}

export class CannotDeleteCoordinatorError extends Error {
	constructor(agentId: string = "coordinator") {
		super(`Không thể xóa coordinator '${agentId}' của công ty`);
		this.name = "CannotDeleteCoordinatorError";
	}
}

export class CompanyNameMismatchError extends Error {
	constructor(expected: string, actual: string) {
		super(`Tên công ty xác nhận không khớp: nhập '${actual}', cần '${expected}'`);
		this.name = "CompanyNameMismatchError";
	}
}

export interface AgentDetail {
	profile: AgentProfile;
	memory: string;
}

export async function pathExists(target: string): Promise<boolean> {
	try {
		await stat(target);
		return true;
	} catch {
		return false;
	}
}

export async function pickWorkspaceRoot(
	folders: string[],
): Promise<string | undefined> {
	if (folders.length === 0) {
		return undefined;
	}
	for (const folder of folders) {
		if (await pathExists(join(folder, WORKSPACE_DIRNAME))) {
			return folder;
		}
	}
	return folders[0];
}

async function readJsonIfPresent(filePath: string): Promise<unknown> {
	try {
		const raw = await readFile(filePath, "utf8");
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}

async function readTextIfPresent(filePath: string): Promise<string | undefined> {
	try {
		return await readFile(filePath, "utf8");
	} catch {
		return undefined;
	}
}

const workspaceMutationTails = new Map<string, Promise<void>>();

async function withWorkspaceMutation<T>(workspaceRoot: string, operation: () => Promise<T>): Promise<T> {
	const key = join(workspaceRoot, WORKSPACE_DIRNAME);
	if (!(await pathExists(key))) await mkdir(key, { recursive: true });
	await mkdir(join(key, "org"), { recursive: true });
	const previous = workspaceMutationTails.get(key) ?? Promise.resolve();
	let release!: () => void;
	const tail = new Promise<void>((resolve) => { release = resolve; });
	const queued = previous.then(() => tail);
	workspaceMutationTails.set(key, queued);
	await previous;
	const lockPath = join(key, "org", "roster.json.lock");
	let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
	let lockToken: string | undefined;
	const lockDeadline = Date.now() + 15_000;
	try {
		while (!lockHandle) {
			try {
				lockHandle = await open(lockPath, "wx");
				lockToken = crypto.randomUUID();
				await lockHandle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), token: lockToken }));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				try {
					const lockStat = await stat(lockPath);
					const rawLock = await readFile(lockPath, "utf8");
					const ageMs = Date.now() - lockStat.mtimeMs;
					// Empty / truncated lock from a crashed writer — steal after 1s.
					if (!rawLock.trim()) {
						if (ageMs > 1_000) await rm(lockPath, { force: true });
					} else {
						const lock = JSON.parse(rawLock) as { pid?: number };
						let ownerAlive = false;
						if (Number.isSafeInteger(lock.pid) && lock.pid! > 0) {
							try {
								process.kill(lock.pid!, 0);
								ownerAlive = true;
							} catch (processError) {
								ownerAlive = (processError as NodeJS.ErrnoException).code === "EPERM";
							}
						}
						if (!ownerAlive && ageMs > 1_000) await rm(lockPath, { force: true });
					}
				} catch {
					// Incomplete lock mid-write: wait briefly, then steal if still unreadable.
					try {
						const lockStat = await stat(lockPath);
						if (Date.now() - lockStat.mtimeMs > 2_000) {
							await rm(lockPath, { force: true });
						}
					} catch {
						/* Lock already gone. */
					}
				}
				if (Date.now() >= lockDeadline) throw new Error("Timed out waiting for Orvanta roster writer lock");
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
		}
		return await operation();
	} finally {
		if (lockHandle) {
			await lockHandle.close().catch(() => undefined);
			try {
				const currentLock = JSON.parse(await readFile(lockPath, "utf8")) as { token?: string };
				if (currentLock.token === lockToken) await rm(lockPath, { force: true });
			} catch { /* Lock already removed or replaced by recovery. */ }
		}
		release();
		if (workspaceMutationTails.get(key) === queued) workspaceMutationTails.delete(key);
	}
}

async function saveRoster(workspaceRoot: string, roster: RosterJson): Promise<void> {
	const root = join(workspaceRoot, WORKSPACE_DIRNAME);
	const rosterPath = join(root, ROSTER_FILE);
	const tmpRosterPath = join(root, "org", `roster.json.tmp-${crypto.randomUUID()}`);
	await writeFile(tmpRosterPath, `${JSON.stringify(roster, null, "\t")}\n`, "utf8");
	try {
		await rename(tmpRosterPath, rosterPath);
	} catch (error) {
		await rm(tmpRosterPath, { force: true }).catch(() => undefined);
		throw error;
	}
}

async function loadRosterForMutation(workspaceRoot: string): Promise<RosterJson> {
	const raw = await readJsonIfPresent(join(workspaceRoot, WORKSPACE_DIRNAME, ROSTER_FILE));
	return parseRoster(raw);
}

async function hasCompanyIdentityFiles(root: string): Promise<boolean> {
	return (
		(await pathExists(join(root, COMPANY_FILE))) ||
		(await pathExists(join(root, PURPOSE_FILE))) ||
		(await pathExists(join(root, ROSTER_FILE)))
	);
}

export async function loadCompanyReadOnly(workspaceRoot: string): Promise<CompanyLoad> {
	const root = join(workspaceRoot, WORKSPACE_DIRNAME);
	if (!(await pathExists(root))) {
		return { status: "missing" };
	}
	// Runtime (SDK session host / TeamStore) may create `.orvanta/local/**`
	// before a company exists. Treat that as uninitialized, not broken.
	if (!(await hasCompanyIdentityFiles(root))) {
		return { status: "missing" };
	}
	const company = await readJsonIfPresent(join(root, COMPANY_FILE));
	const roster = await readJsonIfPresent(join(root, ROSTER_FILE));
	const purpose = await readTextIfPresent(join(root, PURPOSE_FILE));
	const validated = validateLoadedCompany({ company, purpose, roster });
	if (!validated.ok) {
		return { status: "broken", errors: validated.errors };
	}
	if (validated.roster.schemaVersion !== ROSTER_SCHEMA_VERSION) {
		return { status: "broken", errors: ["org/roster.json có phiên bản schema không được hỗ trợ"] };
	}
	return {
		status: "ready",
		company: validated.company,
		purpose: validated.purpose,
		roster: validated.roster,
	};
}

export async function loadCompany(workspaceRoot: string): Promise<CompanyLoad> {
	const initial = await loadCompanyReadOnly(workspaceRoot);
	if (initial.status === "missing") return initial;
	return withWorkspaceMutation(workspaceRoot, async () => {
		const load = await loadCompanyReadOnly(workspaceRoot);
		if (load.status !== "ready") return load;
		const raw = await readJsonIfPresent(join(workspaceRoot, WORKSPACE_DIRNAME, ROSTER_FILE));
		if (!RosterJsonSchema.safeParse(raw).success) await saveRoster(workspaceRoot, load.roster);
		return loadCompanyReadOnly(workspaceRoot);
	});
}

export const BRAND_GUIDELINES_TEMPLATE = `# Brand Guidelines

## Giọng điệu thương hiệu (Brand Voice)
- Chuyên nghiệp, trực diện, tôn trọng thời gian của khách hàng và đối tác.
- Ngắn gọn, súc tích, tránh sáo rỗng hoặc hoa mỹ quá mức.

## Quy tắc giao tiếp & Nội dung
- Luôn có Call to Action (CTA) rõ ràng ở cuối tài liệu truyền thông.
- Kiểm tra lỗi chính tả và ngữ pháp trước khi xuất bản.
`;

export const CODING_STANDARDS_TEMPLATE = `# Coding Standards

## Quy chuẩn phát triển (Development Standards)
- Ngôn ngữ & Toolchain: Sử dụng bun làm package manager & test runner (\`bun test\`), Node.js runtime.
- Type Safety: TypeScript strict mode, không sử dụng \`any\` tùy tiện.

## Quy tắc kiểm thử & Code Review
- Viết unit test cho các module nghiệp vụ mới trước khi hoàn tất task.
- Không sửa file cấu hình cốt lõi ngoài phạm vi được giao.
`;

async function writeTree(
	tmpRoot: string,
	company: CompanyJson,
	purpose: string,
): Promise<void> {
	const files: Array<[string, string]> = [
		[COMPANY_FILE, `${JSON.stringify(company, null, "\t")}\n`],
		[PURPOSE_FILE, purpose.endsWith("\n") ? purpose : `${purpose}\n`],
		[VERSION_FILE, VERSION_FILE_CONTENTS],
		[
			ROSTER_FILE,
			`${JSON.stringify(defaultCoordinatorRoster(company.createdAt), null, "\t")}\n`,
		],
		[COORDINATOR_PROFILE_FILE, COORDINATOR_PROFILE_TEMPLATE],
		[COORDINATOR_MEMORY_FILE, ""],
		[PROJECT_LAYOUT_VERSION_FILE, `${PROJECT_LAYOUT_VERSION}\n`],
		[join(KNOWLEDGE_DIRNAME, "brand-guidelines.md"), BRAND_GUIDELINES_TEMPLATE],
		[join(KNOWLEDGE_DIRNAME, "coding-standards.md"), CODING_STANDARDS_TEMPLATE],
	];
	for (const [relative, contents] of files) {
		const filePath = join(tmpRoot, relative);
		await mkdir(dirname(filePath), { recursive: true });
		await writeFile(filePath, contents, "utf8");
	}
}

export async function createCompany(
	workspaceRoot: string,
	input: CreateCompanyInput,
): Promise<CompanyLoad> {
	const parsed = CreateCompanyInputSchema.parse(input);
	const dest = join(workspaceRoot, WORKSPACE_DIRNAME);
	const tmp = join(workspaceRoot, WORKSPACE_TMP_DIRNAME);
	const existing = await loadCompanyReadOnly(workspaceRoot);
	if (existing.status !== "missing") {
		throw new CompanyAlreadyExistsError(workspaceRoot);
	}
	if (await pathExists(tmp)) {
		await rm(tmp, { recursive: true, force: true });
	}

	const now = new Date().toISOString();
	const company: CompanyJson = {
		schemaVersion: SCHEMA_VERSION,
		id: `orvanta-local-${crypto.randomUUID()}`,
		name: parsed.name,
		createdAt: now,
		updatedAt: now,
		workspaceRoot: ".",
		teamName: slugifyTeamName(parsed.name),
		policies: DEFAULT_COMPANY_POLICIES,
		coordinatorAgentId: "coordinator",
	};

	try {
		if (await pathExists(dest)) {
			// Preserve runtime dirs already under `.orvanta/local/**`.
			await writeTree(dest, company, parsed.purpose);
		} else {
			await mkdir(tmp, { recursive: true });
			await writeTree(tmp, company, parsed.purpose);
			await rename(tmp, dest);
		}
	} catch (error) {
		await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}

	return loadCompanyReadOnly(workspaceRoot);
}

export async function deleteCompany(workspaceRoot: string, confirmedName: string): Promise<void> {
	const load = await loadCompany(workspaceRoot);
	if (load.status !== "ready") throw new Error("Không có công ty hợp lệ để xóa");
	if (load.company.name.trim() !== confirmedName.trim()) {
		throw new CompanyNameMismatchError(load.company.name, confirmedName);
	}
	await rm(join(workspaceRoot, WORKSPACE_DIRNAME), { recursive: true, force: true });
}

export async function listAgentProfiles(
	workspaceRoot: string,
): Promise<AgentProfile[]> {
	const root = join(workspaceRoot, WORKSPACE_DIRNAME);
	const agentsDir = join(root, "org", "agents");
	if (!(await pathExists(agentsDir))) {
		return [];
	}
	const entries = await readdir(agentsDir, { withFileTypes: true });
	const profiles: AgentProfile[] = [];
	const company = await loadCompany(workspaceRoot);
	const identityBySlug = new Map(company.status === "ready" ? company.roster.agents.map((agent) => [agent.id, agent.agentNumericId]) : []);
	for (const entry of entries) {
		if (entry.isDirectory()) {
			const profilePath = join(agentsDir, entry.name, "profile.md");
			if (await pathExists(profilePath)) {
				try {
					const content = await readFile(profilePath, "utf8");
					const profile = parseAgentProfile(
						content,
						`org/agents/${entry.name}/profile.md`,
					);
					profiles.push({ ...profile, agentNumericId: identityBySlug.get(profile.id) ?? profile.agentNumericId });
				} catch {
					// Ignore invalid profile
				}
			}
		}
	}
	profiles.sort((a, b) => {
		if (a.role === "lead") return -1;
		if (b.role === "lead") return 1;
		return a.displayName.localeCompare(b.displayName);
	});
	return profiles;
}

export async function getAgentProfile(
	workspaceRoot: string,
	agentId: string,
): Promise<AgentProfile | undefined> {
	const filePath = join(
		workspaceRoot,
		WORKSPACE_DIRNAME,
		"org",
		"agents",
		agentId,
		"profile.md",
	);
	if (!(await pathExists(filePath))) {
		return undefined;
	}
	const content = await readFile(filePath, "utf8");
	const profile = parseAgentProfile(content, `org/agents/${agentId}/profile.md`);
	const roster = await loadRosterForMutation(workspaceRoot);
	const identity = roster.agents.find((agent) => agent.id === agentId);
	return identity ? { ...profile, agentNumericId: identity.agentNumericId } : profile;
}

export async function getAgentMemory(
	workspaceRoot: string,
	agentId: string,
): Promise<string> {
	return readAcceptedAgentMemory(workspaceRoot, agentId);
}

export async function saveAgentMemory(
	workspaceRoot: string,
	agentId: string,
	content: string,
): Promise<void> {
	await writeAcceptedAgentMemory(workspaceRoot, agentId, content);
}

export async function initCompanyKnowledge(
	workspaceRoot: string,
): Promise<void> {
	const knowledgeDir = join(
		workspaceRoot,
		WORKSPACE_DIRNAME,
		KNOWLEDGE_DIRNAME,
	);
	await mkdir(knowledgeDir, { recursive: true });

	const brandPath = join(knowledgeDir, "brand-guidelines.md");
	if (!(await pathExists(brandPath))) {
		await writeFile(brandPath, BRAND_GUIDELINES_TEMPLATE, "utf8");
	}

	const codingPath = join(knowledgeDir, "coding-standards.md");
	if (!(await pathExists(codingPath))) {
		await writeFile(codingPath, CODING_STANDARDS_TEMPLATE, "utf8");
	}
}

export interface UpsertAgentInput {
	id: string;
	previousId?: string;
	agentNumericId?: number;
	filePath?: string;
	displayName?: string;
	description?: string;
	role?: "lead" | "teammate";
	reportsTo?: string | null;
	providerId?: string | null;
	modelId?: string | null;
	maxIterations?: number;
	temperature?: number | null;
	reasoningEffort?: string | null;
	supportsImages?: boolean | null;
	contextWindow?: number | null;
	maxOutputTokens?: number | null;
	instructions: string;
	tools?: {
		allow?: string[];
		deny?: string[];
	};
	scopePaths?: {
		allow?: string[];
		denyWrite?: string[];
	};
	rules?: string[];
	skills?: string[];
	autoApproval?: AgentProfile["autoApproval"];
	mcpServers?: string[];
}

export async function writeAgentProfile(
	agentDir: string,
	profile: AgentProfile,
): Promise<void> {
	await mkdir(agentDir, { recursive: true });
	const profilePath = join(agentDir, "profile.md");
	const serialized = serializeAgentProfile(profile);
	await writeFile(profilePath, serialized, "utf8");
}

export async function upsertAgent(
	workspaceRoot: string,
	input: UpsertAgentInput,
): Promise<AgentProfile> {
	return withWorkspaceMutation(workspaceRoot, () => upsertAgentLocked(workspaceRoot, input));
}

async function upsertAgentLocked(
	workspaceRoot: string,
	input: UpsertAgentInput,
): Promise<AgentProfile> {
	const load = await loadCompanyReadOnly(workspaceRoot);
	if (load.status !== "ready") {
		throw new Error("Công ty chưa sẵn sàng trong workspace này");
	}

	const root = join(workspaceRoot, WORKSPACE_DIRNAME);
	const currentRoster = await loadRosterForMutation(workspaceRoot);
	const existing = currentRoster.agents.find((agent) => agent.id === input.id);
	if (!existing && (
		currentRoster.agents.some((agent) => agent.id === input.id || agent.legacySlugs.includes(input.id)) ||
		currentRoster.retiredAgents.some((agent) => agent.id === input.id || agent.legacySlugs.includes(input.id))
	)) {
		throw new Error(`Agent slug '${input.id}' already exists or is retired`);
	}

	const filePathId = input.filePath?.match(/^org\/agents\/([a-z][a-z0-9_-]{1,31})\/profile\.md$/)?.[1];
	const oldId = input.previousId ?? (filePathId !== input.id ? filePathId : undefined);
	const renameSource = oldId ? currentRoster.agents.find((agent) => agent.id === oldId) : undefined;
	const aliasSource = oldId && !renameSource ? currentRoster.agents.find((agent) => agent.legacySlugs.includes(oldId)) : undefined;
	if (oldId && !renameSource && !aliasSource) throw new Error(`Agent '${oldId}' does not exist`);
	if (aliasSource && existing && aliasSource.agentNumericId !== existing.agentNumericId) throw new Error(`Agent slug '${input.id}' already exists`);
	if (aliasSource && !existing && aliasSource.id !== input.id) throw new Error(`Agent rename slug '${input.id}' does not match its current identity`);
	if (existing && renameSource && existing.agentNumericId !== renameSource.agentNumericId) throw new Error(`Agent slug '${input.id}' already exists`);
	if (renameSource && currentRoster.agents.some((agent) => agent.id === input.id && agent.agentNumericId !== renameSource.agentNumericId)) {
		throw new Error(`Agent slug '${input.id}' already exists`);
	}
	const identity = existing ?? renameSource ?? aliasSource;
	const assignedId = identity?.agentNumericId ?? currentRoster.nextAgentNumericId;
	if (!Number.isSafeInteger(assignedId) || assignedId <= 0 || assignedId >= Number.MAX_SAFE_INTEGER) {
		throw new Error("Agent numeric ID registry is exhausted or invalid");
	}

	const description =
		input.description?.trim() || input.displayName?.trim() || input.id;
	const displayName = input.displayName?.trim() || input.id;
	const denyWrite = ensureMandatoryDenyWrite(input.scopePaths?.denyWrite);
	const normalizedInput = {
		...input,
		displayName,
		description,
		scopePaths: {
			allow: input.scopePaths?.allow ?? ["**/*"],
			denyWrite,
		},
	};

	const profile = AgentProfileSchema.parse({
		...normalizedInput,
		agentNumericId: assignedId,
		filePath: `org/agents/${input.id}/profile.md`,
	});

	const coordinatorId =
		load.company.coordinatorAgentId || COORDINATOR_AGENT_ID;
	if (profile.role === "lead" && profile.id !== coordinatorId) {
		throw new Error("Không thể có hai lead. Lead duy nhất là coordinator.");
	}
	if (profile.id === coordinatorId && profile.role !== "lead") {
		throw new Error("Coordinator bắt buộc phải có role lead.");
	}

	const agentDir = join(root, "org", "agents", profile.id);
	const previousAgentDir = identity ? join(root, "org", "agents", identity.id) : undefined;
	const finalAgentDir = agentDir;
	const stageAgentDir = `${agentDir}.tmp-${crypto.randomUUID()}`;
	await mkdir(stageAgentDir, { recursive: true });
	const oldProfile = identity ? await readTextIfPresent(join(previousAgentDir!, "profile.md")) : undefined;
	const oldMemory = identity ? await getAgentMemory(workspaceRoot, identity.id) : undefined;
	const childProfiles = new Map<string, { path: string; original: string; updated: AgentProfile }>();
	if (identity && identity.id !== profile.id) {
		for (const child of currentRoster.agents.filter((agent) => agent.reportsTo === identity.id && agent.agentNumericId !== identity.agentNumericId)) {
			const childProfilePath = join(root, "org", "agents", child.id, "profile.md");
			const childText = await readTextIfPresent(childProfilePath);
			if (childText !== undefined) {
				const childProfile = parseAgentProfile(childText, `org/agents/${child.id}/profile.md`);
				childProfiles.set(child.id, { path: childProfilePath, original: childText, updated: { ...childProfile, reportsTo: profile.id } });
			}
		}
	}
	try {
		for (const [childId, child] of childProfiles) await writeAgentProfile(join(root, "org", "agents", childId), child.updated);
		await writeAgentProfile(stageAgentDir, profile);
		if (identity && previousAgentDir !== finalAgentDir) {
			await rm(finalAgentDir, { recursive: true, force: true });
			await rename(stageAgentDir, finalAgentDir);
			await renameAgentMemoryDir(workspaceRoot, identity.id, profile.id);
		} else {
			await rm(stageAgentDir, { recursive: true, force: true });
			await mkdir(agentDir, { recursive: true });
			await writeAgentProfile(agentDir, profile);
		}
	} catch (error) {
		await rm(stageAgentDir, { recursive: true, force: true }).catch(() => undefined);
		throw error;
	}
	const now = new Date().toISOString();
	const agentFile = `org/agents/${profile.id}/profile.md`;

	if (identity) {
		const index = currentRoster.agents.findIndex((agent) => agent.agentNumericId === identity.agentNumericId);
		const renamed = profile.id !== identity.id;
		const legacySlugs = renamed ? [...new Set([...identity.legacySlugs, identity.id])] : identity.legacySlugs;
		currentRoster.agents[index] = {
			...identity,
			id: profile.id,
			agentNumericId: identity.agentNumericId,
			legacySlugs,
			displayName: profile.displayName,
			role: profile.role,
			reportsTo: profile.reportsTo ?? existing?.reportsTo ?? null,
			modelId: profile.modelId,
			maxIterations: profile.maxIterations,
			agentFile,
		};
		if (renamed) {
			currentRoster.agents = currentRoster.agents.map((agent) => ({
				...agent,
				reportsTo: agent.reportsTo === identity.id ? profile.id : agent.reportsTo,
			}));
		}
	} else {
		currentRoster.agents.push({
			id: profile.id,
			agentNumericId: assignedId,
			legacySlugs: [],
			displayName: profile.displayName,
			role: profile.role,
			reportsTo: profile.reportsTo ?? null,
			status: "idle",
			agentFile,
			hiredAt: now,
			hiredBy: "ceo",
			modelId: profile.modelId,
			maxIterations: profile.maxIterations,
		});
		currentRoster.nextAgentNumericId = assignedId + 1;
	}
	currentRoster.schemaVersion = ROSTER_SCHEMA_VERSION;
	const previousRosterText = await readTextIfPresent(join(root, ROSTER_FILE));
	try {
		for (const [childId, child] of childProfiles) {
			await writeAgentProfile(join(root, "org", "agents", childId), child.updated);
		}
		await saveRoster(workspaceRoot, RosterJsonSchema.parse(currentRoster));
		if (identity && previousAgentDir !== finalAgentDir) await rm(previousAgentDir!, { recursive: true, force: true });
	} catch (error) {
		if (previousRosterText !== undefined) {
			const rollbackPath = join(root, "org", `roster.rollback-${crypto.randomUUID()}.tmp`);
			await writeFile(rollbackPath, previousRosterText, "utf8").catch(() => undefined);
			await rename(rollbackPath, join(root, ROSTER_FILE)).catch(() => undefined);
		}
		for (const child of childProfiles.values()) await writeFile(child.path, child.original, "utf8").catch(() => undefined);
		if (identity && previousAgentDir !== finalAgentDir && oldProfile !== undefined) {
			if (await pathExists(previousAgentDir!)) {
				await rm(finalAgentDir, { recursive: true, force: true }).catch(() => undefined);
			} else if (await pathExists(finalAgentDir)) {
				await rename(finalAgentDir, previousAgentDir!).catch(async () => {
					await mkdir(join(previousAgentDir!, "workspace"), { recursive: true });
					await writeFile(join(previousAgentDir!, "profile.md"), oldProfile, "utf8").catch(() => undefined);
					await writeFile(join(previousAgentDir!, "workspace", "memory.md"), oldMemory ?? "", "utf8").catch(() => undefined);
				});
			}
		}
		throw error;
	}

	return profile;
}

export const upsertAgentProfile = upsertAgent;

export async function getAgent(workspaceRoot: string, agentId: string): Promise<AgentDetail | undefined> {
	const profile = await getAgentProfile(workspaceRoot, agentId);
	if (!profile) return undefined;
	return { profile, memory: await getAgentMemory(workspaceRoot, agentId) };
}

export async function removeAgent(
	workspaceRoot: string,
	agentId: string,
): Promise<CompanyLoad> {
	return withWorkspaceMutation(workspaceRoot, () => removeAgentLocked(workspaceRoot, agentId));
}

async function removeAgentLocked(workspaceRoot: string, agentId: string): Promise<CompanyLoad> {
	const load = await loadCompanyReadOnly(workspaceRoot);
	if (load.status !== "ready") {
		throw new Error("Công ty chưa sẵn sàng trong workspace này");
	}

	const coordinatorId =
		load.company.coordinatorAgentId || COORDINATOR_AGENT_ID;
	if (agentId === coordinatorId) {
		throw new CannotDeleteCoordinatorError(coordinatorId);
	}

	const root = join(workspaceRoot, WORKSPACE_DIRNAME);
	const currentRoster = await loadRosterForMutation(workspaceRoot);
	const retiring = currentRoster.agents.find((agent) => agent.id === agentId);
	if (!retiring) return load;
	currentRoster.agents = currentRoster.agents.filter((agent) => agent.id !== agentId);
	currentRoster.retiredAgents.push({
		agentNumericId: retiring.agentNumericId,
		id: retiring.id,
		displayName: retiring.displayName,
		legacySlugs: retiring.legacySlugs,
		retiredAt: new Date().toISOString(),
	});
	await saveRoster(workspaceRoot, RosterJsonSchema.parse(currentRoster));
	await rm(join(root, "org", "agents", agentId), { recursive: true, force: true });

	return loadCompanyReadOnly(workspaceRoot);
}


