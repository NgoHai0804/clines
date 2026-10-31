import { describe, expect, it } from "vitest";
import type { AgentBeforeToolContext, AgentTool, AgentToolContext } from "../agent";
import { parseAgentProfile } from "./agent-profile";
import {
	checkPurposeLockPath,
	createPurposeLockHook,
	normalizeTargetPath,
	wrapToolWithPurposeLock,
	checkToolPolicy,
	EphemeralTracker,
	classifyTaskScope,
	isAllowedReviewerCommand,
	isArtifactPath,
	isReviewArtifactPath,
	isSourceCodePath,
} from "./purpose-lock";
import {
	COORDINATOR_PROFILE_TEMPLATE,
	IMPLEMENTER_PROFILE_TEMPLATE,
	REVIEWER_PROFILE_TEMPLATE,
	RESEARCHER_PROFILE_TEMPLATE,
	SKEPTIC_PROFILE_TEMPLATE,
} from "./templates";

describe("normalizeTargetPath", () => {
	it("normalizes Windows backslashes and strips leading ./", () => {
		expect(normalizeTargetPath(".orvanta\\purpose.md")).toBe(".orvanta/purpose.md");
		expect(normalizeTargetPath("./.orvanta/purpose.md")).toBe(".orvanta/purpose.md");
	});

	it("resolves relative path given workspaceRoot", () => {
		const ws = "D:/workspace/my-company";
		expect(normalizeTargetPath("D:/workspace/my-company/.orvanta/purpose.md", ws)).toBe(
			".orvanta/purpose.md",
		);
		expect(normalizeTargetPath("D:\\workspace\\my-company\\.orvanta\\purpose.md", ws)).toBe(
			".orvanta/purpose.md",
		);
	});
});

describe("checkPurposeLockPath", () => {
	it("denies write to .orvanta/purpose.md (relative, absolute, Windows slashes)", () => {
		expect(checkPurposeLockPath({ targetPath: ".orvanta/purpose.md" })).toMatchObject({
			allowed: false,
			code: "purpose_lock_denied",
		});
		expect(checkPurposeLockPath({ targetPath: ".orvanta\\purpose.md" })).toMatchObject({
			allowed: false,
			code: "purpose_lock_denied",
		});
		expect(
			checkPurposeLockPath({
				targetPath: "C:\\projects\\app\\.orvanta\\purpose.md",
				workspaceRoot: "C:\\projects\\app",
			}),
		).toMatchObject({ allowed: false, code: "purpose_lock_denied" });
	});

	it("denies write to company.json and roster.json", () => {
		expect(checkPurposeLockPath({ targetPath: ".orvanta/company.json" })).toMatchObject({
			allowed: false,
			code: "purpose_lock_denied",
		});
		expect(checkPurposeLockPath({ targetPath: ".orvanta/org/roster.json" })).toMatchObject({
			allowed: false,
			code: "purpose_lock_denied",
		});
	});

	it("denies write to any profile.md (own and others)", () => {
		expect(
			checkPurposeLockPath({
				targetPath: ".orvanta/org/agents/implementer/profile.md",
				requesterId: "implementer",
			}),
		).toMatchObject({ allowed: false, code: "purpose_lock_denied" });
		expect(
			checkPurposeLockPath({
				targetPath: ".orvanta/org/agents/reviewer/profile.md",
				requesterId: "implementer",
			}),
		).toMatchObject({ allowed: false, code: "purpose_lock_denied" });
	});

	it("denies write to shared/handoffs (requires orvanta_submit_handoff)", () => {
		const res = checkPurposeLockPath({
			targetPath: ".orvanta/shared/handoffs/task-1/implementer.md",
			requesterId: "implementer",
		});
		expect(res.allowed).toBe(false);
		expect(res.code).toBe("purpose_lock_denied");
		expect(res.reason).toContain("orvanta_submit_handoff");
	});

	it("allows write to agent's own workspace folder", () => {
		expect(
			checkPurposeLockPath({
				targetPath: ".orvanta/org/agents/implementer/workspace/notes.md",
				requesterId: "implementer",
			}).allowed,
		).toBe(true);
	});

	it("allows agent proposals but not accepted memory.md", () => {
		expect(
			checkPurposeLockPath({
				targetPath: ".orvanta/local/memory/agents/implementer/proposals/p1.md",
				requesterId: "implementer",
			}).allowed,
		).toBe(true);
		expect(
			checkPurposeLockPath({
				targetPath: ".orvanta/local/memory/agents/implementer/memory.md",
				requesterId: "implementer",
			}),
		).toMatchObject({ allowed: false, code: "purpose_lock_denied" });
	});

	it("denies write to another agent's workspace folder", () => {
		expect(
			checkPurposeLockPath({
				targetPath: ".orvanta/org/agents/reviewer/workspace/memory.md",
				requesterId: "implementer",
			}),
		).toMatchObject({ allowed: false, code: "purpose_lock_denied" });
	});

	it("allows write to normal files outside .orvanta", () => {
		expect(checkPurposeLockPath({ targetPath: "src/index.ts" }).allowed).toBe(true);
		expect(checkPurposeLockPath({ targetPath: "package.json" }).allowed).toBe(true);
	});

	it("blocks path traversal containing '..'", () => {
		const res = checkPurposeLockPath({ targetPath: ".orvanta/org/agents/../../secret.txt" });
		expect(res.allowed).toBe(false);
		expect(res.code).toBe("purpose_lock_denied");
		expect(res.reason).toContain("Path traversal");
	});

	it("memory/ checks: allows .md without '..', denies non-.md, denies '..'", () => {
		expect(checkPurposeLockPath({ targetPath: ".orvanta/memory/notes.md" }).allowed).toBe(true);
		expect(checkPurposeLockPath({ targetPath: ".orvanta/memory/project/handoff.md" }).allowed).toBe(true);

		const nonMd = checkPurposeLockPath({ targetPath: ".orvanta/memory/script.sh" });
		expect(nonMd.allowed).toBe(false);
		expect(nonMd.code).toBe("purpose_lock_denied");

		const traversal = checkPurposeLockPath({ targetPath: ".orvanta/memory/../outside.md" });
		expect(traversal.allowed).toBe(false);
		expect(traversal.code).toBe("purpose_lock_denied");
	});
});

describe("createPurposeLockHook & wrapToolWithPurposeLock", () => {
	it("blocks write_to_file when path is purpose.md via hook", async () => {
		const hook = createPurposeLockHook();
		const ctx = {
			tool: { name: "write_to_file" },
			input: { path: ".orvanta/purpose.md" },
			snapshot: { agentId: "implementer" },
		} as unknown as AgentBeforeToolContext;

		const result = await hook.beforeTool?.(ctx);
		expect(result?.skip).toBe(true);
		expect(result?.reason).toContain("purpose_lock_denied");
	});

	it("returns structured error without executing original tool when write is denied", async () => {
		let executed = false;
		const fakeTool: AgentTool = {
			name: "write_to_file",
			description: "write a file",
			inputSchema: {},
			execute: async () => {
				executed = true;
				return { ok: true };
			},
		};

		const wrapped = wrapToolWithPurposeLock(fakeTool, { requesterId: "implementer" });
		const context = { agentId: "implementer", iteration: 1 } as AgentToolContext;

		const res = (await wrapped.execute(
			{ path: ".orvanta/purpose.md" },
			context,
		)) as { ok: boolean; code: string };

		expect(executed).toBe(false);
		expect(res.ok).toBe(false);
		expect(res.code).toBe("purpose_lock_denied");
	});

	it("executes tool when write is to agent's own workspace", async () => {
		let executed = false;
		const fakeTool: AgentTool = {
			name: "write_to_file",
			description: "write a file",
			inputSchema: {},
			execute: async () => {
				executed = true;
				return { ok: true };
			},
		};

		const wrapped = wrapToolWithPurposeLock(fakeTool, { requesterId: "implementer" });
		const context = { agentId: "implementer", iteration: 1 } as AgentToolContext;

		const res = (await wrapped.execute(
			{ path: ".orvanta/org/agents/implementer/workspace/memory.md" },
			context,
		)) as { ok: boolean };

		expect(executed).toBe(true);
		expect(res.ok).toBe(true);
	});
});
describe("checkToolPolicy across all role templates", () => {
	it("reviewer template: denies write_to_file, apply_diff, execute_command, allows read_files", () => {
		const reviewer = parseAgentProfile(REVIEWER_PROFILE_TEMPLATE);
		const policy = reviewer.tools;

		const writeCheck = checkToolPolicy({ toolName: "write_to_file", agentId: "reviewer", policy });
		expect(writeCheck.allowed).toBe(false);
		expect(writeCheck.code).toBe("purpose_lock_denied");

		const diffCheck = checkToolPolicy({ toolName: "apply_diff", agentId: "reviewer", policy });
		expect(diffCheck.allowed).toBe(false);

		const cmdCheck = checkToolPolicy({ toolName: "execute_command", agentId: "reviewer", policy });
		expect(cmdCheck.allowed).toBe(false);

		const readCheck = checkToolPolicy({ toolName: "read_files", agentId: "reviewer", policy });
		expect(readCheck.allowed).toBe(true);

		const handoffCheck = checkToolPolicy({ toolName: "orvanta_submit_handoff", agentId: "reviewer", policy });
		expect(handoffCheck.allowed).toBe(true);

		// Coordination tools must work even when omitted from allow-lists
		// (profiles often only list work tools like read/grep).
		const sparsePolicy = {
			allow: ["read_files", "list_files"],
			deny: ["write_to_file", "team_spawn_teammate"],
		};
		expect(
			checkToolPolicy({
				toolName: "team_send_message",
				agentId: "reviewer",
				policy: sparsePolicy,
			}).allowed,
		).toBe(true);
		expect(
			checkToolPolicy({
				toolName: "team_read_mailbox",
				agentId: "reviewer",
				policy: sparsePolicy,
			}).allowed,
		).toBe(true);
		expect(
			checkToolPolicy({
				toolName: "orvanta_submit_handoff",
				agentId: "reviewer",
				policy: sparsePolicy,
			}).allowed,
		).toBe(true);
		expect(
			checkToolPolicy({
				toolName: "team_spawn_teammate",
				agentId: "reviewer",
				policy: sparsePolicy,
			}).allowed,
		).toBe(false);
	});

	it("researcher template: denies write_to_file and execute_command, allows browser_action and web_fetch", () => {
		const researcher = parseAgentProfile(RESEARCHER_PROFILE_TEMPLATE);
		const policy = researcher.tools;

		expect(checkToolPolicy({ toolName: "write_to_file", agentId: "researcher", policy }).allowed).toBe(false);
		expect(checkToolPolicy({ toolName: "execute_command", agentId: "researcher", policy }).allowed).toBe(false);
		expect(checkToolPolicy({ toolName: "browser_action", agentId: "researcher", policy }).allowed).toBe(true);
		expect(checkToolPolicy({ toolName: "web_fetch", agentId: "researcher", policy }).allowed).toBe(true);
	});

	it("skeptic template: denies write_to_file, allows read_files and grep", () => {
		const skeptic = parseAgentProfile(SKEPTIC_PROFILE_TEMPLATE);
		const policy = skeptic.tools;

		expect(checkToolPolicy({ toolName: "write_to_file", agentId: "skeptic", policy }).allowed).toBe(false);
		expect(checkToolPolicy({ toolName: "read_files", agentId: "skeptic", policy }).allowed).toBe(true);
		expect(checkToolPolicy({ toolName: "grep", agentId: "skeptic", policy }).allowed).toBe(true);
	});

	it("implementer template: allows write_to_file and execute_command, denies team_spawn_teammate", () => {
		const implementer = parseAgentProfile(IMPLEMENTER_PROFILE_TEMPLATE);
		const policy = implementer.tools;

		expect(checkToolPolicy({ toolName: "write_to_file", agentId: "implementer", policy }).allowed).toBe(true);
		expect(checkToolPolicy({ toolName: "execute_command", agentId: "implementer", policy }).allowed).toBe(true);
		expect(checkToolPolicy({ toolName: "team_spawn_teammate", agentId: "implementer", policy }).allowed).toBe(false);
	});

	it("coordinator template: denies write_to_file, allows read_files and list_files", () => {
		const coordinator = parseAgentProfile(COORDINATOR_PROFILE_TEMPLATE);
		const policy = coordinator.tools;

		expect(checkToolPolicy({ toolName: "write_to_file", agentId: "coordinator", policy }).allowed).toBe(false);
		expect(checkToolPolicy({ toolName: "read_files", agentId: "coordinator", policy }).allowed).toBe(true);
		expect(checkToolPolicy({ toolName: "list_files", agentId: "coordinator", policy }).allowed).toBe(true);
	});
});

describe("EphemeralTracker", () => {
	it("allows up to 3 guest ephemeral agents then rejects with over_ephemeral", () => {
		const tracker = new EphemeralTracker(3);
		expect(tracker.canSpawn().allowed).toBe(true);

		expect(tracker.recordSpawn()).toBe(true);
		expect(tracker.getCount()).toBe(1);

		expect(tracker.recordSpawn()).toBe(true);
		expect(tracker.getCount()).toBe(2);

		expect(tracker.recordSpawn()).toBe(true);
		expect(tracker.getCount()).toBe(3);

		const over = tracker.canSpawn();
		expect(over.allowed).toBe(false);
		expect(over.code).toBe("over_ephemeral");
		expect(tracker.recordSpawn()).toBe(false);
	});
});

describe("classifyTaskScope", () => {
	const samplePurpose = `# Purpose
## Chúng ta đang làm gì
Xây dựng nền tảng Orvanta

## Thành công trông như thế nào
- Hoàn thành đầy đủ tính năng

## Không làm
- Không viết lại backend bằng Rust
- Không hỗ trợ database MySQL cũ

## Ràng buộc
- Không đổi scope
`;

	it("detects task explicitly marked requiresScopeApproval", () => {
		const res = classifyTaskScope(
			{ title: "Task 1", requiresScopeApproval: true },
			{ purpose: samplePurpose },
		);
		expect(res.outsidePurpose).toBe(true);
	});

	it("detects task matching negative markers in purpose 'Không làm'", () => {
		const res = classifyTaskScope(
			{ title: "Viết lại backend bằng Rust", description: "Rewrite core to rust" },
			{ purpose: samplePurpose },
		);
		expect(res.outsidePurpose).toBe(true);
		expect(res.matchedMarker).toBe("viết lại backend bằng rust");
	});

	it("allows normal task aligned with purpose", () => {
		const res = classifyTaskScope(
			{ title: "Tạo component Inbox detail", description: "Implement UI for decisions" },
			{ purpose: samplePurpose },
		);
		expect(res.outsidePurpose).toBe(false);
	});
});

describe("wrapToolWithPurposeLock with toolPolicy", () => {
	it("blocks reviewer from write_to_file via tool policy", async () => {
		let executed = false;
		const fakeTool: AgentTool = {
			name: "write_to_file",
			description: "write a file",
			inputSchema: {},
			execute: async () => {
				executed = true;
				return { ok: true };
			},
		};

		const reviewer = parseAgentProfile(REVIEWER_PROFILE_TEMPLATE);
		const wrapped = wrapToolWithPurposeLock(fakeTool, {
			requesterId: "reviewer",
			toolPolicy: reviewer.tools,
		});

		const context = { agentId: "reviewer", iteration: 1 } as AgentToolContext;
		const res = (await wrapped.execute({ path: "src/review.md" }, context)) as {
			ok: boolean;
			code: string;
			reason: string;
		};

		expect(executed).toBe(false);
		expect(res.ok).toBe(false);
		expect(res.code).toBe("purpose_lock_denied");
		expect(res.reason).toContain("reviewer");
	});
});

describe("v0.0.3 Artifacts permissions, Reviewer scope & Safe commands", () => {
	it("path helpers identify artifact, review artifact, and source code correctly", () => {
		expect(isArtifactPath(".orvanta/artifacts/marketing/email.md")).toBe(true);
		expect(isArtifactPath(".orvanta/artifacts/reviews/review-1.md")).toBe(true);
		expect(isArtifactPath("artifacts/build/dist.js")).toBe(true);
		expect(isArtifactPath("src/index.ts")).toBe(false);

		expect(isReviewArtifactPath(".orvanta/artifacts/reviews/review-1.md")).toBe(true);
		expect(isReviewArtifactPath("artifacts/reviews/test.md")).toBe(true);
		expect(isReviewArtifactPath(".orvanta/artifacts/marketing/email.md")).toBe(false);

		expect(isSourceCodePath("src/index.ts")).toBe(true);
		expect(isSourceCodePath("src/auth/service.ts")).toBe(true);
		expect(isSourceCodePath(".orvanta/artifacts/marketing/email.md")).toBe(false);
	});

	it("checkPurposeLockPath: allows Copywriter, Researcher, and Implementer to write to .orvanta/artifacts/**", () => {
		// Copywriter
		const copyRes = checkPurposeLockPath({
			targetPath: ".orvanta/artifacts/marketing/email-sequence.md",
			requesterId: "copywriter",
		});
		expect(copyRes.allowed).toBe(true);

		// Windows backslashes
		const copyWin = checkPurposeLockPath({
			targetPath: ".orvanta\\artifacts\\marketing\\email-sequence.md",
			requesterId: "copywriter",
		});
		expect(copyWin.allowed).toBe(true);

		// Researcher
		const researchRes = checkPurposeLockPath({
			targetPath: ".orvanta/artifacts/research/market-analysis.md",
			requesterId: "researcher",
		});
		expect(researchRes.allowed).toBe(true);

		// Implementer
		const buildRes = checkPurposeLockPath({
			targetPath: ".orvanta/artifacts/build/dist.js",
			requesterId: "implementer",
		});
		expect(buildRes.allowed).toBe(true);
	});

	it("checkPurposeLockPath: allows Reviewer to write to .orvanta/artifacts/reviews/** only", () => {
		const reviewRes = checkPurposeLockPath({
			targetPath: ".orvanta/artifacts/reviews/review-task1.md",
			requesterId: "reviewer",
		});
		expect(reviewRes.allowed).toBe(true);

		// Reviewer blocked from other artifacts folders
		const deniedArtifact = checkPurposeLockPath({
			targetPath: ".orvanta/artifacts/marketing/email-sequence.md",
			requesterId: "reviewer",
		});
		expect(deniedArtifact.allowed).toBe(false);
		expect(deniedArtifact.code).toBe("purpose_lock_denied");
		expect(deniedArtifact.reason).toContain("artifacts/reviews");
	});

	it("checkPurposeLockPath: strictly forbids Reviewer from writing to project source code (src/**)", () => {
		const srcRes1 = checkPurposeLockPath({
			targetPath: "src/index.ts",
			requesterId: "reviewer",
		});
		expect(srcRes1.allowed).toBe(false);
		expect(srcRes1.code).toBe("purpose_lock_denied");
		expect(srcRes1.reason).toContain("source code dự án (src/**)");

		const srcRes2 = checkPurposeLockPath({
			targetPath: "src/auth/login.ts",
			requesterId: "reviewer",
		});
		expect(srcRes2.allowed).toBe(false);
		expect(srcRes2.code).toBe("purpose_lock_denied");
	});
	it("checkToolPolicy: allows Maker agents (copywriter, researcher, implementer) to write to artifacts", () => {
		const copyCheck = checkToolPolicy({
			toolName: "write_to_file",
			agentId: "copywriter",
			targetPath: ".orvanta/artifacts/marketing/sales-pitch.md",
		});
		expect(copyCheck.allowed).toBe(true);

		const researchCheck = checkToolPolicy({
			toolName: "apply_diff",
			agentId: "researcher",
			targetPath: ".orvanta/artifacts/research/competitor-notes.md",
		});
		expect(researchCheck.allowed).toBe(true);

		const implCheck = checkToolPolicy({
			toolName: "write_to_file",
			agentId: "implementer",
			targetPath: ".orvanta/artifacts/build/app.bundle.js",
		});
		expect(implCheck.allowed).toBe(true);
	});

	it("checkToolPolicy: blocks Reviewer on source code (src/**) and allows on artifacts/reviews/**", () => {
		const reviewerProfile = parseAgentProfile(REVIEWER_PROFILE_TEMPLATE);

		// Blocked on src/**
		const blockWriteSrc = checkToolPolicy({
			toolName: "write_to_file",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			targetPath: "src/core/controller.ts",
		});
		expect(blockWriteSrc.allowed).toBe(false);
		expect(blockWriteSrc.code).toBe("purpose_lock_denied");
		expect(blockWriteSrc.reason).toContain("source code dự án (src/**)");

		const blockDiffSrc = checkToolPolicy({
			toolName: "apply_diff",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			targetPath: "src/index.ts",
		});
		expect(blockDiffSrc.allowed).toBe(false);
		expect(blockDiffSrc.code).toBe("purpose_lock_denied");

		// Blocked on other artifacts
		const blockOtherArtifact = checkToolPolicy({
			toolName: "write_to_file",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			targetPath: ".orvanta/artifacts/marketing/email.md",
		});
		expect(blockOtherArtifact.allowed).toBe(false);
		expect(blockOtherArtifact.code).toBe("purpose_lock_denied");

		// Allowed in artifacts/reviews/**
		const allowReview = checkToolPolicy({
			toolName: "write_to_file",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			targetPath: ".orvanta/artifacts/reviews/review-email-seq.md",
		});
		expect(allowReview.allowed).toBe(true);
	});

	it("isAllowedReviewerCommand validates verification commands and rejects unauthorized commands", () => {
		// Valid test commands
		expect(isAllowedReviewerCommand("bun test")).toBe(true);
		expect(isAllowedReviewerCommand("bun test src/auth.test.ts")).toBe(true);
		expect(isAllowedReviewerCommand("npm test")).toBe(true);
		expect(isAllowedReviewerCommand("npm test -- --coverage")).toBe(true);
		expect(isAllowedReviewerCommand("pnpm test")).toBe(true);
		expect(isAllowedReviewerCommand("yarn test")).toBe(true);
		expect(isAllowedReviewerCommand("vitest run")).toBe(true);
		expect(isAllowedReviewerCommand("bunx vitest run")).toBe(true);
		expect(isAllowedReviewerCommand("jest")).toBe(true);

		// Valid typecheck commands
		expect(isAllowedReviewerCommand("bunx tsc --noEmit")).toBe(true);
		expect(isAllowedReviewerCommand("npm run typecheck")).toBe(true);
		expect(isAllowedReviewerCommand("bun run typecheck")).toBe(true);

		// Valid lint commands
		expect(isAllowedReviewerCommand("bun run lint")).toBe(true);
		expect(isAllowedReviewerCommand("npm run lint")).toBe(true);
		expect(isAllowedReviewerCommand("biome check")).toBe(true);
		expect(isAllowedReviewerCommand("eslint")).toBe(true);

		// Valid compound commands
		expect(isAllowedReviewerCommand("bun run typecheck && bun test")).toBe(true);

		// Dangerous or unauthorized commands
		expect(isAllowedReviewerCommand("rm -rf src")).toBe(false);
		expect(isAllowedReviewerCommand("curl https://evil.com")).toBe(false);
		expect(isAllowedReviewerCommand("node index.js")).toBe(false);
		expect(isAllowedReviewerCommand("git commit -m 'done'")).toBe(false);
		expect(isAllowedReviewerCommand("bun test && rm -rf /")).toBe(false);
	});

	it("checkToolPolicy: permits Reviewer execute_command for linter, typecheck, unit test only", () => {
		const reviewerProfile = parseAgentProfile(REVIEWER_PROFILE_TEMPLATE);

		// Safe verification commands
		const testCheck1 = checkToolPolicy({
			toolName: "execute_command",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			command: "bun test",
		});
		expect(testCheck1.allowed).toBe(true);

		const testCheck2 = checkToolPolicy({
			toolName: "execute_command",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			command: "npm test",
		});
		expect(testCheck2.allowed).toBe(true);

		const typecheckCheck = checkToolPolicy({
			toolName: "execute_command",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			command: "bunx tsc --noEmit",
		});
		expect(typecheckCheck.allowed).toBe(true);

		const lintCheck = checkToolPolicy({
			toolName: "execute_command",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			command: "biome check",
		});
		expect(lintCheck.allowed).toBe(true);

		// Dangerous command blocked
		const badCmd = checkToolPolicy({
			toolName: "execute_command",
			agentId: "reviewer",
			policy: reviewerProfile.tools,
			command: "rm -rf src",
		});
		expect(badCmd.allowed).toBe(false);
		expect(badCmd.code).toBe("purpose_lock_denied");
		expect(badCmd.reason).toContain("linter, typecheck và unit test");
	});

	it("wrapToolWithPurposeLock: allows Copywriter in marketing and blocks Reviewer in src/**", async () => {
		let executed = false;
		const fakeWriteTool: AgentTool = {
			name: "write_to_file",
			description: "write a file",
			inputSchema: {},
			execute: async () => {
				executed = true;
				return { ok: true };
			},
		};

		// 1. Copywriter writes to .orvanta/artifacts/marketing/email.md
		const copywriterWrapped = wrapToolWithPurposeLock(fakeWriteTool, {
			requesterId: "copywriter",
		});
		const copyCtx = { agentId: "copywriter", iteration: 1 } as AgentToolContext;

		executed = false;
		const copyRes = (await copywriterWrapped.execute(
			{ path: ".orvanta/artifacts/marketing/email.md" },
			copyCtx,
		)) as { ok: boolean };
		expect(executed).toBe(true);
		expect(copyRes.ok).toBe(true);

		// 2. Reviewer tries to write to src/main.ts -> blocked
		const reviewerProfile = parseAgentProfile(REVIEWER_PROFILE_TEMPLATE);
		const reviewerWrapped = wrapToolWithPurposeLock(fakeWriteTool, {
			requesterId: "reviewer",
			toolPolicy: reviewerProfile.tools,
		});
		const revCtx = { agentId: "reviewer", iteration: 1 } as AgentToolContext;

		executed = false;
		const revBlockRes = (await reviewerWrapped.execute(
			{ path: "src/main.ts" },
			revCtx,
		)) as { ok: boolean; code: string };
		expect(executed).toBe(false);
		expect(revBlockRes.ok).toBe(false);
		expect(revBlockRes.code).toBe("purpose_lock_denied");

		// 3. Reviewer writes to .orvanta/artifacts/reviews/report.md -> allowed
		executed = false;
		const revAllowRes = (await reviewerWrapped.execute(
			{ path: ".orvanta/artifacts/reviews/report.md" },
			revCtx,
		)) as { ok: boolean };
		expect(executed).toBe(true);
		expect(revAllowRes.ok).toBe(true);
	});

	it("wrapToolWithPurposeLock: allows Reviewer to run bun test but blocks rm -rf", async () => {
		let executed = false;
		const fakeCommandTool: AgentTool = {
			name: "execute_command",
			description: "run a shell command",
			inputSchema: {},
			execute: async () => {
				executed = true;
				return { ok: true };
			},
		};

		const reviewerProfile = parseAgentProfile(REVIEWER_PROFILE_TEMPLATE);
		const reviewerWrapped = wrapToolWithPurposeLock(fakeCommandTool, {
			requesterId: "reviewer",
			toolPolicy: reviewerProfile.tools,
		});
		const context = { agentId: "reviewer", iteration: 1 } as AgentToolContext;

		// Safe command
		executed = false;
		const safeRes = (await reviewerWrapped.execute(
			{ command: "bun test src/auth.test.ts" },
			context,
		)) as { ok: boolean };
		expect(executed).toBe(true);
		expect(safeRes.ok).toBe(true);

		// Blocked command
		executed = false;
		const blockedRes = (await reviewerWrapped.execute(
			{ command: "rm -rf dist" },
			context,
		)) as { ok: boolean; code: string };
		expect(executed).toBe(false);
		expect(blockedRes.ok).toBe(false);
		expect(blockedRes.code).toBe("purpose_lock_denied");
	});

	it("createPurposeLockHook: filters Reviewer and Maker tools via beforeTool hook", async () => {
		const reviewerProfile = parseAgentProfile(REVIEWER_PROFILE_TEMPLATE);
		const hook = createPurposeLockHook({
			requesterId: "reviewer",
			toolPolicy: reviewerProfile.tools,
		});

		// 1. Reviewer write to src/** -> skip: true
		const writeSrcCtx = {
			tool: { name: "write_to_file" },
			input: { path: "src/auth.ts" },
			snapshot: { agentId: "reviewer" },
		} as unknown as AgentBeforeToolContext;
		const writeSrcResult = await hook.beforeTool?.(writeSrcCtx);
		expect(writeSrcResult?.skip).toBe(true);
		expect(writeSrcResult?.reason).toContain("purpose_lock_denied");

		// 2. Reviewer write to .orvanta/artifacts/reviews/** -> undefined (allowed)
		const writeRevCtx = {
			tool: { name: "write_to_file" },
			input: { path: ".orvanta/artifacts/reviews/review-01.md" },
			snapshot: { agentId: "reviewer" },
		} as unknown as AgentBeforeToolContext;
		const writeRevResult = await hook.beforeTool?.(writeRevCtx);
		expect(writeRevResult).toBeUndefined();

		// 3. Reviewer execute_command 'bun test' -> undefined (allowed)
		const cmdTestCtx = {
			tool: { name: "execute_command" },
			input: { command: "bun test" },
			snapshot: { agentId: "reviewer" },
		} as unknown as AgentBeforeToolContext;
		const cmdTestResult = await hook.beforeTool?.(cmdTestCtx);
		expect(cmdTestResult).toBeUndefined();

		// 4. Reviewer execute_command 'node server.js' -> skip: true
		const cmdBadCtx = {
			tool: { name: "execute_command" },
			input: { command: "node server.js" },
			snapshot: { agentId: "reviewer" },
		} as unknown as AgentBeforeToolContext;
		const cmdBadResult = await hook.beforeTool?.(cmdBadCtx);
		expect(cmdBadResult?.skip).toBe(true);
		expect(cmdBadResult?.reason).toContain("purpose_lock_denied");
	});
});


