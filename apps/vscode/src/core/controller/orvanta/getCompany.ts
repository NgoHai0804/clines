import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { loadCompanyReadOnly, WORKSPACE_DIRNAME } from "@cline/shared"
import { EmptyRequest } from "@shared/proto/cline/common"
import { OrvantaCompanyResponse } from "@shared/proto/cline/orvanta"
import { resolveOrvantaWorkspaceRoot } from "@/orvanta/resolve-workspace"
import { globalTeamStatusTracker } from "@/orvanta/team-status-tracker"
import { toCompanyResponse } from "@/orvanta/to-company-response"
import type { Controller } from ".."

/**
 * Read-only snapshot for UI. Avoids the roster writer lock (stale .lock files
 * previously made Home hang until the 12s webview timeout).
 */
export async function getCompany(_controller: Controller, _request: EmptyRequest): Promise<OrvantaCompanyResponse> {
	const root = await resolveOrvantaWorkspaceRoot()
	if (!root) {
		return toCompanyResponse({ status: "missing" }, ["no_folder"])
	}
	let tasksJson = ""
	try {
		const teamDataDir = process.env.CLINE_TEAM_DATA_DIR || join(root, WORKSPACE_DIRNAME, "state", "team")
		tasksJson = await readFile(join(teamDataDir, "tasks.json"), "utf8")
	} catch {
		// optional tasks.json
	}
	return toCompanyResponse(await loadCompanyReadOnly(root), [], globalTeamStatusTracker.getRunningAgentIds(), tasksJson)
}
