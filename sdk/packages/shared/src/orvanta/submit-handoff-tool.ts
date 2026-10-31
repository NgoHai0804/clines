import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createTool } from "../tools/create";

export const OrvantaSubmitHandoffInputSchema = z.object({
	taskId: z.string().min(1, "taskId is required").describe("Task identifier"),
	content: z
		.string()
		.min(1, "content is required")
		.describe("Handoff markdown content"),
});
export type OrvantaSubmitHandoffInput = z.infer<
	typeof OrvantaSubmitHandoffInputSchema
>;

export interface SubmitHandoffToolOutput {
	ok: boolean;
	path?: string;
	error?: string;
	taskCompleted?: boolean;
}

export interface SubmitHandoffSubmittedInfo {
	taskId: string;
	content: string;
	requesterId: string;
	path: string;
}

export function createOrvantaSubmitHandoffTool(options: {
	workspaceRoot: string;
	requesterId?: string;
	/**
	 * Host hook after the handoff file is written. Use to mark the team task
	 * Completed and notify the Coordinator. Must not throw for missing tasks —
	 * callers should soft-fail so ad-hoc taskIds still deliver the report.
	 */
	onSubmitted?: (
		info: SubmitHandoffSubmittedInfo,
	) => void | Promise<{ taskCompleted?: boolean } | void>;
}) {
	return createTool<
		typeof OrvantaSubmitHandoffInputSchema,
		SubmitHandoffToolOutput
	>({
		name: "orvanta_submit_handoff",
		description:
			"Hoàn thành task đã được giao: nộp kết quả (handoff). Hệ thống ghi vào .orvanta/shared/handoffs/<taskId>/<requesterId>.md, đánh dấu task Completed (nếu có), và gửi báo cáo về Coordinator. Đặt toàn bộ kết quả vào content. Gọi thành công sẽ kết thúc lượt — không viết thêm tin chat và không gọi submit_and_exit. Với tin nhắn nhanh / kiểm tra tình trạng (không phải phiếu task), dùng team_send_message thay thế.",
		inputSchema: OrvantaSubmitHandoffInputSchema,
		lifecycle: { completesRun: true },
		execute: async (input) => {
			try {
				const requesterId = options.requesterId || "agent";
				const sanitizedTaskId = input.taskId.replace(
					/[^a-zA-Z0-9._-]/g,
					"-",
				);
				const sanitizedRequester = requesterId.replace(
					/[^a-zA-Z0-9._-]/g,
					"-",
				);
				const relPath = `.orvanta/shared/handoffs/${sanitizedTaskId}/${sanitizedRequester}.md`;
				const fullPath = join(options.workspaceRoot, relPath);
				await mkdir(dirname(fullPath), { recursive: true });
				await writeFile(fullPath, input.content, "utf8");

				let taskCompleted = false;
				if (options.onSubmitted) {
					const hookResult = await options.onSubmitted({
						taskId: input.taskId,
						content: input.content,
						requesterId,
						path: relPath,
					});
					taskCompleted = Boolean(hookResult?.taskCompleted);
				}

				return { ok: true, path: relPath, taskCompleted };
			} catch (err: any) {
				return { ok: false, error: err?.message || String(err) };
			}
		},
	});
}
