import type {
	AgentBeforeToolContext,
	AgentBeforeToolResult,
	AgentTool,
	AgentToolContext,
} from "../agent";
import type { AgentHooks } from "../agents/types";

import {
	WORKSPACE_DIRNAME,
	ARTIFACTS_DIRNAME,
	ARTIFACTS_REVIEWS_DIR,
} from "./paths";

export interface PurposeLockCheckResult {
	allowed: boolean;
	code?: "purpose_lock_denied";
	reason?: string;
	path?: string;
}

export interface CheckPurposeLockOptions {
	targetPath: string;
	workspaceRoot?: string;
	requesterId?: string;
}

export function normalizeTargetPath(
	targetPath: string,
	workspaceRoot?: string,
): string {
	let normalized = targetPath.replace(/\\/g, "/").trim();
	if (workspaceRoot) {
		const normRoot = workspaceRoot.replace(/\\/g, "/").replace(/\/+$/, "");
		if (normalized.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
			normalized = normalized.slice(normRoot.length + 1);
		} else if (normalized.toLowerCase() === normRoot.toLowerCase()) {
			normalized = "";
		}
	}
	while (normalized.startsWith("./")) {
		normalized = normalized.slice(2);
	}
	return normalized;
}

export function isArtifactPath(normalizedPath: string): boolean {
	const lower = normalizedPath.toLowerCase();
	return (
		lower === `${WORKSPACE_DIRNAME}/${ARTIFACTS_DIRNAME}` ||
		lower.startsWith(`${WORKSPACE_DIRNAME}/${ARTIFACTS_DIRNAME}/`) ||
		lower === ARTIFACTS_DIRNAME ||
		lower.startsWith(`${ARTIFACTS_DIRNAME}/`)
	);
}

export function isReviewArtifactPath(normalizedPath: string): boolean {
	const lower = normalizedPath.toLowerCase();
	return (
		lower === `${WORKSPACE_DIRNAME}/${ARTIFACTS_REVIEWS_DIR}` ||
		lower.startsWith(`${WORKSPACE_DIRNAME}/${ARTIFACTS_REVIEWS_DIR}/`) ||
		lower === ARTIFACTS_REVIEWS_DIR ||
		lower.startsWith(`${ARTIFACTS_REVIEWS_DIR}/`)
	);
}

export function isSourceCodePath(normalizedPath: string): boolean {
	const lower = normalizedPath.toLowerCase();
	return (
		lower === "src" ||
		lower.startsWith("src/") ||
		lower.includes("/src/")
	);
}

export function isAllowedReviewerCommand(command: string): boolean {
	if (!command || typeof command !== "string") return false;
	const trimmed = command.trim();
	if (!trimmed) return false;

	const subCommands = trimmed
		.split(/&&|;|\|\|/)
		.map((c) => c.trim())
		.filter(Boolean);
	if (subCommands.length === 0) return false;

	const testRegex =
		/^(bun|npm|pnpm|yarn)\s+(run\s+)?(test|t)(\s+.*)?$/i;
	const vitestRegex =
		/^(bunx\s+|npx\s+|bun\s+run\s+|npm\s+run\s+)?vitest(\s+.*)?$/i;
	const jestRegex =
		/^(bunx\s+|npx\s+|bun\s+run\s+|npm\s+run\s+)?jest(\s+.*)?$/i;
	const mochaRegex =
		/^(bunx\s+|npx\s+|bun\s+run\s+|npm\s+run\s+)?mocha(\s+.*)?$/i;

	const typecheckRegex =
		/^(bunx\s+|npx\s+)?tsc(\s+.*)?$/i;
	const typecheckScriptRegex =
		/^(bun|npm|pnpm|yarn)\s+(run\s+)?typecheck(\s+.*)?$/i;

	const lintRegex =
		/^(bunx\s+|npx\s+)?(eslint|biome\s+(check|lint)|@biomejs\/biome\s+(check|lint))(\s+.*)?$/i;
	const lintScriptRegex =
		/^(bun|npm|pnpm|yarn)\s+(run\s+)?(lint|check)(\s+.*)?$/i;

	return subCommands.every(
		(sub) =>
			testRegex.test(sub) ||
			vitestRegex.test(sub) ||
			jestRegex.test(sub) ||
			mochaRegex.test(sub) ||
			typecheckRegex.test(sub) ||
			typecheckScriptRegex.test(sub) ||
			lintRegex.test(sub) ||
			lintScriptRegex.test(sub),
	);
}

export function validateMemoryPath(targetPath: string): boolean {
	const normalized = targetPath.replace(/\\/g, "/");
	if (normalized.includes("..")) return false;
	return normalized.endsWith(".md");
}

export function checkPurposeLockPath(
	options: CheckPurposeLockOptions,
): PurposeLockCheckResult {
	const relPath = normalizeTargetPath(options.targetPath, options.workspaceRoot);
	const lower = relPath.toLowerCase();

	if (relPath.includes("..") || relPath.split("/").includes("..")) {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason: "Path traversal (..) bị cấm bởi Purpose-lock.",
			path: relPath,
		};
	}

	const isReviewer =
		options.requesterId?.toLowerCase().trim() === "reviewer" ||
		options.requesterId?.toLowerCase().includes("reviewer");

	// Reviewer is strictly forbidden from writing to project source code (src/**)
	if (isReviewer && isSourceCodePath(relPath)) {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason:
				"Reviewer không được phép sửa mã nguồn dự án (src/**). Tuyệt đối cấm reviewer dùng apply_diff hoặc write_to_file trên source code dự án (src/**).",
			path: relPath,
		};
	}

	const isInsideOrvanta =
		lower === WORKSPACE_DIRNAME || lower.startsWith(`${WORKSPACE_DIRNAME}/`);

	if (!isInsideOrvanta) {
		if (isReviewer) {
			return {
				allowed: false,
				code: "purpose_lock_denied",
				reason:
					"Reviewer không được phép sửa mã nguồn dự án ngoài artifacts/reviews/**. Chỉ được ghi biên bản vào .orvanta/artifacts/reviews/**.",
				path: relPath,
			};
		}
		return { allowed: true, path: relPath };
	}

	const subPath = lower.slice(WORKSPACE_DIRNAME.length + 1);

	// Artifacts folder: .orvanta/artifacts/**
	if (subPath === "artifacts" || subPath.startsWith("artifacts/")) {
		if (isReviewer) {
			if (
				subPath === "artifacts/reviews" ||
				subPath.startsWith("artifacts/reviews/")
			) {
				return { allowed: true, path: relPath };
			}
			return {
				allowed: false,
				code: "purpose_lock_denied",
				reason:
					"Reviewer chỉ được ghi biên bản vào .orvanta/artifacts/reviews/**.",
				path: relPath,
			};
		}
		// Maker agents (copywriter, researcher, implementer, etc.) are allowed in .orvanta/artifacts/**
		return { allowed: true, path: relPath };
	}

	// Memory folder: .orvanta/memory/** or .orvanta/local/memory/**
	if (
		subPath === "memory" ||
		subPath.startsWith("memory/") ||
		subPath === "local/memory" ||
		subPath.startsWith("local/memory/")
	) {
		if (relPath.includes("..") || !subPath.endsWith(".md")) {
			return {
				allowed: false,
				code: "purpose_lock_denied",
				reason:
					"Thư mục memory/ chỉ chấp nhận file .md và chặn path traversal (..).",
				path: relPath,
			};
		}
		const requester = options.requesterId?.toLowerCase().trim();
		const acceptedOwn = requester
			? `local/memory/agents/${requester}/memory.md`
			: undefined;
		if (acceptedOwn && subPath === acceptedOwn) {
			return {
				allowed: false,
				code: "purpose_lock_denied",
				reason:
					"Agent không được ghi thẳng memory.md đã chấp nhận. Chỉ được đề xuất trong proposals/.",
				path: relPath,
			};
		}
		const ownProposalPrefix = requester
			? `local/memory/agents/${requester}/proposals/`
			: undefined;
		if (ownProposalPrefix && subPath.startsWith(ownProposalPrefix)) {
			return { allowed: true, path: relPath };
		}
		if (subPath === "memory" || subPath.startsWith("memory/")) {
			return { allowed: true, path: relPath };
		}
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason: "Không được ghi memory của agent khác.",
			path: relPath,
		};
	}

	// Agent's own space: org/agents/<requesterId>/workspace/**
	if (options.requesterId) {
		const ownPrefix = `org/agents/${options.requesterId.toLowerCase()}/workspace/`;
		if (subPath.startsWith(ownPrefix)) {
			return { allowed: true, path: relPath };
		}
	}

	// Hand-offs folder requires orvanta_submit_handoff
	if (subPath === "shared/handoffs" || subPath.startsWith("shared/handoffs/")) {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason:
				"Ghi trực tiếp vào shared/handoffs bằng write_to_file bị cấm. Phải dùng orvanta_submit_handoff để nộp bài.",
			path: relPath,
		};
	}

	// 3 mandatory deny write paths
	if (lower === ".orvanta/purpose.md") {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason: "Sửa .orvanta/purpose.md bị cấm bởi Purpose-lock (lớp 2).",
			path: relPath,
		};
	}
	if (lower === ".orvanta/company.json") {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason: "Sửa .orvanta/company.json bị cấm bởi Purpose-lock (lớp 2).",
			path: relPath,
		};
	}
	if (lower === ".orvanta/org/roster.json") {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason: "Sửa .orvanta/org/roster.json bị cấm bởi Purpose-lock (lớp 2).",
			path: relPath,
		};
	}

	// Profile files (identity)
	if (subPath.startsWith("org/agents/") && subPath.endsWith("/profile.md")) {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason:
				"Sửa profile.md của chính mình hoặc agent khác bị cấm bởi Purpose-lock.",
			path: relPath,
		};
	}

	// Other agents' workspaces
	if (subPath.startsWith("org/agents/") && subPath.includes("/workspace/")) {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			reason: "Không được ghi vào không gian làm việc của agent khác.",
			path: relPath,
		};
	}

	return {
		allowed: false,
		code: "purpose_lock_denied",
		reason: "Vùng hệ thống .orvanta được bảo vệ bởi Purpose-lock.",
		path: relPath,
	};
}
export const WRITE_TOOL_NAMES = new Set([
	"write_to_file",
	"editor",
	"apply_patch",
	"apply_diff",
	"write_file",
]);

export interface ToolPolicyOptions {
	allow?: string[];
	deny?: string[];
}

export interface ToolPolicyCheckResult {
	allowed: boolean;
	code?: "purpose_lock_denied";
	tool: string;
	reason?: string;
}

export interface CheckToolPolicyOptions {
	toolName: string;
	agentId?: string;
	policy?: ToolPolicyOptions;
	scopePaths?: {
		allow?: string[];
		denyWrite?: string[];
	};
	targetPath?: string;
	command?: string;
	workspaceRoot?: string;
}

/**
 * Team/Orvanta plumbing tools. Role allow-lists describe work capabilities
 * (read/write/exec); they must not accidentally block mailbox replies or task
 * closeout. Explicit deny still wins as an escape hatch.
 */
export const COORDINATION_TOOL_NAMES = new Set([
	"team_send_message",
	"team_read_mailbox",
	"team_mission_log",
	"team_status",
	"team_task",
	"orvanta_submit_handoff",
]);

export function isCoordinationTool(toolName: string): boolean {
	return COORDINATION_TOOL_NAMES.has(toolName.toLowerCase().trim());
}

export function checkToolPolicy(
	options: CheckToolPolicyOptions,
): ToolPolicyCheckResult {
	const tool = options.toolName.toLowerCase().trim();
	const agentId = (options.agentId || "agent").toLowerCase().trim();
	const policy = options.policy;

	const isWriteTool =
		WRITE_TOOL_NAMES.has(tool) ||
		tool === "write_to_file" ||
		tool === "apply_diff";
	const isCommandTool =
		tool === "execute_command" ||
		tool === "run_commands" ||
		tool === "bash";

	const normPath = options.targetPath
		? normalizeTargetPath(options.targetPath, options.workspaceRoot)
		: undefined;

	const isReviewer =
		agentId === "reviewer" ||
		agentId.endsWith("-reviewer") ||
		agentId.includes("reviewer");

	// 1. Reviewer special rules
	if (isReviewer) {
		// Reviewer write tools: strictly forbidden on source code (src/**), allowed only in artifacts/reviews/**
		if (isWriteTool) {
			if (normPath) {
				if (isSourceCodePath(normPath)) {
					return {
						allowed: false,
						code: "purpose_lock_denied",
						tool: options.toolName,
						reason: `Tuyệt đối cấm reviewer dùng ${options.toolName} trên source code dự án (src/**).`,
					};
				}
				if (isReviewArtifactPath(normPath)) {
					return { allowed: true, tool: options.toolName };
				}
				return {
					allowed: false,
					code: "purpose_lock_denied",
					tool: options.toolName,
					reason: `Reviewer chỉ được ghi biên bản vào .orvanta/artifacts/reviews/**, không được ghi vào '${normPath}'.`,
				};
			}
		}

		// Reviewer execute_command tools: only linter, typecheck, unit test allowed
		if (isCommandTool) {
			if (options.command) {
				if (isAllowedReviewerCommand(options.command)) {
					return { allowed: true, tool: options.toolName };
				}
				return {
					allowed: false,
					code: "purpose_lock_denied",
					tool: options.toolName,
					reason: `Reviewer chỉ được phép dùng execute_command để chạy linter, typecheck và unit test (ví dụ: bun test, npm test). Lệnh không hợp lệ: '${options.command}'.`,
				};
			}
		}
	}

	// 2. Maker agents (copywriter, researcher, implementer, etc.) writing to artifacts
	if (isWriteTool && normPath) {
		// Non-coder maker agents (copywriter, sales-rep, etc.) are forbidden from writing to project source code
		if (
			(agentId === "copywriter" ||
				agentId.includes("copywriter") ||
				agentId === "sales-rep" ||
				agentId.includes("sales")) &&
			isSourceCodePath(normPath)
		) {
			return {
				allowed: false,
				code: "purpose_lock_denied",
				tool: options.toolName,
				reason: `Vai trò ${agentId} không được phép ghi mã nguồn dự án (src/**). Chỉ được ghi vào thư mục artifacts tương ứng.`,
			};
		}

		if (options.scopePaths?.allow && options.scopePaths.allow.length > 0) {
			const allowedScopes = options.scopePaths.allow;
			const isWithinScope = allowedScopes.some((p) => {
				if (p === "**/*") return true;
				const clean = p.replace(/\*\*$/, "").replace(/\/+$/, "").toLowerCase();
				const lowerNorm = normPath.toLowerCase();
				return (
					lowerNorm === clean ||
					lowerNorm.startsWith(`${clean}/`) ||
					lowerNorm.startsWith(`.orvanta/${clean}/`)
				);
			});
			if (!isWithinScope) {
				return {
					allowed: false,
					code: "purpose_lock_denied",
					tool: options.toolName,
					reason: `Đường dẫn '${normPath}' nằm ngoài phạm vi được phép ghi của vai trò ${agentId}.`,
				};
			}
		}

		if (isArtifactPath(normPath)) {
			return { allowed: true, tool: options.toolName };
		}
	}

	// 3. Fallback to standard role policy (deny / allow lists)
	if (!policy) {
		return { allowed: true, tool: options.toolName };
	}

	const denyList = (policy.deny || []).map((t) => t.toLowerCase().trim());
	if (denyList.includes(tool)) {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			tool: options.toolName,
			reason: `Tool '${options.toolName}' bị từ chối bởi chính sách vai trò của ${agentId}.`,
		};
	}

	// Coordination tools bypass allow-lists so teammates can always reply /
	// close tasks even when profiles only list work tools (read/grep/…).
	if (isCoordinationTool(tool)) {
		return { allowed: true, tool: options.toolName };
	}

	const allowList = (policy.allow || []).map((t) => t.toLowerCase().trim());
	if (allowList.length > 0 && !allowList.includes(tool)) {
		return {
			allowed: false,
			code: "purpose_lock_denied",
			tool: options.toolName,
			reason: `Tool '${options.toolName}' không nằm trong danh sách cho phép của vai trò ${agentId}.`,
		};
	}

	return { allowed: true, tool: options.toolName };
}

export const MAX_EPHEMERAL_PER_SESSION = 3;

export class EphemeralTracker {
	private count: number = 0;
	private readonly limit: number;

	constructor(limit: number = MAX_EPHEMERAL_PER_SESSION) {
		this.limit = limit;
	}

	getCount(): number {
		return this.count;
	}

	getLimit(): number {
		return this.limit;
	}

	canSpawn(): { allowed: boolean; count: number; limit: number; code?: "over_ephemeral"; reason?: string } {
		if (this.count >= this.limit) {
			return {
				allowed: false,
				count: this.count,
				limit: this.limit,
				code: "over_ephemeral",
				reason: `Đã đạt giới hạn tối đa ${this.limit} guest ephemeral trong session này.`,
			};
		}
		return { allowed: true, count: this.count, limit: this.limit };
	}

	recordSpawn(): boolean {
		const check = this.canSpawn();
		if (!check.allowed) {
			return false;
		}
		this.count++;
		return true;
	}

	reset(): void {
		this.count = 0;
	}
}

export function extractNegativePurposeMarkers(purposeText: string): string[] {
	if (!purposeText) return [];
	const lines = purposeText.split("\n");
	const markers: string[] = [];
	let inNegativeSection = false;

	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed.startsWith("#")) {
			const headerLower = trimmed.toLowerCase();
			if (headerLower.includes("không làm") || headerLower.includes("out of scope") || headerLower.includes("non-goals")) {
				inNegativeSection = true;
				continue;
			} else if (inNegativeSection) {
				inNegativeSection = false;
			}
		}

		if (inNegativeSection) {
			let content = trimmed;
			if (content.startsWith("- ") || content.startsWith("* ")) {
				content = content.slice(2).trim();
			}
			if (content.length > 2) {
				const lower = content.toLowerCase();
				markers.push(lower);
				const negativePrefixes = [
					"không được ",
					"không nên ",
					"không ",
					"never ",
					"do not ",
					"don't ",
					"no ",
				];
				for (const prefix of negativePrefixes) {
					if (lower.startsWith(prefix)) {
						const stripped = lower.slice(prefix.length).trim();
						if (stripped.length > 2) {
							markers.push(stripped);
						}
						break;
					}
				}
			}
		}
	}

	return markers;
}

export function classifyTaskScope(
	task: {
		title: string;
		description?: string;
		scopePaths?: string[];
		requiresScopeApproval?: boolean;
	},
	options: {
		purpose?: string;
		companyAllowScope?: string[];
	} = {},
): { outsidePurpose: boolean; reason?: string; matchedMarker?: string } {
	if (task.requiresScopeApproval === true) {
		return {
			outsidePurpose: true,
			reason: "Task được đánh dấu yêu cầu phê duyệt scope từ CEO.",
		};
	}

	if (options.companyAllowScope && options.companyAllowScope.length > 0) {
		const allow = options.companyAllowScope;
		if (task.scopePaths && task.scopePaths.length > 0) {
			for (const p of task.scopePaths) {
				const isAllowed = allow.some((a) => a === "**/*" || a === p || p.startsWith(a));
				if (!isAllowed) {
					return {
						outsidePurpose: true,
						reason: `Phạm vi file '${p}' nằm ngoài danh sách cho phép của công ty.`,
					};
				}
			}
		}
	}

	if (options.purpose) {
		const negativeMarkers = extractNegativePurposeMarkers(options.purpose);
		const fullText = `${task.title} ${task.description || ""}`.toLowerCase();
		for (const marker of negativeMarkers) {
			if (fullText.includes(marker)) {
				return {
					outsidePurpose: true,
					matchedMarker: marker,
					reason: `Task chứa nội dung thuộc mục 'Không làm' của purpose: '${marker}'.`,
				};
			}
		}
	}

	return { outsidePurpose: false };
}


function extractCommand(input: unknown): string | undefined {
	if (!input || typeof input !== "object") return undefined;
	const rec = input as Record<string, unknown>;
	if (typeof rec.command === "string" && rec.command.trim()) {
		return rec.command.trim();
	}
	if (Array.isArray(rec.commands) && rec.commands.length > 0) {
		const valid = rec.commands.filter((c): c is string => typeof c === "string" && c.trim().length > 0);
		if (valid.length > 0) {
			return valid.join(" && ");
		}
	}
	return undefined;
}

function extractTargetPaths(input: unknown): string[] {
	if (!input || typeof input !== "object") return [];
	const rec = input as Record<string, unknown>;
	const paths: string[] = [];
	for (const key of ["path", "filePath", "targetPath"]) {
		if (typeof rec[key] === "string" && (rec[key] as string).trim()) {
			paths.push((rec[key] as string).trim());
		}
	}
	return paths;
}

export interface PurposeLockToolOptions {
	workspaceRoot?: string;
	requesterId?: string;
	toolPolicy?: ToolPolicyOptions;
}

export function createPurposeLockHook(
	options: PurposeLockToolOptions = {},
): AgentHooks {
	return {
		beforeTool: async (
			context: AgentBeforeToolContext,
		): Promise<AgentBeforeToolResult | undefined> => {
			const requesterId = options.requesterId ?? context.snapshot.agentId;
			const command = extractCommand(context.input);
			const paths = extractTargetPaths(context.input);
			const targetPath = paths[0];

			if (options.toolPolicy || command || targetPath) {
				const policyCheck = checkToolPolicy({
					toolName: context.tool.name,
					agentId: requesterId,
					policy: options.toolPolicy,
					targetPath,
					command,
					workspaceRoot: options.workspaceRoot,
				});
				if (!policyCheck.allowed) {
					return {
						skip: true,
						reason: JSON.stringify({
							ok: false,
							code: policyCheck.code,
							tool: context.tool.name,
							reason: policyCheck.reason,
						}),
					};
				}
			}

			if (!WRITE_TOOL_NAMES.has(context.tool.name.toLowerCase())) {
				return undefined;
			}
			for (const p of paths) {
				const check = checkPurposeLockPath({
					targetPath: p,
					workspaceRoot: options.workspaceRoot,
					requesterId,
				});
				if (!check.allowed) {
					return {
						skip: true,
						reason: JSON.stringify({
							ok: false,
							code: check.code,
							path: p,
							reason: check.reason,
						}),
					};
				}
			}
			return undefined;
		},
	};
}

export function wrapToolWithPurposeLock<TInput, TOutput>(
	tool: AgentTool<TInput, TOutput>,
	options: PurposeLockToolOptions = {},
): AgentTool<TInput, TOutput> {
	const isWrite = WRITE_TOOL_NAMES.has(tool.name.toLowerCase());
	const hasPolicy = !!options.toolPolicy;

	if (!isWrite && !hasPolicy) {
		return tool;
	}

	return {
		...tool,
		execute: async (input: TInput, context: AgentToolContext): Promise<TOutput> => {
			const requesterId = options.requesterId ?? context.agentId;
			const command = extractCommand(input);
			const paths = extractTargetPaths(input);
			const targetPath = paths[0];

			if (options.toolPolicy || command || targetPath) {
				const policyCheck = checkToolPolicy({
					toolName: tool.name,
					agentId: requesterId,
					policy: options.toolPolicy,
					targetPath,
					command,
					workspaceRoot: options.workspaceRoot,
				});
				if (!policyCheck.allowed) {
					return {
						ok: false,
						code: policyCheck.code,
						tool: tool.name,
						reason: policyCheck.reason,
					} as unknown as TOutput;
				}
			}

			if (isWrite) {
				for (const p of paths) {
					const check = checkPurposeLockPath({
						targetPath: p,
						workspaceRoot: options.workspaceRoot,
						requesterId,
					});
					if (!check.allowed) {
						return {
							ok: false,
							code: check.code,
							path: p,
							reason: check.reason,
						} as unknown as TOutput;
					}
				}
			}

			return tool.execute(input, context);
		},
	};
}
