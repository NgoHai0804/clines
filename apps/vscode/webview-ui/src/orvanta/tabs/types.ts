export interface ChatTab {
	/** Định danh duy nhất của tab trên Webview UI (uuid hoặc timestamp string) - UI-only ID */
	id: string

	/** Backend sessionId nếu tab đã gắn với session durable */
	sessionId?: string

	/** Tiêu đề hiển thị trên thanh tab */
	title: string

	/** Agent ID/slug đang phụ trách hoặc đang được focus trong phiên này */
	activeAgentId: string

	/** Agent numeric ID nếu đã resolve */
	activeAgentNumericId?: number

	/**
	 * BẢN ĐỒ AGENT TASK: Gắn kết từng Agent với Task ID tương ứng trong phiên này
	 * Nguồn sự thật duy nhất cho liên kết agent -> task trong phiên.
	 * Ví dụ: { "coordinator": "task-01", "implementer": "task-02" }
	 */
	agentTasks: Record<string, string>

	/** Bản đồ Agent Task theo số định danh bất biến (nếu có) */
	agentTasksByNumericId?: Record<number, string>

	/**
	 * BẢN ĐỒ DRAFT INPUT: Lưu nội dung đang gõ dở theo từng Agent để không bị mất khi chuyển đổi
	 * Lưu trữ client-side độc lập, không đưa vào session transcript.
	 */
	agentDrafts?: Record<string, string>

	/** Danh sách các Agent IDs tham gia trong phiên này */
	agentIds: string[]

	/** Thời điểm tạo tab (timestamp) */
	createdAt: number

	/** Thời điểm tương tác cuối cùng (timestamp) */
	lastActiveAt: number

	/** Trạng thái cờ đang chạy (running) hay chờ người dùng */
	isRunning?: boolean

	/**
	 * Tab đang xem lại lịch sử (mở từ History drawer / CEO session).
	 * Khi true: đổi Agent phải load đúng transcript của Agent đó (showTaskWithId),
	 * không được ghi đè agentTasks bằng task đang mở.
	 */
	historyBrowse?: boolean

	/** @deprecated Tương thích ngược: Đọc qua getTabActiveTaskId(tab). Không ghi độc lập. */
	taskId?: string

	/** @deprecated Tương thích ngược: Draft input của activeAgentId */
	draftInput?: string
}

export interface ChatTabsState {
	/** Danh sách các tab đang mở */
	tabs: ChatTab[]

	/** ID của tab đang được chọn hiển thị */
	activeTabId: string

	/** Trạng thái mở/đóng của History Drawer */
	isHistoryOpen: boolean
}

export const CONSOLE_TABS_STORAGE_KEY = "orvanta_console_tabs_state"
export const CONSOLE_TABS_STORAGE_KEY_V1 = "orvanta_console_tabs_state_v1"
export const CONSOLE_DRAFTS_STORAGE_KEY = "orvanta_console_drafts_v1"
export const DEFAULT_TAB_TITLE = "Phiên làm việc mới"
export const MAX_TABS_COUNT = 15
export const MAX_DRAFT_LENGTH = 50_000

/**
 * Trích xuất an toàn taskId của agent đang active trong tab.
 * Luôn ưu tiên agentTasks[activeAgentId] trước, sau đó fallback taskId legacy nếu còn sót.
 */
export function getTabActiveTaskId(tab: ChatTab | undefined): string | undefined {
	if (!tab) return undefined
	return tab.agentTasks?.[tab.activeAgentId] || tab.taskId
}
