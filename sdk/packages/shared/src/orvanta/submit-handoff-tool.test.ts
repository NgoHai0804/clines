import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createOrvantaSubmitHandoffTool } from "./submit-handoff-tool";

async function tempWorkspace(): Promise<string> {
	return mkdtemp(join(tmpdir(), "orvanta-handoff-test-"));
}

describe("orvanta_submit_handoff tool", () => {
	it("ends the agent run after a successful handoff", () => {
		const tool = createOrvantaSubmitHandoffTool({
			workspaceRoot: "/tmp",
			requesterId: "coder",
		});
		expect(tool.lifecycle).toEqual({ completesRun: true });
	});

	it("writes handoff content to .orvanta/shared/handoffs/<taskId>/<requesterId>.md", async () => {
		const ws = await tempWorkspace();
		try {
			const tool = createOrvantaSubmitHandoffTool({
				workspaceRoot: ws,
				requesterId: "implementer",
			});
			const result = await tool.execute(
				{
					taskId: "task-auth-123",
					content: "# Implementation summary\nDone auth with JWT",
				},
				{} as any,
			);
			expect(result.ok).toBe(true);
			expect(result.path).toBe(
				".orvanta/shared/handoffs/task-auth-123/implementer.md",
			);

			const written = await readFile(join(ws, result.path!), "utf8");
			expect(written).toBe(
				"# Implementation summary\nDone auth with JWT",
			);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("sanitizes taskId and requesterId in handoff path", async () => {
		const ws = await tempWorkspace();
		try {
			const tool = createOrvantaSubmitHandoffTool({
				workspaceRoot: ws,
				requesterId: "reviewer/sub",
			});
			const result = await tool.execute(
				{
					taskId: "task/review#1",
					content: "# Review notes\nLooks good",
				},
				{} as any,
			);
			expect(result.ok).toBe(true);
			expect(result.path).toBe(
				".orvanta/shared/handoffs/task-review-1/reviewer-sub.md",
			);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});

	it("invokes onSubmitted after writing the handoff file", async () => {
		const ws = await tempWorkspace();
		try {
			const calls: Array<{ taskId: string; requesterId: string; path: string }> =
				[];
			const tool = createOrvantaSubmitHandoffTool({
				workspaceRoot: ws,
				requesterId: "reviewer",
				onSubmitted: async (info) => {
					calls.push({
						taskId: info.taskId,
						requesterId: info.requesterId,
						path: info.path,
					});
					return { taskCompleted: true };
				},
			});
			const result = await tool.execute(
				{
					taskId: "task_0001",
					content: "Status OK",
				},
				{} as any,
			);
			expect(result.ok).toBe(true);
			expect(result.taskCompleted).toBe(true);
			expect(calls).toEqual([
				{
					taskId: "task_0001",
					requesterId: "reviewer",
					path: ".orvanta/shared/handoffs/task_0001/reviewer.md",
				},
			]);
		} finally {
			await rm(ws, { recursive: true, force: true });
		}
	});
});
