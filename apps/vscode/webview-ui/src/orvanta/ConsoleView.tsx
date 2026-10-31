import type { OrvantaRosterAgent } from "@shared/proto/cline/orvanta"
import { IconArrowLeft } from "@tabler/icons-react"
import React, { useCallback, useContext, useEffect, useMemo } from "react"
import { AgentBadge } from "@/components/common/AgentBadge"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { ApprovalNeededToast } from "./ApprovalNeededToast"
import { TeamFeedView } from "./TeamFeedView"
import { TeamSidebar } from "./TeamSidebar"
import { ChromeTabBar } from "./tabs/ChromeTabBar"
import { ConsoleHistoryDrawer } from "./tabs/ConsoleHistoryDrawer"
import { getTabActiveTaskId } from "./tabs/types"
import { useChatTabs } from "./tabs/useChatTabs"

export interface ConsoleViewProps {
	agents: OrvantaRosterAgent[]
	focusAgentId: string
	onSelectAgent: (agentId: string) => void
	onHire?: () => void
	lockDeniedAgentIds?: string[]
	companyName?: string
	children: React.ReactNode
}

export function ConsoleView({
	agents,
	focusAgentId,
	onSelectAgent,
	onHire = () => {},
	lockDeniedAgentIds = [],
	companyName,
	children,
}: ConsoleViewProps) {
	const extensionState = useContext(ExtensionStateContext)
	const currentTaskItem = extensionState?.currentTaskItem

	const {
		tabs,
		activeTab,
		activeTabId,
		isHistoryOpen,
		selectTab,
		createNewTab,
		closeTab,
		openTaskInTab,
		openSessionInTab,
		bindTaskToActiveAgent,
		switchAgentInActiveTab,
		handleTaskDeleted,
		toggleHistory,
	} = useChatTabs({
		initialFocusAgentId: focusAgentId,
		onActiveAgentChange: onSelectAgent,
	})

	// Synchronize backend currentTaskItem with the active agent in the active tab.
	// Pass HistoryItem.sessionId (CEO session) separately from the SDK task id.
	// History browse: bindTaskToActiveAgent refuses to overwrite distinct agent→task bindings.
	useEffect(() => {
		if (currentTaskItem?.id && activeTab) {
			const taskId = currentTaskItem.id
			const ceoSessionId = currentTaskItem.sessionId
			const blankTab = !getTabActiveTaskId(activeTab) && !activeTab.sessionId
			// After [+], clearTask may still leave the previous tab's task loaded briefly.
			// Never stamp that onto a brand-new empty tab — that clones the open history.
			const ownedByOtherTab = tabs.some(
				(t) =>
					t.id !== activeTab.id &&
					(t.taskId === taskId ||
						Object.values(t.agentTasks || {}).includes(taskId) ||
						(!!ceoSessionId && t.sessionId === ceoSessionId)),
			)
			if (blankTab && ownedByOtherTab) {
				return
			}
			const currentAgentTask = activeTab.agentTasks?.[activeTab.activeAgentId]
			const needsTaskBind = !currentAgentTask || currentAgentTask !== taskId
			const needsSessionBind = !!ceoSessionId && activeTab.sessionId !== ceoSessionId
			if (needsTaskBind || needsSessionBind) {
				bindTaskToActiveAgent(taskId, currentTaskItem.task, ceoSessionId)
			}
		}
	}, [currentTaskItem, activeTab, tabs, bindTaskToActiveAgent])

	const chatChildren = useMemo(
		() =>
			React.Children.map(children, (child) => {
				if (!React.isValidElement(child)) return child
				return React.cloneElement(child as React.ReactElement<{ historyBrowse?: boolean }>, {
					historyBrowse: Boolean(activeTab?.historyBrowse),
				})
			}),
		[children, activeTab?.historyBrowse],
	)

	const handleSelectAgent = useCallback(
		(agentId: string) => {
			// Focus-only via switchAgentInActiveTab (onActiveAgentChange → onSelectAgent).
			// Must not clearTask / showTaskWithId — that aborts the whole CEO team runtime.
			switchAgentInActiveTab(agentId)
		},
		[switchAgentInActiveTab],
	)

	const isTeamFeed = focusAgentId === "team-feed"

	const focusedAgent = useMemo(() => {
		if (isTeamFeed) return undefined
		return (agents ?? []).find((a) => a.id === focusAgentId)
	}, [agents, focusAgentId, isTeamFeed])

	return (
		<div className="flex flex-col flex-1 h-full min-h-0 w-full overflow-hidden" data-testid="console-view">
			{/* Chrome Tab Bar bao trùm toàn bộ ConsoleView Root */}
			<ChromeTabBar
				activeTabId={activeTabId}
				isHistoryOpen={isHistoryOpen}
				onCloseTab={closeTab}
				onNewTab={() => createNewTab(focusAgentId)}
				onSelectTab={selectTab}
				onToggleHistory={toggleHistory}
				tabs={tabs}
			/>

			{/* Main Workspace Area: Sidebar on left + Content on right */}
			<div className="flex flex-1 min-h-0 w-full overflow-hidden relative">
				<ApprovalNeededToast agents={agents ?? []} focusAgentId={focusAgentId} onSelectAgent={handleSelectAgent} />
				{/* Left Collapsible Channels Sidebar */}
				<TeamSidebar
					agents={agents}
					focusAgentId={focusAgentId}
					lockDeniedAgentIds={lockDeniedAgentIds}
					onHire={onHire}
					onOpenWarRoom={() => handleSelectAgent("team-feed")}
					onSelectAgent={handleSelectAgent}
				/>

				{/* Right Content Area: Simple, standard flex column filling full height */}
				<div className="flex flex-1 min-w-0 min-h-0 flex-col overflow-hidden">
					{/* 1. When #team-feed is active */}
					{isTeamFeed && (
						<div className="flex flex-1 min-h-0 w-full overflow-hidden flex-col">
							<TeamFeedView
								ceoSessionId={activeTab?.sessionId}
								companyName={companyName}
								onSelectAgent={(agentId) => void handleSelectAgent(agentId)}
							/>
						</div>
					)}

					{/* 2. When an @agent channel is active: show ChatView with Agent Channel Header */}
					<div
						className="flex-col flex-1 min-h-0 w-full overflow-hidden"
						style={{ display: isTeamFeed ? "none" : "flex" }}>
						{focusedAgent && (
							<div
								className="shrink-0 h-[36px] min-h-[36px] border-b border-border-panel bg-(--vscode-sideBar-background) px-3 flex items-center justify-between select-none z-10 gap-2 overflow-hidden text-xs"
								data-testid="agent-channel-header">
								{/* Left side: Back to #team-feed + Agent Identity */}
								<div className="flex items-center gap-1.5 min-w-0 flex-1 overflow-hidden">
									<button
										className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground hover:text-foreground p-1 rounded hover:bg-surface-secondary cursor-pointer transition-colors whitespace-nowrap"
										onClick={() => void handleSelectAgent("team-feed")}
										title="Quay lại #team-feed"
										type="button">
										<IconArrowLeft className="shrink-0" size={14} stroke={1.5} />
										<span className="font-mono text-[11px] whitespace-nowrap">#team-feed</span>
									</button>
									<div className="h-3 w-[1px] bg-border-panel shrink-0" />
									<div className="flex items-center gap-1 min-w-0 overflow-hidden">
										<AgentBadge
											agentId={focusedAgent.id}
											className="shrink min-w-0"
											displayName={focusedAgent.displayName}
											role={focusedAgent.role}
											size="sm"
										/>
										<span className="text-[11px] text-muted-foreground truncate font-mono hidden md:inline shrink-0">
											@{focusedAgent.id}
										</span>
									</div>
								</div>

								{/* Right side: Status + 1:1 attribution */}
								<div className="flex items-center gap-1.5 shrink-0 text-[11px] text-muted-foreground ml-auto">
									<span className="flex items-center gap-1 shrink-0">
										<span
											className={`h-1.5 w-1.5 rounded-full ${
												focusedAgent.status === "running"
													? "bg-violet-400 animate-pulse"
													: "bg-emerald-400"
											}`}
										/>
										<span className="capitalize">{focusedAgent.status}</span>
									</span>
									<span className="opacity-40 shrink-0">·</span>
									<span
										className="italic opacity-80 whitespace-nowrap truncate max-w-[130px]"
										title="Chỉ đạo 1:1 qua Mailbox">
										Chỉ đạo 1:1 qua Mailbox
									</span>
								</div>
							</div>
						)}
						<div className="flex flex-col flex-1 min-h-0 w-full overflow-hidden relative">{chatChildren}</div>
					</div>
				</div>

				{/* History Drawer Overlay */}
				<ConsoleHistoryDrawer
					companyAgents={agents}
					currentTaskId={activeTab?.taskId}
					isOpen={isHistoryOpen}
					onClose={() => toggleHistory(false)}
					onDeleteTask={(taskId) => {
						void handleTaskDeleted(taskId)
					}}
					onSelectCeoSession={(session) => {
						// CEO manifests often list only the Coordinator participant, but the
						// shared transcript holds every Agent's work. Bind the whole roster to
						// that shared taskId so channel switches keep Agent history visible.
						const sharedTaskId =
							session.participants.find((p) => p.agentSlug === "coordinator")?.taskId ||
							session.participants.find((p) => p.taskId || p.sdkSessionId)?.taskId ||
							session.participants.find((p) => p.sdkSessionId)?.sdkSessionId ||
							""
						const participants = session.participants.map((p) => ({
							agentSlug: p.agentSlug,
							taskId: p.taskId || p.sdkSessionId || sharedTaskId || undefined,
							agentNumericId: Number(p.agentNumericId) || undefined,
						}))
						if (sharedTaskId) {
							for (const agent of agents) {
								if (!participants.some((p) => p.agentSlug === agent.id)) {
									participants.push({
										agentSlug: agent.id,
										taskId: sharedTaskId,
										agentNumericId:
											Number((agent as { agentNumericId?: number }).agentNumericId) || undefined,
									})
								}
							}
						}
						void openSessionInTab(session.sessionId, session.title, participants)
						toggleHistory(false)
					}}
					onSelectTask={(taskId, title, agentId, sessionAgentTasks) => {
						void openTaskInTab(taskId, title, agentId, sessionAgentTasks)
					}}
				/>
			</div>
		</div>
	)
}

export default ConsoleView
