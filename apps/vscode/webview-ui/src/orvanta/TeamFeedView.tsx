import { IconActivity, IconBroadcast, IconClock, IconCornerDownRight, IconHash, IconSparkles } from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { AgentBadge } from "@/components/common/AgentBadge"
import { cn } from "@/lib/utils"
import { getAgentRoleIconComponent } from "./TeamSidebar"
import { useWarRoom } from "./useWarRoom"

export interface TeamFeedViewProps {
	onSelectAgent: (agentId: string) => void
	companyName?: string
	/** CEO session id for durable runtime pause; omit for draft tabs. */
	ceoSessionId?: string
}

interface TimelineEntry {
	id: string
	time: string
	agentId: string
	agentDisplayName: string
	agentRole: string
	kind: string
	text: string
}

function formatElapsed(seconds: number): string {
	if (seconds < 60) return `${seconds}s`
	return `${Math.floor(seconds / 60)}m${(seconds % 60).toString().padStart(2, "0")}s`
}

export function TeamFeedView({ onSelectAgent, companyName, ceoSessionId }: TeamFeedViewProps) {
	const {
		snapshot,
		syncStatus,
		lastUpdatedAt,
		pauseStatus,
		needsAttention: needsAttentionRaw,
		canPauseRuntime,
		requestRuntimePause,
		requestRuntimeResume,
		pauseError,
	} = useWarRoom(true, ceoSessionId)
	const needsAttention = needsAttentionRaw ?? []
	const timelineScrollRef = useRef<HTMLDivElement>(null)

	const agents = useMemo(() => snapshot?.cards ?? [], [snapshot?.cards])
	const runningCount = useMemo(() => agents.filter((a) => a.status === "running").length, [agents])

	// Aggregate and sort timeline entries across all agent buffers
	const timelineEntries = useMemo(() => {
		const raw: TimelineEntry[] = []
		const now = new Date()
		const timeStr = `${now.getHours().toString().padStart(2, "0")}:${now.getMinutes().toString().padStart(2, "0")}:${now.getSeconds().toString().padStart(2, "0")}`

		for (const agent of agents) {
			if (!agent.buffer || agent.buffer.length === 0) continue
			for (let i = 0; i < agent.buffer.length; i++) {
				const line = agent.buffer[i]
				raw.push({
					id: `${agent.id}-${i}-${line.text.slice(0, 10)}`,
					time: timeStr,
					agentId: agent.id,
					agentDisplayName: agent.displayName || agent.id,
					agentRole: agent.role || "teammate",
					kind: line.kind,
					text: line.text,
				})
			}
		}

		// Merge consecutive entries of the same agent & same kind (e.g. streaming think/text)
		const merged: TimelineEntry[] = []
		for (const item of raw) {
			const prev = merged[merged.length - 1]
			if (
				prev &&
				prev.agentId === item.agentId &&
				prev.kind === item.kind &&
				(item.kind === "text" || item.kind === "think")
			) {
				prev.text = `${prev.text} ${item.text}`.trim()
			} else {
				merged.push({ ...item })
			}
		}

		return merged
	}, [agents])

	const [autoScroll, setAutoScroll] = useState(true)

	useEffect(() => {
		const el = timelineScrollRef.current
		if (!el || !autoScroll) return
		el.scrollTop = el.scrollHeight
	}, [timelineEntries.length, autoScroll])

	const onTimelineScroll = useCallback(() => {
		const el = timelineScrollRef.current
		if (!el) return
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
		// Scroll up only disables auto-scroll; events keep applying to snapshot.
		setAutoScroll(distanceFromBottom < 48)
	}, [])

	return (
		<div
			className="flex flex-1 min-h-0 h-full w-full flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-editor-foreground)"
			data-testid="team-feed-view">
			{/* Channel Header */}
			<div className="flex shrink-0 items-center justify-between border-b border-border-panel bg-(--vscode-sideBar-background)/50 px-4 py-2.5">
				<div className="flex items-center gap-2 min-w-0">
					<div className="flex h-6 w-6 items-center justify-center rounded-md bg-indigo-500/10 text-indigo-400">
						<IconHash size={16} stroke={2} />
					</div>
					<div className="flex flex-col min-w-0">
						<span className="font-semibold text-sm truncate flex items-center gap-2">
							team-feed
							{companyName && (
								<span className="text-[11px] font-normal text-muted-foreground">({companyName})</span>
							)}
						</span>
					</div>
				</div>
				<div className="flex items-center gap-2 shrink-0 text-xs">
					{(syncStatus === "stale" || syncStatus === "reconnecting") && (
						<span className="text-[10px] text-amber-300" data-testid="team-feed-sync-status">
							{syncStatus === "reconnecting" ? "Đang kết nối lại…" : "Stale"}
							{lastUpdatedAt ? ` · ${lastUpdatedAt}` : ""}
						</span>
					)}
					{needsAttention.length > 0 && (
						<span
							className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200"
							data-testid="team-feed-needs-attention"
							title={needsAttention.map((n) => `${n.agentId}: ${n.reason}`).join("\n")}>
							Needs attention ({needsAttention.length})
						</span>
					)}
					{canPauseRuntime &&
						(pauseStatus === "paused" || pauseStatus === "pause_requested" || pauseStatus === "partial") && (
							<button
								className="rounded border border-border-panel px-2 py-0.5 text-[11px] font-medium hover:bg-surface-secondary"
								data-testid="team-feed-runtime-resume"
								onClick={() => void requestRuntimeResume()}
								title="Resume runtime CEO session"
								type="button">
								Resume
							</button>
						)}
					{canPauseRuntime && (
						<button
							className="rounded border border-border-panel px-2 py-0.5 text-[11px] font-medium hover:bg-surface-secondary disabled:opacity-40"
							data-testid="team-feed-runtime-pause"
							disabled={pauseStatus === "paused" || pauseStatus === "pause_requested"}
							onClick={() => void requestRuntimePause()}
							title="Pause runtime toàn CEO session (durable)"
							type="button">
							{pauseStatus === "paused"
								? "Paused"
								: pauseStatus === "pause_requested"
									? "Pausing…"
									: pauseStatus === "partial"
										? "Pause partial"
										: "Pause"}
						</button>
					)}
					<span
						className={cn("flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium border", {
							"bg-violet-500/10 border-violet-500/30 text-violet-400": runningCount > 0,
							"bg-surface-secondary border-border-panel text-muted-foreground": runningCount === 0,
						})}>
						<span
							className={cn("h-1.5 w-1.5 rounded-full", {
								"bg-violet-400 animate-pulse": runningCount > 0,
								"bg-emerald-400": runningCount === 0,
							})}
						/>
						{runningCount > 0 ? `${runningCount} đang chạy` : "Toàn đội sẵn sàng"}
					</span>
				</div>
			</div>
			{pauseError && (
				<div className="shrink-0 border-b border-error/40 bg-error/10 px-4 py-1 text-[11px] text-error">{pauseError}</div>
			)}
			{/* Section 1: Compact War Room Grid (Header Strip) */}
			<div className="shrink-0 border-b border-border-panel bg-(--vscode-sideBar-background)/40 p-2.5 space-y-1.5">
				<div className="flex items-center justify-between text-xs font-semibold text-description uppercase tracking-wider">
					<span className="flex items-center gap-1.5 text-[11px]">
						<IconBroadcast className="text-indigo-400" size={14} stroke={1.5} />
						Mini War Room ({agents.length} nhân sự)
					</span>
					<span className="text-[10px] font-normal text-muted-foreground">Click thẻ để mở kênh riêng</span>
				</div>

				{agents.length === 0 ? (
					<div className="rounded-md border border-dashed border-border-panel p-2 text-center text-xs text-muted-foreground">
						Chưa có thông tin nhân sự. Các thẻ trạng thái sẽ xuất hiện khi session khởi động.
					</div>
				) : (
					<div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-1.5">
						{agents.map((agent) => {
							const isRunning = agent.status === "running"
							const AgentIcon = getAgentRoleIconComponent(agent.role, agent.id)

							return (
								<button
									className={cn(
										"flex flex-col text-left p-1.5 rounded-md border transition-all cursor-pointer bg-(--vscode-sideBar-background)",
										"hover:border-indigo-500/50 hover:shadow-xs",
										{
											"border-violet-500 ring-1 ring-violet-500/30 shadow-violet-500/5": isRunning,
											"border-border-panel": !isRunning,
										},
									)}
									data-testid={`feed-card-${agent.id}`}
									key={agent.id}
									onClick={() => onSelectAgent?.(agent.id)}
									type="button">
									<div className="flex items-center justify-between gap-1 w-full mb-0.5">
										<div className="flex items-center gap-1.5 min-w-0">
											<AgentIcon className="shrink-0 text-muted-foreground" size={13} stroke={1.5} />
											<span className="font-semibold text-[11px] truncate">
												{agent.displayName || agent.id}
											</span>
										</div>
										<span
											className={cn("h-1.5 w-1.5 shrink-0 rounded-full", {
												"bg-violet-400 animate-pulse": isRunning,
												"bg-emerald-400": agent.status === "idle",
												"bg-amber-400": agent.status === "failed",
												"bg-zinc-500": agent.status !== "running" && agent.status !== "idle",
											})}
										/>
									</div>

									<div className="text-[10px] text-muted-foreground/80 line-clamp-1">
										{agent.taskTitle ? agent.taskTitle : "Sẵn sàng"}
									</div>

									<div className="flex items-center justify-between text-[9px] text-muted-foreground/60 mt-0.5 pt-0.5 border-t border-border-panel/40">
										<span>@{agent.id}</span>
										{isRunning && agent.elapsedSeconds > 0 && (
											<span className="font-mono text-violet-400 flex items-center gap-0.5">
												<IconClock size={10} stroke={1.5} />
												{formatElapsed(agent.elapsedSeconds)}
											</span>
										)}
									</div>
								</button>
							)
						})}
					</div>
				)}
			</div>

			{/* Section 2: Global Activity Timeline (FULL CHIỀU CAO CÒN LẠI) */}
			<div className="flex-1 min-h-0 flex flex-col overflow-hidden bg-(--vscode-editor-background)">
				<div className="flex shrink-0 items-center justify-between px-3 py-1.5 border-b border-border-panel/40 bg-(--vscode-sideBar-background)/20 text-xs">
					<span className="flex items-center gap-1.5 text-description uppercase tracking-wider text-[11px] font-semibold">
						<IconActivity className="text-emerald-400" size={14} stroke={1.5} />
						Dòng Thời Gian Hoạt Động (Global Activity Timeline)
					</span>
					<span className="text-[10px] font-mono text-muted-foreground">{timelineEntries.length} sự kiện</span>
				</div>

				<div
					className="flex-1 min-h-0 scroller-y p-3 space-y-1.5 pb-6"
					data-testid="timeline-container"
					onScroll={onTimelineScroll}
					ref={timelineScrollRef}>
					{timelineEntries.length === 0 ? (
						<div className="h-full flex flex-col items-center justify-center py-12 text-center text-xs text-muted-foreground space-y-2">
							<IconSparkles className="text-muted-foreground/30 animate-pulse" size={24} stroke={1.5} />
							<div className="font-medium text-foreground/80">Kênh chung #team-feed đang chờ hoạt động.</div>
							<div className="text-[11px] opacity-70 max-w-sm">
								Các hoạt động của các agent (suy nghĩ, gọi công cụ, sửa code, chạy lệnh...) sẽ tự động hiển thị
								tại đây theo thời gian thực.
							</div>
						</div>
					) : (
						timelineEntries.map((entry, idx) => {
							const prev = idx > 0 ? timelineEntries[idx - 1] : undefined
							const isSameSpeaker = prev && prev.agentId === entry.agentId

							return (
								<div
									className={cn(
										"flex items-start gap-2 text-xs py-1 px-1.5 rounded hover:bg-(--vscode-list-hoverBackground) transition-colors",
										{
											"mt-1 pt-1.5 border-t border-border-panel/20": !isSameSpeaker && idx > 0,
										},
									)}
									key={entry.id}>
									<span className="font-mono text-[10px] text-muted-foreground/60 shrink-0 mt-0.5">
										[{entry.time}]
									</span>
									<div className="shrink-0 max-w-28 min-w-16">
										{!isSameSpeaker ? (
											<AgentBadge
												agentId={entry.agentId}
												displayName={entry.agentDisplayName}
												role={entry.agentRole}
												size="sm"
											/>
										) : (
											<div className="text-[10px] font-mono text-muted-foreground/40 pl-2">
												<IconCornerDownRight size={10} stroke={1.5} />
											</div>
										)}
									</div>
									<span
										className={cn("flex-1 wrap-break-word font-mono text-[11px] leading-relaxed", {
											"text-rose-400": entry.kind === "error",
											"text-amber-400": entry.kind === "deny",
											"text-violet-300": entry.kind === "tool_start",
											"text-emerald-300": entry.kind === "tool_result",
											"text-slate-400 italic": entry.kind === "think",
											"text-foreground/90": entry.kind === "text" || entry.kind === "progress",
										})}>
										{entry.text}
									</span>
								</div>
							)
						})
					)}
				</div>
			</div>
		</div>
	)
}

export default TeamFeedView
