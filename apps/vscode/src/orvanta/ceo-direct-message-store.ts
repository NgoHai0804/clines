import type { ClineMessage } from "@shared/ExtensionMessage"

export type CeoDirectMessageRecord = {
	ts: number
	agentId: string
	text: string
	displayName?: string
	subject?: string
	/** SDK task id that owned the CEO session when this steer was sent. */
	taskId?: string
}

const MAX_RECORDS = 200
const records: CeoDirectMessageRecord[] = []

function fuzzyAgentId(a?: string | null, b?: string | null): boolean {
	const left = (a || "").trim().toLowerCase()
	const right = (b || "").trim().toLowerCase()
	if (!left || !right) {
		return false
	}
	if (left === right) {
		return true
	}
	return left.startsWith(`${right}-`) || right.startsWith(`${left}-`)
}

export function recordCeoDirectMessage(record: CeoDirectMessageRecord): void {
	records.push(record)
	if (records.length > MAX_RECORDS) {
		records.splice(0, records.length - MAX_RECORDS)
	}
}

export function listCeoDirectMessages(): readonly CeoDirectMessageRecord[] {
	return records
}

export function clearCeoDirectMessages(): void {
	records.length = 0
}

/** Wall-clock leftovers sort after every MessageIdMinter id — remap them into minter space. */
function isWallClockTs(ts: number): boolean {
	return ts >= 1_000_000_000_000
}

function maxMinterTs(messages: ClineMessage[]): number {
	let maxTs = 0
	for (const message of messages) {
		const ts = message.ts ?? 0
		if (!isWallClockTs(ts) && ts > maxTs) {
			maxTs = ts
		}
	}
	return maxTs
}

function earliestAgentMinterTs(messages: ClineMessage[], agentId: string): number | undefined {
	let earliest: number | undefined
	for (const message of messages) {
		const ts = message.ts ?? 0
		if (isWallClockTs(ts)) {
			continue
		}
		if (!fuzzyAgentId(message.agentId ?? (message as { agent_id?: string }).agent_id, agentId)) {
			continue
		}
		if (earliest === undefined || ts < earliest) {
			earliest = ts
		}
	}
	return earliest
}

function allocateWallClockRemapTs(agentId: string, messages: ClineMessage[], usedTs: Set<number>): number {
	const earliest = earliestAgentMinterTs(messages, agentId)
	let candidate = earliest !== undefined ? earliest - 1 : maxMinterTs(messages) + 1
	while (candidate > 0 && usedTs.has(candidate)) {
		candidate -= 1
	}
	if (candidate <= 0 || usedTs.has(candidate)) {
		candidate = maxMinterTs(messages) + 1
		while (usedTs.has(candidate)) {
			candidate += 1
		}
	}
	return candidate
}

/**
 * Re-inject CEO 1:1 bubbles that SDK session rebuilds wipe from MessageStateHandler.
 * Only records for `taskId` are merged so a new blank session cannot inherit the
 * previous tab's steers. Stable-sort by ts so CEO steers stay before agent replies.
 */
export function mergeCeoDirectMessagesIntoTranscript(messages: ClineMessage[], taskId?: string | null): ClineMessage[] {
	const scoped = taskId
		? records.filter((record) => record.taskId === taskId)
		: // No active task (new blank tab): never reinject prior-session steers.
			[]

	// Fix CEO bubbles already in the transcript that still carry Date.now() ids.
	const normalized = normalizeWallClockCeoMessages(messages)

	if (scoped.length === 0) {
		return taskId ? stableSortByTs(normalized) : normalized
	}

	const usedTs = new Set(normalized.map((message) => message.ts).filter((ts): ts is number => typeof ts === "number"))
	const extras: ClineMessage[] = []
	for (const record of scoped) {
		const already = normalized.some(
			(message) =>
				message.say === "user_feedback" &&
				message.text === record.text &&
				fuzzyAgentId(message.agentId ?? (message as { agent_id?: string }).agent_id, record.agentId),
		)
		if (already) {
			continue
		}
		// Prefer the recorded minter id; remap legacy Date.now() steers so they sort
		// *before* that agent's existing rows (CEO → reply), not after every minter id.
		const ts = isWallClockTs(record.ts) ? allocateWallClockRemapTs(record.agentId, normalized, usedTs) : record.ts
		usedTs.add(ts)
		extras.push({
			ts,
			type: "say",
			say: "user_feedback",
			text: record.text,
			partial: false,
			agentId: record.agentId,
			agentDisplayName: record.displayName,
			agentRole: "teammate",
		})
	}

	if (extras.length === 0) {
		return stableSortByTs(normalized)
	}
	return stableSortByTs([...normalized, ...extras])
}

/** Rewrite in-transcript CEO steers that still use Date.now() so sort order is CEO → agent. */
function normalizeWallClockCeoMessages(messages: ClineMessage[]): ClineMessage[] {
	const usedTs = new Set<number>()
	for (const message of messages) {
		if (typeof message.ts === "number" && !isWallClockCeoFeedback(message)) {
			usedTs.add(message.ts)
		}
	}
	let changed = false
	const next = messages.map((message) => {
		if (!isWallClockCeoFeedback(message)) {
			return message
		}
		const agentId = message.agentId ?? (message as { agent_id?: string }).agent_id ?? ""
		const ts = allocateWallClockRemapTs(agentId, messages, usedTs)
		usedTs.add(ts)
		changed = true
		return { ...message, ts }
	})
	return changed ? next : messages
}

function isWallClockCeoFeedback(message: ClineMessage): boolean {
	return message.say === "user_feedback" && typeof message.ts === "number" && isWallClockTs(message.ts)
}

function stableSortByTs(messages: ClineMessage[]): ClineMessage[] {
	return messages
		.map((message, index) => ({ message, index }))
		.sort((a, b) => a.message.ts - b.message.ts || a.index - b.index)
		.map(({ message }) => message)
}
