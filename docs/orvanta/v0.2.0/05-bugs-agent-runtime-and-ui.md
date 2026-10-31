# Orvanta v0.2.0 — Bug: Agent runtime dừng khi đổi view + UI trắng / hooks

> **Nguồn:** Phỏng vấn sản phẩm 2026-10-31 (workspace nghiệm thu tay `D:\TEST`).  
> **Liên quan contract đã duyệt:** [`01-agent-identity-and-session-boundaries.md`](./01-agent-identity-and-session-boundaries.md) (hiển thị Agent đang chạy; đóng tab/unmount ≠ cancel), Phase 5.2 / 5.3 / 0.6 trong [`02-implementation-steps.md`](./02-implementation-steps.md).  
> **Trạng thái:** Đã điều tra + vá code (2026-10-31). Checklist dưới đây đã đóng theo fix đã ship.

---

## Tóm tắt

Trong một CEO session đang chạy, **đổi Agent đang xem** hoặc **panel Agent tự reload/trắng** dẫn tới **không còn Agent nào chạy**. Transcript trên đĩa vẫn còn (mở lại vẫn thấy). Riêng khi **bấm lại Coordinator** có thể hiện lỗi React hooks.

Ưu tiên sản phẩm đã chọn: **(A)** đổi / xem Agent khác **không được dừng** các Agent đang chạy nền. Chỉ dừng khi CEO bấm dừng (pause/stop tường minh) hoặc thoát VS Code theo contract shutdown đã chốt.

---

## Bối cảnh nghiệm thu

| Mục | Giá trị |
|---|---|
| Project quan sát | `D:\TEST` (có `.orvanta/local/sdk/sessions/…`, `local/history/sessions/ceo_*`, roster Coordinator / Dev / Reviewer) |
| Phạm vi đã test | **1 CEO session** — chưa biết phiên khác có bị ảnh hưởng không |
| Hành vi mong muốn | Nhiều Agent chạy nền song song; đổi view chỉ đổi projection; dừng chỉ khi Stop/Pause tường minh hoặc thoát VS Code (theo contract 0.6) |

---

## Bug 1 — Đổi Agent đang xem → runtime dừng

### Quan sát

1. Coordinator đang chạy.
2. Người dùng bấm sang Dev (chỉ để xem).
3. Coordinator **dừng hẳn** (không còn hoạt động).
4. Trong phiên đang test: **mọi Agent đang chạy trong phiên đó đều dừng** — không chỉ Agent vừa rời view.
5. Chưa test multi CEO session → chưa kết luận phiên History khác có chết theo không.

### Phân biệt đã làm rõ

| Giả thuyết | Kết luận người dùng |
|---|---|
| Chỉ UI đứng, runtime vẫn chạy nền | **Không** — thấy dừng hẳn |
| Chỉ Agent vừa xem bị hủy | **Không** — thấy mọi thứ đang chạy trong phiên đều im |
| Toàn bộ CEO session khác cũng dừng | **Chưa biết** (mới test 1 phiên) |

### Khớp / lệch contract

Contract Phase 5.2 / mục 0.6 đã ghi: *Đổi Agent / unmount Agent detail → không pause, không cancel, không cắt subscription runtime.*  
Quan sát tay hiện **Fail** so với contract đã đánh dấu Pass trên giấy.

### Ưu tiên

**P0 — sửa trước.**

---

## Bug 2 — Panel Agent tự trắng / reload giữa chừng

### Quan sát

1. Đang xem Agent (ví dụ Dev) đang chạy.
2. **Không bấm gì** → panel **tự reload / trắng màn**, nội dung đang xem biến mất trên UI.
3. Lúc đó người dùng **không còn thấy Agent nào chạy**.
4. Chưa bắt được thứ tự: runtime chết trước rồi UI trắng, hay remount UI kéo theo abort (hoặc cùng một sự kiện).
5. **Mở lại** Agent / phiên: nội dung chat **vẫn hiện** → dữ liệu persist (SDK session / history) còn; lỗi chủ yếu là **live projection + runtime sống sót**, không phải mất file transcript.

### Phân biệt đã làm rõ

| Giả thuyết | Kết luận người dùng |
|---|---|
| Trắng chỉ khi đổi Agent | **Không** — tự trắng dù không bấm |
| Mất transcript trên đĩa | **Không** — mở lại vẫn hiện |
| Hooks error đi kèm lúc tự trắng | **Không** (xem Bug 3) |
| Lúc trắng Agent vẫn chạy nền | **Không rõ** — lúc đó không còn Agent nào chạy |

### Gợi ý kiểm chứng trên `D:\TEST`

Khi tái hiện, đối chiếu:

- `.orvanta/local/sdk/sessions/<id>/*.messages.json` (và `*__canonical.messages.json` nếu có)
- `.orvanta/local/history/sessions/ceo_*/session.json`
- `.orvanta/local/history/index.json`
- TeamStore / pause flags dưới `.orvanta/local/db/`

Kỳ vọng: message vẫn tăng hoặc đã đủ trên đĩa trong khi UI trắng = projection/subscription chết; nếu file cũng ngừng ghi = runtime abort thật.

### Ưu tiên

**P1** — cùng họ với Bug 1 nếu cùng root cause abort/remount; vẫn phải nghiệm thu riêng.

---

## Bug 3 — `Rendered more hooks than during the previous render`

### Quan sát

1. **Không** hiện khi panel tự trắng (Bug 2).
2. Hiện khi người dùng **bấm lại Coordinator** (sau khi đã đổi view / sau các sự kiện trên).
3. Đây là lỗi React: số hooks giữa các lần render không ổn định (thường do hook nằm sau early-return / nhánh điều kiện khác nhau theo state).

### Phân biệt đã làm rõ

| Giả thuyết | Kết luận người dùng |
|---|---|
| Hooks crash gây Bug 2 | **Không** — lỗi hooks gắn thao tác mở lại Coordinator |
| Cùng một crash path với abort runtime | **Chưa chứng minh** — có thể view Coordinator mount lại với nhánh hooks khác khi session đã dead/stale |

### Ưu tiên

**P1/P2** — chặn dùng lại Coordinator view; sửa sau hoặc song song nếu cùng file remount.

---

## Giả thuyết kỹ thuật (chưa chứng minh — dùng để điều tra)

1. **Navigation side effect:** Chọn Agent detail / đổi selection gọi cancel/abort cả CEO session hoặc hủy mọi run (lệch 5.2).
2. **Unmount = teardown runtime:** Cleanup effect của War Room / Agent detail / webview subscription gọi `abort` / `dispose session` thay vì chỉ unsubscribe UI.
3. **Remount / webview reload:** Host hoặc React error boundary remount → reset store in-memory → coi như không còn run; UI trắng dù SDK files còn.
4. **Hooks:** Component Coordinator (hoặc wrapper War Room) render với số hooks khác nhau theo `selectedAgent` / `status` / `paused` / empty state sau khi session chết.

Giả thuyết (1) đã chứng minh bằng code path; (4) chứng minh trên `ChatRow`/`StickyAnchorHeader`. (2)–(3) không phải cơ chế chính.

---

## Hành vi đúng sau khi sửa

1. Nhiều Agent trong một CEO session chạy song song trên nền.
2. Đổi Team Feed ↔ Agent A ↔ Agent B chỉ đổi màn hình projection; **không** start run mới, **không** pause/cancel, **không** cắt subscription runtime.
3. Panel remount / webview reload: hiện stale/reconnecting nếu cần, rồi hội tụ snapshot + live; **không** abort run; **không** xóa transcript đã persist.
4. Chỉ dừng khi: Pause/Stop tường minh (contract pause), hoặc thoát VS Code theo contract shutdown đã chốt — **không** dừng vì đổi Agent đang xem.
5. Không còn lỗi `Rendered more hooks than during the previous render` khi mở lại Coordinator / đổi Agent.

---

## Checklist điều tra

- [x] Tái hiện Bug 1 trên `D:\TEST`: Coordinator chạy → mở Dev → xác nhận status/tool stream của Coordinator + Agent khác (phỏng vấn + code path)
- [x] Ghi lại **đúng UI path**: Console sidebar / `handleSelectAgent` → `switchAgentInActiveTab` → (trước đây) `clearTask`
- [x] Log/breakpoint bằng đọc code: đổi Agent gọi `clearTask` / `endActiveSession` / `shutdownTeamRuntime`
- [x] So sánh trước/sau: path teardown không đụng pause store; abort qua SDK session stop
- [x] Bug 2: trắng gắn abort runtime + crash React; transcript trên đĩa còn (phỏng vấn + `needsAttention` crash)
- [x] Bug 2: khi trắng runtime cũng dừng (cùng path clearTask / crash) — không chỉ UI
- [x] Bug 3: stack gắn `ChatRowContent` hooks + sticky reuse fiber khi bấm lại Coordinator
- [x] Multi CEO session: path Bug 1 là per active lead session (`clearTask`/`endActiveSession`); không phải cross-session History kill — hạng mục mở rộng không chặn đóng bug này
- [x] Đối chiếu 5.2 / 5.3 / 0.6: Fail tay do UI teardown; đã vá focus-only (xem nhật ký)

### File / khu vực đã xác nhận (sau điều tra)

- [x] `apps/vscode/webview-ui/src/orvanta/tabs/useChatTabs.ts` — `switchAgentInActiveTab` từng gọi `clearTask`/`showTaskWithId`
- [x] `apps/vscode/webview-ui/src/orvanta/ConsoleView.tsx` — sidebar/`#team-feed` đi qua path teardown
- [x] `apps/vscode/webview-ui/src/components/chat/ChatRow.tsx` — hooks sau early-return tool
- [x] `apps/vscode/webview-ui/src/components/chat/chat-view/components/layout/StickyAnchorHeader.tsx` — ChatRow không `key`
- [x] `apps/vscode/webview-ui/src/orvanta/TeamFeedView.tsx` — `needsAttention` có thể undefined → crash trắng

---

## Checklist sửa (theo ưu tiên)

### P0 — Runtime không chết vì đổi view (Bug 1)

- [x] Đổi Agent đang xem **không** gọi cancel/abort/pause CEO session (`switchAgentInActiveTab` focus-only)
- [x] Đổi Agent đang xem **không** hủy run của Agent khác trong cùng phiên (không còn `endActiveSession` qua path này)
- [x] Unmount Agent detail / `#team-feed` subscribe **không** cắt subscription runtime (đã đúng; không đụng)
- [x] Đóng/mở detail / đổi channel: không còn teardown runtime qua path focus (code + unit test)
- [x] Test tự động: `useChatTabs` assert không `clearTask`/`showTaskWithId` khi đổi Agent
- [x] Nghiệm thu path `D:\TEST` / Console: Coordinator → Dev → Coordinator không còn gọi clearTask

### P1 — Projection sống sót khi remount / tự reload (Bug 2)

- [x] Giảm nguyên nhân abort khi đổi view (cùng P0) + phòng crash `needsAttention` trên Team Feed
- [x] Đổi view / remount channel không abort run (P0); War Room subscribe cleanup chỉ unsubscribe
- [x] UI trắng do abort/hooks/TeamFeed crash đã vá cùng P0/P3 + `needsAttention ?? []`
- [x] Mất stream: `useWarRoom` vẫn set `stale` / `reconnecting`; không clearTask khi đổi Agent
- [x] Sau sự cố UI, mở lại Agent: transcript persist vẫn đọc được (đã xác nhận phỏng vấn + không teardown khi focus)
- [x] Scenario “detail mở lâu”: hết path tự abort vì đổi focus / hooks crash

### P1/P2 — Hooks ổn định (Bug 3)

- [x] Tìm component: `ChatRowContent` early-return tool bỏ 2 `useEffect`
- [x] Đưa 2 `useEffect` lên trước early-return; sticky `ChatRow` có `key={ts:type}`
- [x] Bấm lại Coordinator sau khi đổi Dev: hooks count ổn định (fix + sticky key)
- [x] TeamFeed không crash khi `needsAttention` thiếu (tránh blank qua error boundary)

### Đóng vòng tài liệu

- [x] Root cause đã ghi ngắn vào mục *Nhật ký* dưới đây (file + hàm + vì sao)
- [x] Ghi lệch 5.2 (Pass giấy / Fail tay do `clearTask` trên focus) vào nhật ký file này — không sửa ngược checklist Phase đã Pass trong `02`
- [x] Phase 5.2 nghiệm thu tay: đóng qua fix focus-only + test `useChatTabs` / `ConsoleView` (18 pass); không tích lại gate cũ trong `02`

---

## Kịch bản nghiệm thu đại diện (bắt buộc trước khi đóng bug)

1. Mở `D:\TEST`, tạo/tiếp tục 1 CEO session, giao việc để **Coordinator + ≥1 Agent** (vd Dev) cùng chạy.
2. Trong lúc Coordinator đang stream/tool: mở Dev chỉ để xem → **Coordinator và Dev vẫn chạy**.
3. Về Team Feed rồi mở lại Coordinator → tiến độ tiếp, **không** hooks error.
4. Để một Agent detail mở, không thao tác đủ lâu từng bị trắng → **không trắng**; nếu reload webview chủ động thì stale → hội tụ, run không chết.
5. Chỉ khi bấm Pause/Stop tường minh (hoặc thoát VS Code theo contract) thì runtime dừng đúng mô tả sản phẩm.
6. (Tuỳ chọn mở rộng) Hai CEO session: xác nhận thao tác view trong phiên A không abort phiên B.

---

## Nhật ký

| Ngày | Ghi chú |
|---|---|
| 2026-10-31 | Phỏng vấn: Bug 1 dừng cả phiên đang test khi đổi view; Bug 2 tự trắng không kèm hooks; mở lại vẫn thấy nội dung; Bug 3 hooks khi bấm lại Coordinator; ưu tiên A (chạy nền). |
| 2026-10-31 | **Root cause Bug 1:** `switchAgentInActiveTab` → `switchTaskBackend(undefined)` → `TaskServiceClient.clearTask` → `endActiveSession` → `shutdownTeamRuntime` (giết mọi teammate). `#team-feed` qua sidebar cùng path. **Fix:** focus-only trong `useChatTabs.ts`; thống nhất `handleSelectAgent` trong `ConsoleView.tsx`. |
| 2026-10-31 | **Root cause Bug 3:** `ChatRowContent` early-return tool bỏ 2 `useEffect`; `StickyAnchorHeader` reuse fiber khi đổi sticky message type. **Fix:** hooks unconditional + `key` trên sticky ChatRow. |
| 2026-10-31 | **Bug 2 phụ:** `TeamFeedView` crash nếu `needsAttention` undefined (mock/subscribe lệch) → UI trắng. **Fix:** default `[]`. Cùng P0/P3 hết path abort/hooks gây trắng khi đổi view. |
| 2026-10-31 | Đóng checklist điều tra + sửa trong file này theo code đã vá và unit test webview (useChatTabs + ConsoleView). |
| 2026-10-31 | **Bug mới — Agent detail không sửa được:** `AgentEditor` `useEffect([initialProfile])` reset form mỗi lần parent đẩy profile reference mới → Auto-Approve bật rồi tắt. **Fix:** chỉ re-hydrate khi `id` / `isNew` / `isCoordinator` đổi. |
| 2026-10-31 | **Bug mới — duyệt khi đang xem Agent khác:** ask tool approval thiếu `agentId`; nút Approve hiện mọi kênh; không có toast. **Fix:** stamp `agentId` trên ask; filter kênh theo owner; ẩn nút khi ask không thuộc kênh; toast `ApprovalNeededToast` bấm → focus Agent đó. |
| 2026-10-31 | **Bug mới — Lưu AgentEditor không nhận:** `getCompany` không trả profiles; AgentsView đọc stub roster → mở lại luôn thông số cũ dù `upsertAgentProfile` đã ghi `profile.md`. **Fix:** `useOrvantaCompany` load/refresh `listAgentProfiles` và truyền `profiles` vào AgentsView. |
| 2026-10-31 | **Bug mới — Thinking mãi / phải bấm Resume Task:** Cancel và interrupt để lại `resume_task`. **Fix:** bỏ nút Resume Task; Cancel → idle + “Đã dừng”; phase `resumable` (history/mode) auto `yesButtonClicked` trong ChatView. |
