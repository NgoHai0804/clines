import { type Icon, IconHome, IconInbox, IconTerminal2, IconUsers } from "@tabler/icons-react"
import { useState } from "react"
import AgentsView from "./AgentsView"
import HomeView from "./HomeView"
import InboxView from "./InboxView"
import { useOrvantaCompany } from "./useOrvantaCompany"
import { useOrvantaInbox } from "./useOrvantaInbox"

export type OrvantaTab = "home" | "agents" | "inbox" | "console"

type OrvantaShellProps = {
	activeTab: OrvantaTab | "chat" | "war-room"
	onTabChange: (tab: OrvantaTab) => void
	inboxFocusId?: string
}

const OrvantaShell = ({ activeTab: rawActiveTab, onTabChange, inboxFocusId: propInboxFocusId }: OrvantaShellProps) => {
	// Normalize legacy tab names if any caller passes "chat" or "war-room"
	const activeTab: OrvantaTab =
		rawActiveTab === "chat" || rawActiveTab === "war-room" ? "console" : (rawActiveTab as OrvantaTab)

	const { company, agentProfiles, loading, creating, createError, createCompany, saveAgentProfile, deleteAgentProfile } =
		useOrvantaCompany()

	const {
		pending,
		deferred,
		history,
		pendingCount,
		loading: inboxLoading,
		error: inboxError,
		resolveDecision,
		requestDecision,
		refresh: refreshInbox,
	} = useOrvantaInbox(company?.status)

	const isCompanyReady = company?.status === "ready"

	const [localInboxFocusId, setLocalInboxFocusId] = useState<string | undefined>()
	const effectiveInboxFocusId = propInboxFocusId || localInboxFocusId

	const tabs: Array<{
		id: OrvantaTab
		label: string
		icon: Icon
		enabled: boolean
		title?: string
		badge?: number
	}> = [
		{ id: "home", label: "Home", icon: IconHome, enabled: true },
		{
			id: "agents",
			label: "Agents",
			icon: IconUsers,
			enabled: isCompanyReady,
			title: isCompanyReady ? "Sơ đồ tổ chức & quản lý Agents" : "Lập công ty để mở Agents",
		},
		{
			id: "inbox",
			label: "Inbox",
			icon: IconInbox,
			enabled: isCompanyReady,
			title: isCompanyReady ? "Hộp thư quyết định của CEO" : "Lập công ty trên Home để mở Inbox",
			badge: pendingCount,
		},
		{
			id: "console",
			label: "Console",
			icon: IconTerminal2,
			enabled: true,
			title: "Trung tâm tác chiến đa kênh (Console)",
		},
	]

	const isFullView = activeTab === "home" || activeTab === "agents" || activeTab === "inbox"

	return (
		<div className={isFullView ? "flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden" : "shrink-0"}>
			<nav
				aria-label="Điều hướng chính"
				className="flex shrink-0 items-center gap-1 border-b border-border-panel bg-(--vscode-sideBar-background) px-2 py-1">
				{tabs.map((tab) => {
					const TabIcon = tab.icon
					const isSelected = activeTab === tab.id
					return (
						<button
							aria-current={isSelected ? "page" : undefined}
							aria-label={
								tab.id === "inbox" && tab.badge && tab.badge > 0 ? `Inbox, ${tab.badge} pending` : tab.label
							}
							className={`rounded-md px-2.5 py-1 text-xs flex items-center gap-1.5 font-medium transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
								isSelected
									? "bg-(--vscode-button-background) text-(--vscode-button-foreground) shadow-xs"
									: "text-muted-foreground hover:text-foreground hover:bg-(--vscode-list-hoverBackground)"
							} disabled:cursor-not-allowed disabled:opacity-40`}
							disabled={!tab.enabled}
							key={tab.id}
							onClick={() => {
								if (tab.id === "inbox") {
									setLocalInboxFocusId(undefined)
								}
								onTabChange(tab.id)
							}}
							title={tab.title}
							type="button">
							<TabIcon aria-hidden="true" className="shrink-0" size={13} stroke={1.5} />
							<span>{tab.label}</span>
							{tab.badge !== undefined && tab.badge > 0 && (
								<span className="rounded-full bg-(--vscode-badge-background) px-1.5 py-0.2 text-[10px] text-(--vscode-badge-foreground) font-semibold">
									{tab.badge > 99 ? "99+" : tab.badge}
								</span>
							)}
						</button>
					)
				})}
			</nav>
			{isFullView && (
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
					{activeTab === "home" && (
						<HomeView
							agentProfiles={agentProfiles}
							company={company}
							createError={createError}
							creating={creating}
							inboxPending={pending}
							loading={loading}
							onCreate={createCompany}
							onDeleteAgentProfile={deleteAgentProfile}
							onOpenInbox={(focusId) => {
								setLocalInboxFocusId(focusId)
								onTabChange("inbox")
							}}
							onRequestDecision={requestDecision}
							onSaveAgentProfile={saveAgentProfile}
							onTabChange={onTabChange}
						/>
					)}
					{activeTab === "agents" && (
						<AgentsView
							company={company}
							onDeleteAgentProfile={deleteAgentProfile}
							onSaveAgentProfile={saveAgentProfile}
							profiles={agentProfiles}
						/>
					)}
					{activeTab === "inbox" && (
						<InboxView
							deferred={deferred}
							error={inboxError}
							focusId={effectiveInboxFocusId}
							history={history}
							loading={inboxLoading}
							onRefresh={refreshInbox}
							onResolve={resolveDecision}
							pending={pending}
						/>
					)}
				</div>
			)}
		</div>
	)
}

export default OrvantaShell
