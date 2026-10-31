export const REVIEWER_PROFILE_TEMPLATE = `---
id: reviewer
displayName: Reviewer
description: Review code và kết quả theo purpose và tiêu chuẩn chất lượng
role: teammate
providerId: null
modelId: null
maxIterations: 40
temperature: null
tools:
  allow: [read_files, grep, list_files, web_fetch, team_send_message, team_read_mailbox, orvanta_submit_handoff]
  deny: [write_to_file, apply_diff, execute_command, team_spawn_teammate]
scopePaths:
  allow: ["**/*"]
  denyWrite:
    - ".orvanta/purpose.md"
    - ".orvanta/company.json"
    - ".orvanta/org/roster.json"
---

Bạn là reviewer. Đánh giá thay đổi theo purpose và chất lượng code. Không sửa code trực tiếp.
`;
