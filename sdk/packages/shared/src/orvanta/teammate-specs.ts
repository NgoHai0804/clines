import type { TeamTeammateSpec } from "../team/schema";
import type { AgentProfile } from "./agent-profile";
import type { RosterJson } from "./company-schema";
import { injectAgentMemory } from "./system-prompt";

export type AgentProfileLookup =
	| Map<string, AgentProfile>
	| Record<string, AgentProfile>
	| ((agentId: string) => AgentProfile | undefined);

/** Appended to every teammate rolePrompt so completing the assigned task ends the run. */
export const TEAMMATE_CLOSEOUT_PROMPT = `## Kết thúc nhiệm vụ
- Phiếu task (có \`taskId\`): hoàn thành bằng \`orvanta_submit_handoff\` — đặt toàn bộ kết quả/artifact/evidence vào \`content\`. Hệ thống đánh dấu task Completed và gửi báo cáo về Coordinator.
- Tin nhắn nhanh / kiểm tra tình trạng / hỏi đáp (không phải đóng phiếu): trả lời bằng \`team_send_message\` tới Coordinator với nội dung đầy đủ trong body.
Không viết thêm tin chat sau khi tool closeout thành công, không gọi \`submit_and_exit\`, không chỉ trả lời bằng chat trên kênh (Coordinator sẽ không nhận được).`;

export function appendTeammateCloseout(prompt: string): string {
	const trimmed = prompt.trim();
	if (trimmed.includes("## Kết thúc nhiệm vụ")) {
		return trimmed;
	}
	return trimmed ? `${trimmed}\n\n${TEAMMATE_CLOSEOUT_PROMPT}` : TEAMMATE_CLOSEOUT_PROMPT;
}

export interface BuildTeammateSpecsOptions {
	fallbackModelId?: string;
	memories?:
		| Map<string, string>
		| Record<string, string>
		| ((agentId: string) => string | undefined);
}

function resolveProfile(
	lookup: AgentProfileLookup,
	agentId: string,
): AgentProfile | undefined {
	if (typeof lookup === "function") {
		return lookup(agentId);
	}
	if (lookup instanceof Map) {
		return lookup.get(agentId);
	}
	return lookup[agentId];
}

/**
 * Maps roster agents to TeamTeammateSpec instances for agent-teams runtime bootstrap.
 *
 * Rules (P5):
 * - Role must be "teammate" (lead/coordinator is skipped)
 * - Status must NOT be pending_* (e.g. pending_hire, pending_fire)
 * - Status must NOT be stopped
 * - rolePrompt is taken from profile.instructions
 * - modelId is taken from profile.modelId ?? roster.modelId ?? fallbackModelId
 * - maxIterations is taken from profile.maxIterations ?? roster.maxIterations
 */
export function buildTeammateSpecs(
	roster: RosterJson,
	profiles: AgentProfileLookup,
	options: BuildTeammateSpecsOptions = {},
): TeamTeammateSpec[] {
	const specs: TeamTeammateSpec[] = [];

	for (const agent of roster.agents) {
		if (agent.role !== "teammate") {
			continue;
		}
		if (agent.status.startsWith("pending_") || agent.status === "stopped") {
			continue;
		}

		const profile = resolveProfile(profiles, agent.id);
		let rolePrompt = profile?.instructions?.trim() || "";

		if (options.memories) {
			const memory =
				typeof options.memories === "function"
					? options.memories(agent.id)
					: options.memories instanceof Map
						? options.memories.get(agent.id)
						: options.memories[agent.id];
			if (memory) {
				rolePrompt = injectAgentMemory(rolePrompt, memory);
			}
		}

		rolePrompt = appendTeammateCloseout(rolePrompt);

		const rawModelId = profile?.modelId ?? agent.modelId ?? options.fallbackModelId;
		const modelId =
			typeof rawModelId === "string" && rawModelId.trim().length > 0
				? rawModelId.trim()
				: undefined;

		const maxIterations =
			profile?.maxIterations ?? agent.maxIterations ?? undefined;

		const tools = profile?.tools;

		specs.push({
			agentId: agent.id,
			rolePrompt,
			...(modelId ? { modelId } : {}),
			...(maxIterations !== undefined ? { maxIterations } : {}),
			...(tools ? { tools } : {}),
		});
	}

	return specs;
}
