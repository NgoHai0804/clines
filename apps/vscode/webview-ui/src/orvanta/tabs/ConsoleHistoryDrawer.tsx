import { StringArrayRequest } from "@shared/proto/cline/common"
import type { OrvantaCeoSessionIndexItem } from "@shared/proto/cline/orvanta"
import { IconClock, IconCoin, IconExternalLink, IconFolder, IconMessage, IconSearch, IconTrash, IconX } from "@tabler/icons-react"
import React, { useContext, useEffect, useMemo, useState } from "react"
import { ExtensionStateContext } from "@/context/ExtensionStateContext"
import { OrvantaServiceClient, TaskServiceClient } from "@/services/grpc-client"

export interface ConsoleHistoryDrawerProps {
	isOpen: boolean
	onClose: () => void
	onSelectTask: (taskId: string, title?: string, agentId?: string, sessionAgentTasks?: Record<string, string>) => void
	onSelectCeoSession?: (session: OrvantaCeoSessionIndexItem) => void
	onDeleteTask?: (taskId: string) => void
	currentTaskId?: string
	companyAgents?: Array<{ id: string; displayName?: string; role?: string }>
}

function formatTimestamp(ts: number): string {
	const d = new Date(ts)
	const now = new Date()
	const diffSec = Math.floor((now.getTime() - d.getTime()) / 1000)
	if (diffSec < 60) return "Vừa xong"
	if (diffSec < 3600) return `${Math.floor(diffSec / 60)} phút trước`
	if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} giờ trước`
	return d.toLocaleDateString("vi-VN", {
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	})
}

function sessionUpdatedTs(session: OrvantaCeoSessionIndexItem): number {
	const raw = session.updatedAt || session.createdAt
	const parsed = raw ? Date.parse(raw) : NaN
	return Number.isFinite(parsed) ? parsed : Date.now()
}

function sessionDeleteIds(session: OrvantaCeoSessionIndexItem): string[] {
	const taskIds = session.participants.map((p) => p.taskId?.trim()).filter((id): id is string => Boolean(id))
	return taskIds.length > 0 ? Array.from(new Set(taskIds)) : [session.sessionId]
}

export const ConsoleHistoryDrawer: React.FC<ConsoleHistoryDrawerProps> = ({
	isOpen,
	onClose,
	onSelectTask,
	onSelectCeoSession,
	onDeleteTask,
	currentTaskId,
	companyAgents: _companyAgents = [],
}) => {
	const extensionState = useContext(ExtensionStateContext)
	const taskHistory = extensionState?.taskHistory
	const [searchQuery, setSearchQuery] = useState("")
	const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
	const [deletedIds, setDeletedIds] = useState<Set<string>>(() => new Set())
	const [ceoSessions, setCeoSessions] = useState<OrvantaCeoSessionIndexItem[]>([])
	const [ceoListError, setCeoListError] = useState<string | undefined>()

	useEffect(() => {
		if (!isOpen) return
		let cancelled = false
		OrvantaServiceClient.listCeoSessions({})
			.then((resp) => {
				if (cancelled) return
				if (!resp.success) {
					setCeoListError(resp.error || resp.status || "Không đọc được index CEO session")
					setCeoSessions([])
					return
				}
				setCeoListError(undefined)
				setCeoSessions(resp.sessions ?? [])
			})
			.catch((error) => {
				if (cancelled) return
				setCeoListError(error instanceof Error ? error.message : String(error))
				setCeoSessions([])
			})
		return () => {
			cancelled = true
		}
	}, [isOpen])

	// Đóng drawer khi nhấn Escape
	React.useEffect(() => {
		if (!isOpen) return
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				onClose()
			}
		}
		window.addEventListener("keydown", handleKeyDown)
		return () => window.removeEventListener("keydown", handleKeyDown)
	}, [isOpen, onClose])

	const filteredSessions = useMemo(() => {
		const query = searchQuery.trim().toLowerCase()
		return ceoSessions
			.filter((session) => !deletedIds.has(session.sessionId))
			.filter((session) => {
				if (!query) return true
				return session.title.toLowerCase().includes(query) || session.sessionId.toLowerCase().includes(query)
			})
			.sort((a, b) => sessionUpdatedTs(b) - sessionUpdatedTs(a))
	}, [ceoSessions, searchQuery, deletedIds])

	const sessionTaskIds = useMemo(() => {
		const ids = new Set<string>()
		for (const session of ceoSessions) {
			for (const participant of session.participants) {
				if (participant.taskId) ids.add(participant.taskId)
			}
		}
		return ids
	}, [ceoSessions])

	const filteredTasks = useMemo(() => {
		// Session index is the source of truth. Only fall back to raw taskHistory when
		// there is no CEO session catalog (legacy / pre-index workspaces).
		if (ceoSessions.length > 0) {
			return []
		}
		const list = (taskHistory || []).filter(
			(item) => !item.isLegacy && !deletedIds.has(item.id) && !sessionTaskIds.has(item.id),
		)
		const query = searchQuery.trim().toLowerCase()
		if (!query) return list
		return list.filter((item) => {
			const textMatch = item.task?.toLowerCase().includes(query)
			const idMatch = item.id?.toLowerCase().includes(query)
			const sessionMatch = (item as { sessionId?: string }).sessionId?.toLowerCase().includes(query)
			return Boolean(textMatch || idMatch || sessionMatch)
		})
	}, [taskHistory, searchQuery, deletedIds, ceoSessions.length, sessionTaskIds])

	const refreshCeoSessions = async () => {
		try {
			const resp = await OrvantaServiceClient.listCeoSessions({})
			if (!resp.success) {
				setCeoListError(resp.error || resp.status || "Không đọc được index phiên")
				setCeoSessions([])
				return
			}
			setCeoListError(undefined)
			setCeoSessions(resp.sessions ?? [])
		} catch (error) {
			setCeoListError(error instanceof Error ? error.message : String(error))
			setCeoSessions([])
		}
	}

	const handleDelete = async (ids: string | string[], sessionId?: string) => {
		const value = Array.isArray(ids) ? ids : [ids]
		try {
			await TaskServiceClient.deleteTasksWithIds(StringArrayRequest.create({ value }))
			setDeletedIds((prev) => {
				const next = new Set(prev)
				for (const id of value) next.add(id)
				if (sessionId) next.add(sessionId)
				return next
			})
			setConfirmDeleteId(null)
			for (const id of value) onDeleteTask?.(id)
			await refreshCeoSessions()
		} catch (error) {
			console.error("Failed to delete session:", error)
			setConfirmDeleteId(null)
			window.alert(error instanceof Error ? error.message : "Không xóa được lịch sử trò chuyện.")
		}
	}

	if (!isOpen) return null

	return (
		<div
			aria-label="Lịch sử cuộc trò chuyện"
			aria-modal="true"
			className="fixed inset-y-0 right-0 z-50 w-full sm:w-[360px] max-w-full flex flex-col bg-[var(--vscode-sideBar-background)] border-l border-[var(--vscode-sideBar-border,rgba(255,255,255,0.08))] shadow-2xl animate-in slide-in-from-right duration-200"
			data-testid="console-history-drawer"
			role="dialog">
			{/* Drawer Header */}
			<div className="flex items-center justify-between p-3 border-b border-[var(--vscode-sideBar-border,rgba(255,255,255,0.08))] bg-[var(--vscode-sideBarSectionHeader-background,rgba(255,255,255,0.02))]">
				<div className="flex flex-col">
					<div className="flex items-center gap-1.5 font-medium text-xs text-[var(--vscode-foreground)]">
						<IconClock className="text-cyan-400" size={15} />
						<span>Lịch sử cuộc trò chuyện</span>
					</div>
					<div className="flex items-center gap-1 text-[10px] text-[var(--vscode-descriptionForeground)] mt-0.5">
						<IconFolder size={11} />
						<span>.orvanta/local/history</span>
					</div>
				</div>
				<button
					aria-label="Đóng lịch sử"
					className="p-1 rounded text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)] hover:bg-[var(--vscode-toolbar-hoverBackground)] transition-colors"
					onClick={onClose}
					type="button">
					<IconX size={16} />
				</button>
			</div>

			{/* Search Bar (No Filter Buttons) */}
			<div className="p-3 border-b border-[var(--vscode-sideBar-border,rgba(255,255,255,0.08))] flex flex-col gap-1.5">
				<div className="relative flex items-center">
					<IconSearch
						className="absolute left-2.5 text-[var(--vscode-input-placeholderForeground)] pointer-events-none"
						size={14}
					/>
					<input
						className="w-full h-8 pl-8 pr-7 text-xs rounded bg-[var(--vscode-input-background)] text-[var(--vscode-input-foreground)] border border-[var(--vscode-input-border,rgba(255,255,255,0.1))] focus:outline-none focus:border-[var(--vscode-focusBorder,#007fd4)]"
						onChange={(e) => setSearchQuery(e.target.value)}
						placeholder="Tìm kiếm yêu cầu, mã task, hoặc agent..."
						type="text"
						value={searchQuery}
					/>
					{searchQuery && (
						<button
							aria-label="Xóa từ khóa tìm kiếm"
							className="absolute right-2 text-xs text-[var(--vscode-descriptionForeground)] hover:text-[var(--vscode-foreground)]"
							onClick={() => setSearchQuery("")}
							type="button">
							×
						</button>
					)}
				</div>
				<div className="flex items-center justify-between text-[10px] text-[var(--vscode-descriptionForeground)] px-0.5">
					<span>{searchQuery ? `Kết quả cho "${searchQuery}"` : "Tất cả phiên làm việc"}</span>
					<span>{filteredSessions.length > 0 ? filteredSessions.length : filteredTasks.length} phiên</span>
				</div>
			</div>

			{/* Session-first history */}
			<div className="flex-1 overflow-y-auto p-2 space-y-1.5" data-testid="ceo-session-history-list">
				{ceoListError && (
					<div className="rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1.5 text-[10px] text-rose-300">
						{ceoListError}
					</div>
				)}

				{filteredSessions.map((session) => {
					const confirmKey = `session:${session.sessionId}`
					const isConfirmingDelete = confirmDeleteId === confirmKey
					const title = session.title?.trim() || "Phiên không tên"
					return (
						<div
							className="group p-2.5 rounded border text-left cursor-pointer transition-all duration-150 flex flex-col gap-1.5 border-[var(--vscode-sideBar-border,rgba(255,255,255,0.06))] bg-[var(--vscode-sideBarSectionHeader-background,rgba(255,255,255,0.01))] hover:border-[var(--vscode-focusBorder,#007fd4)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
							key={session.sessionId}
							onClick={() => {
								if (!isConfirmingDelete) onSelectCeoSession?.(session)
							}}>
							<div className="flex items-start justify-between gap-2">
								<div className="font-medium text-xs text-[var(--vscode-foreground)] line-clamp-2 leading-relaxed flex-1">
									{title}
								</div>
								<div className="flex items-center gap-0.5 shrink-0">
									<button
										aria-label="Xóa phiên"
										className="p-1 rounded hover:bg-rose-500 hover:text-white text-[var(--vscode-descriptionForeground)] transition-colors"
										onClick={(e) => {
											e.stopPropagation()
											setConfirmDeleteId(confirmKey)
										}}
										title="Xóa phiên"
										type="button">
										<IconTrash size={13} />
									</button>
								</div>
							</div>
							{isConfirmingDelete ? (
								<div
									className="mt-0.5 p-2 rounded bg-rose-500/10 border border-rose-500/30 flex items-center justify-between gap-2"
									onClick={(e) => e.stopPropagation()}>
									<span className="text-[11px] text-rose-400 font-medium">Xác nhận xóa?</span>
									<div className="flex items-center gap-1.5 shrink-0">
										<button
											className="px-2 py-0.5 text-[10px] rounded border border-[var(--vscode-input-border,rgba(255,255,255,0.1))] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
											onClick={() => setConfirmDeleteId(null)}
											type="button">
											Hủy
										</button>
										<button
											className="px-2 py-0.5 text-[10px] rounded bg-rose-600 text-white font-medium hover:bg-rose-700 transition-colors"
											onClick={() => void handleDelete(sessionDeleteIds(session), session.sessionId)}
											type="button">
											Xóa
										</button>
									</div>
								</div>
							) : (
								<div className="flex items-center gap-1 text-[10px] text-[var(--vscode-descriptionForeground)]">
									<IconClock size={11} />
									<span>{formatTimestamp(sessionUpdatedTs(session))}</span>
								</div>
							)}
						</div>
					)
				})}

				{filteredSessions.length === 0 &&
					filteredTasks.map((task) => {
						const isCurrent = task.id === currentTaskId
						const isConfirmingDelete = confirmDeleteId === task.id
						const totalTokens = (task.tokensIn || 0) + (task.tokensOut || 0)
						const displayTitle = task.task || "Phiên hội thoại không tên"
						return (
							<div
								className={`
									group p-2.5 rounded border text-left cursor-pointer transition-all duration-150 flex flex-col gap-1.5
									${
										isCurrent
											? "border-[var(--vscode-focusBorder,#007fd4)] bg-[var(--vscode-editor-background)]"
											: "border-[var(--vscode-sideBar-border,rgba(255,255,255,0.06))] bg-[var(--vscode-sideBarSectionHeader-background,rgba(255,255,255,0.01))] hover:border-[var(--vscode-focusBorder,#007fd4)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
									}
								`}
								key={task.id}
								onClick={() => {
									if (!isConfirmingDelete) {
										onSelectTask(task.id, displayTitle, "coordinator", task.agentTasks)
									}
								}}>
								<div className="flex items-start justify-between gap-2">
									<div className="font-medium text-xs text-[var(--vscode-foreground)] line-clamp-2 leading-relaxed flex-1">
										{displayTitle}
									</div>
									<div className="flex items-center gap-0.5 shrink-0">
										<button
											className="p-1 rounded hover:bg-[var(--vscode-button-background,#007fd4)] hover:text-white text-[var(--vscode-descriptionForeground)] transition-colors"
											onClick={(e) => {
												e.stopPropagation()
												onSelectTask(task.id, displayTitle, "coordinator", task.agentTasks)
											}}
											title="Mở phiên"
											type="button">
											<IconExternalLink size={13} />
										</button>
										<button
											aria-label="Xóa cuộc trò chuyện"
											className="p-1 rounded hover:bg-rose-500 hover:text-white text-[var(--vscode-descriptionForeground)] transition-colors"
											onClick={(e) => {
												e.stopPropagation()
												setConfirmDeleteId(task.id)
											}}
											title="Xóa phiên"
											type="button">
											<IconTrash size={13} />
										</button>
									</div>
								</div>
								{isConfirmingDelete ? (
									<div
										className="mt-0.5 p-2 rounded bg-rose-500/10 border border-rose-500/30 flex items-center justify-between gap-2"
										onClick={(e) => e.stopPropagation()}>
										<span className="text-[11px] text-rose-400 font-medium">Xác nhận xóa?</span>
										<div className="flex items-center gap-1.5 shrink-0">
											<button
												className="px-2 py-0.5 text-[10px] rounded border border-[var(--vscode-input-border,rgba(255,255,255,0.1))] text-[var(--vscode-descriptionForeground)] hover:bg-[var(--vscode-toolbar-hoverBackground)]"
												onClick={() => setConfirmDeleteId(null)}
												type="button">
												Hủy
											</button>
											<button
												className="px-2 py-0.5 text-[10px] rounded bg-rose-600 text-white font-medium hover:bg-rose-700 transition-colors"
												onClick={() => void handleDelete(task.id)}
												type="button">
												Xóa
											</button>
										</div>
									</div>
								) : (
									<div className="flex items-center justify-between text-[10px] text-[var(--vscode-descriptionForeground)] mt-0.5">
										<span className="flex items-center gap-1">
											<IconClock size={11} />
											{formatTimestamp(task.ts)}
										</span>
										<div className="flex items-center gap-2">
											{totalTokens > 0 && <span>{totalTokens.toLocaleString()} tokens</span>}
											{task.totalCost ? (
												<span className="flex items-center text-emerald-400">
													<IconCoin className="mr-0.5" size={10} />${task.totalCost.toFixed(3)}
												</span>
											) : null}
										</div>
									</div>
								)}
							</div>
						)
					})}

				{filteredSessions.length === 0 && filteredTasks.length === 0 && !ceoListError ? (
					<div className="flex flex-col items-center justify-center p-8 text-center text-xs text-[var(--vscode-descriptionForeground)]">
						<IconMessage className="opacity-30 mb-2" size={32} />
						<span>
							{searchQuery ? "Không tìm thấy phiên làm việc phù hợp" : "Chưa có phiên làm việc nào được lưu"}
						</span>
					</div>
				) : null}
			</div>
		</div>
	)
}
