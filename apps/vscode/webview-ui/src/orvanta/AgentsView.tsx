import { OrvantaAgentProfile, type OrvantaCompanyResponse, type OrvantaRosterAgent } from "@shared/proto/cline/orvanta"
import { IconUsers } from "@tabler/icons-react"
import {
	type KeyboardEvent,
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react"
import { AgentEditor } from "./AgentEditor"
import { AgentTreeChart } from "./AgentTreeChart"
import { buildAgentTree } from "./tree-utils"

export const AGENTS_SPLIT_MIN_TREE = 180
export const AGENTS_SPLIT_MIN_EDITOR = 220
export const AGENTS_SPLIT_DIVIDER = 12
export const AGENTS_SPLIT_DEFAULT_RATIO = 0.42
export const AGENTS_SPLIT_STORAGE_KEY = "orvanta_agents_split_tree_height"

export function clampAgentsSplitTreeHeight(treeHeight: number, containerHeight: number): number {
	if (!Number.isFinite(treeHeight)) {
		return AGENTS_SPLIT_MIN_TREE
	}
	if (!Number.isFinite(containerHeight) || containerHeight <= 0) {
		return Math.max(AGENTS_SPLIT_MIN_TREE, treeHeight)
	}
	const available = Math.max(0, containerHeight - AGENTS_SPLIT_DIVIDER)
	if (available <= AGENTS_SPLIT_MIN_TREE + AGENTS_SPLIT_MIN_EDITOR) {
		const reservedEditor = Math.min(AGENTS_SPLIT_MIN_EDITOR, Math.floor(available / 2))
		const maxTree = Math.max(0, available - reservedEditor)
		return Math.max(0, Math.min(maxTree, treeHeight))
	}
	const maxTree = available - AGENTS_SPLIT_MIN_EDITOR
	return Math.max(AGENTS_SPLIT_MIN_TREE, Math.min(maxTree, treeHeight))
}

export function defaultAgentsSplitTreeHeight(containerHeight: number): number {
	if (containerHeight <= 0) {
		return AGENTS_SPLIT_MIN_TREE
	}
	return clampAgentsSplitTreeHeight(Math.round(containerHeight * AGENTS_SPLIT_DEFAULT_RATIO), containerHeight)
}

function readStoredTreeHeight(): number | null {
	try {
		const raw = localStorage.getItem(AGENTS_SPLIT_STORAGE_KEY)
		if (!raw) return null
		const parsed = Number.parseInt(raw, 10)
		return Number.isFinite(parsed) ? parsed : null
	} catch {
		return null
	}
}

export type AgentsViewProps = {
	company?: OrvantaCompanyResponse | null
	profiles?: Record<string, OrvantaAgentProfile>
	onSaveAgentProfile?: (profile: OrvantaAgentProfile) => Promise<boolean>
	onDeleteAgentProfile?: (agentId: string) => Promise<boolean>
	onChatWithAgent?: (agentId: string) => void
	onOpenWarRoom?: () => void
}

export function createTemplateProfile(templateKey: string, parentId: string, existingIds: string[]): OrvantaAgentProfile {
	const baseId = templateKey === "blank" ? "new-agent" : templateKey
	let targetId = baseId
	let counter = 1
	while (existingIds.includes(targetId)) {
		targetId = `${baseId}-${counter++}`
	}

	const templates: Record<string, Partial<OrvantaAgentProfile>> = {
		implementer: {
			displayName: "Code Implementer",
			role: "teammate",
			description: "Hiện thực hóa mã nguồn, giải quyết tính năng và sửa lỗi",
			instructions:
				"## Trách nhiệm chính\n- Viết mã nguồn chất lượng cao theo đặc tả\n- Tuân thủ coding guidelines và conventions",
			tools: {
				allow: [
					"read_files",
					"edit_file",
					"new_file",
					"list_files",
					"team_send_message",
					"team_read_mailbox",
					"orvanta_submit_handoff",
				],
				deny: [],
			},
		},
		reviewer: {
			displayName: "Code Reviewer",
			role: "teammate",
			description: "Đánh giá chất lượng mã nguồn, phát hiện bug, bảo mật và logic",
			instructions:
				"## Trách nhiệm chính\n- Rà soát mã nguồn kỹ lưỡng trước khi merge\n- Đảm bảo tuân thủ tiêu chuẩn chất lượng",
			tools: {
				allow: [
					"read_files",
					"search_files",
					"list_files",
					"team_send_message",
					"team_read_mailbox",
					"orvanta_submit_handoff",
				],
				deny: ["edit_file", "new_file"],
			},
		},
		researcher: {
			displayName: "Tech Researcher",
			role: "teammate",
			description: "Tìm kiếm thông tin, giải pháp kỹ thuật, nghiên cứu tài liệu",
			instructions: "## Trách nhiệm chính\n- Khảo sát tài liệu kỹ thuật\n- Đánh giá các thư viện và giải pháp kiến trúc",
			tools: {
				allow: [
					"read_files",
					"fetch_web_content",
					"fetch_web_search",
					"team_send_message",
					"team_read_mailbox",
					"orvanta_submit_handoff",
				],
				deny: ["edit_file", "new_file"],
			},
		},
		skeptic: {
			displayName: "Critical Skeptic",
			role: "teammate",
			description: "Phản biện kiến trúc, phát hiện edge cases và rủi ro tiềm ẩn",
			instructions:
				"## Trách nhiệm chính\n- Đặt câu hỏi phản biện về thiết kế hệ thống\n- Tìm kiếm các điểm nghẽn và rủi ro",
			tools: {
				allow: [
					"read_files",
					"search_files",
					"search_codebase",
					"team_send_message",
					"team_read_mailbox",
					"orvanta_submit_handoff",
				],
				deny: ["edit_file", "new_file"],
			},
		},
		blank: {
			displayName: "New Agent",
			role: "teammate",
			description: "Mô tả nhiệm vụ agent mới",
			instructions: "## Hướng dẫn hoạt động\n- Nhập hướng dẫn cho agent tại đây",
			tools: {
				allow: [
					"read_files",
					"edit_file",
					"new_file",
					"team_send_message",
					"team_read_mailbox",
					"orvanta_submit_handoff",
				],
				deny: [],
			},
		},
	}

	const t = templates[templateKey] || templates.blank

	return OrvantaAgentProfile.create({
		id: targetId,
		displayName: t.displayName || targetId,
		role: t.role || "teammate",
		description: t.description || "",
		instructions: t.instructions || "",
		reportsTo: parentId || "coordinator",
		tools: t.tools || { allow: ["read_files"], deny: [] },
		scopePaths: {
			allow: ["**/*"],
			denyWrite: [],
		},
	})
}

const AgentsView = ({
	company,
	profiles,
	onSaveAgentProfile,
	onDeleteAgentProfile,
	onChatWithAgent,
	onOpenWarRoom,
}: AgentsViewProps) => {
	const rosterAgents = useMemo<OrvantaRosterAgent[]>(() => {
		if (!company) return []
		const anyCompany = company as any
		return anyCompany.company?.roster?.agents || company.agents || []
	}, [company])

	const profilesMap = useMemo<Record<string, OrvantaAgentProfile>>(() => {
		if (profiles) return profiles
		return (company as any)?.profiles || {}
	}, [company, profiles])

	const tree = useMemo(() => {
		return buildAgentTree(rosterAgents, profilesMap)
	}, [rosterAgents, profilesMap])

	const [selectedAgentId, setSelectedAgentId] = useState<string>("coordinator")
	const [newProfileDraft, setNewProfileDraft] = useState<OrvantaAgentProfile | null>(null)
	const containerRef = useRef<HTMLDivElement>(null)
	const [treeHeight, setTreeHeight] = useState(() => readStoredTreeHeight() ?? AGENTS_SPLIT_MIN_TREE)
	const [isDragging, setIsDragging] = useState(false)
	const dragRef = useRef({ active: false, startY: 0, startHeight: 0 })

	useLayoutEffect(() => {
		const el = containerRef.current
		if (!el) return

		setTreeHeight(
			clampAgentsSplitTreeHeight(readStoredTreeHeight() ?? defaultAgentsSplitTreeHeight(el.clientHeight), el.clientHeight),
		)

		if (typeof ResizeObserver === "undefined") return
		const observer = new ResizeObserver(() => {
			if (dragRef.current.active) return
			setTreeHeight((current) => clampAgentsSplitTreeHeight(current, el.clientHeight))
		})
		observer.observe(el)
		return () => observer.disconnect()
	}, [])

	const persistTreeHeight = useCallback((height: number) => {
		try {
			localStorage.setItem(AGENTS_SPLIT_STORAGE_KEY, String(height))
		} catch {
			// Ignore quota / private-mode failures.
		}
	}, [])

	const onDividerMouseDown = useCallback(
		(event: ReactMouseEvent) => {
			if (event.button !== 0) return
			event.preventDefault()
			dragRef.current = { active: true, startY: event.clientY, startHeight: treeHeight }
			setIsDragging(true)
			document.body.style.cursor = "row-resize"
			document.body.style.userSelect = "none"

			const onMouseMove = (moveEvent: MouseEvent) => {
				if (!dragRef.current.active) return
				const delta = moveEvent.clientY - dragRef.current.startY
				const containerHeight = containerRef.current?.clientHeight ?? 0
				setTreeHeight(clampAgentsSplitTreeHeight(dragRef.current.startHeight + delta, containerHeight))
			}

			const onMouseUp = () => {
				dragRef.current.active = false
				setIsDragging(false)
				document.body.style.cursor = ""
				document.body.style.userSelect = ""
				window.removeEventListener("mousemove", onMouseMove)
				window.removeEventListener("mouseup", onMouseUp)
				setTreeHeight((current) => {
					persistTreeHeight(current)
					return current
				})
			}

			window.addEventListener("mousemove", onMouseMove)
			window.addEventListener("mouseup", onMouseUp)
		},
		[persistTreeHeight, treeHeight],
	)

	const onDividerKeyDown = useCallback(
		(event: KeyboardEvent) => {
			const step = event.shiftKey ? 40 : 16
			let next: number | undefined
			if (event.key === "ArrowUp") next = treeHeight - step
			else if (event.key === "ArrowDown") next = treeHeight + step
			else if (event.key === "Home") next = AGENTS_SPLIT_MIN_TREE
			else if (event.key === "End") next = Number.POSITIVE_INFINITY
			if (next === undefined) return
			event.preventDefault()
			const clamped = clampAgentsSplitTreeHeight(next, containerRef.current?.clientHeight ?? 0)
			setTreeHeight(clamped)
			persistTreeHeight(clamped)
		},
		[persistTreeHeight, treeHeight],
	)

	// Determine existing IDs
	const existingIds = useMemo(() => {
		const ids = new Set<string>(rosterAgents.map((a: OrvantaRosterAgent) => a.id))
		Object.keys(profilesMap).forEach((id) => ids.add(id))
		return Array.from(ids)
	}, [rosterAgents, profilesMap])

	// Determine active profile for editor
	const activeProfile = useMemo<OrvantaAgentProfile | null>(() => {
		if (newProfileDraft) {
			return newProfileDraft
		}

		if (profilesMap[selectedAgentId]) {
			return profilesMap[selectedAgentId]
		}

		const rosterAgent = rosterAgents.find((a: OrvantaRosterAgent) => a.id === selectedAgentId)
		if (rosterAgent) {
			return OrvantaAgentProfile.create({
				id: rosterAgent.id,
				displayName: rosterAgent.displayName || rosterAgent.id,
				role: rosterAgent.role || "teammate",
				description: "",
				instructions: `## ${rosterAgent.displayName || rosterAgent.id}\n- Hướng dẫn thực thi nhiệm vụ`,
				reportsTo: rosterAgent.reportsTo || (rosterAgent.id === "coordinator" ? undefined : "coordinator"),
			})
		}

		if (selectedAgentId === "coordinator") {
			return OrvantaAgentProfile.create({
				id: "coordinator",
				displayName: "Company Coordinator",
				role: "lead",
				description: "Điều phối viên công ty",
				instructions: "## Trách nhiệm Coordinator\n- Điều phối toàn bộ hoạt động",
			})
		}

		return null
	}, [newProfileDraft, selectedAgentId, profilesMap, rosterAgents])

	const isNew = Boolean(newProfileDraft)
	const isCoordinator = !isNew && activeProfile?.id === "coordinator"

	const handleSelectAgent = (agentId: string) => {
		setNewProfileDraft(null)
		setSelectedAgentId(agentId)
	}

	const handleAddAgent = (templateKey: string) => {
		const parentId = selectedAgentId || "coordinator"
		const draft = createTemplateProfile(templateKey, parentId, existingIds)
		setNewProfileDraft(draft)
	}

	const handleSave = async (profile: OrvantaAgentProfile): Promise<boolean> => {
		if (onSaveAgentProfile) {
			const success = await onSaveAgentProfile(profile)
			if (success) {
				setNewProfileDraft(null)
				setSelectedAgentId(profile.id)
			}
			return success
		}
		setNewProfileDraft(null)
		setSelectedAgentId(profile.id)
		return true
	}

	const handleDelete = async (agentId: string): Promise<boolean> => {
		if (onDeleteAgentProfile) {
			const success = await onDeleteAgentProfile(agentId)
			if (success) {
				setNewProfileDraft(null)
				setSelectedAgentId("coordinator")
			}
			return success
		}
		setNewProfileDraft(null)
		setSelectedAgentId("coordinator")
		return true
	}

	return (
		<div
			className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-(--vscode-editor-background) text-(--vscode-foreground)"
			data-testid="agents-view"
			ref={containerRef}>
			<div
				className="flex shrink-0 min-h-0 min-w-0 flex-col overflow-hidden border-b border-border-panel"
				data-testid="agents-tree-panel"
				style={{ height: treeHeight }}>
				<AgentTreeChart
					onAddAgent={handleAddAgent}
					onSelectAgent={handleSelectAgent}
					selectedAgentId={isNew ? null : selectedAgentId}
					tree={tree}
				/>
			</div>

			{/* biome-ignore lint/a11y/useSemanticElements: a separator role is the ARIA pattern for a resize splitter */}
			<div
				aria-label="Kéo để đổi kích thước sơ đồ và chi tiết agent"
				aria-orientation="horizontal"
				aria-valuemin={AGENTS_SPLIT_MIN_TREE}
				aria-valuenow={treeHeight}
				className={`group flex h-3 w-full shrink-0 cursor-row-resize items-center justify-center border-y border-border-panel/40 bg-slate-900 select-none touch-none ${
					isDragging ? "bg-indigo-950" : "hover:bg-indigo-950/40"
				}`}
				data-testid="split-divider"
				onKeyDown={onDividerKeyDown}
				onMouseDown={onDividerMouseDown}
				role="separator"
				tabIndex={0}>
				<div
					className={`h-1 w-12 rounded-full ${isDragging ? "bg-indigo-400" : "bg-slate-600 group-hover:bg-indigo-400"}`}
				/>
			</div>

			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden" data-testid="agents-detail-pane">
				{activeProfile ? (
					<AgentEditor
						allProfiles={profilesMap}
						existingIds={existingIds}
						initialProfile={activeProfile}
						isCoordinator={isCoordinator}
						isNew={isNew}
						// Remount when disk profile arrives (stub → real) so editor doesn't keep empty defaults.
						key={`${activeProfile.id}-${isNew ? "new" : "edit"}-${profilesMap[activeProfile.id] ? "disk" : "stub"}`}
						onChatWithAgent={onChatWithAgent}
						onClose={() => setNewProfileDraft(null)}
						onDelete={isNew ? undefined : handleDelete}
						onOpenWarRoom={onOpenWarRoom}
						onSave={handleSave}
						rosterAgents={rosterAgents}
					/>
				) : (
					<div className="flex h-full flex-col items-center justify-center text-slate-400 text-xs gap-2 p-6 text-center">
						<IconUsers className="text-slate-500" size={24} stroke={1.5} />
						<span>Chọn một agent trên sơ đồ cây để xem và chỉnh sửa chi tiết</span>
					</div>
				)}
			</div>
		</div>
	)
}

export default AgentsView
