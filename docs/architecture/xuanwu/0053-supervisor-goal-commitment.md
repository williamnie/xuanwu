# Supervisor Goal、Commitment 与会话连续性

- 状态：Implemented（W1 compatibility projection）
- 路线 issue：XW P06.13 / Runner #692
- 硬依赖：XW P02.03 / #649、XW P06.05 / #684（均为 `done`）

## 1. 决策

本阶段不增加第二套 Goal/Commitment 表、Work relation kind、公共 API、共享状态机或 provider adapter。Supervisor Commitment 复用已经过运行验证的 Work、PI conversation、completion watch、notification intent 与 action audit：

| 事实 | source of truth |
| --- | --- |
| Goal 文本、Work ID、当前状态 | `issues-via-work-adapter`；兼容期仍以 `issues` 为 authority |
| 长期跟进生命周期、Work 关联、origin conversation | `pi_issue_completion_watches` + `pi_issue_completion_watch_items` |
| 创建、恢复、取消、遗忘、过期 | `pi_action_events`；从现有 PI action/tool gate 进入的写操作同时保留完整 action audit |
| 完成通知 | 既有 `issue_completion_watch_satisfied` notification intent / outbox；本地 UI 同步写既有 `notifications` projection |
| 会话正文 | `pi_conversations` 与原 PI SDK session；不是 Work/Commitment authority |
| 记忆 | `pi_memory_items` 继续只保存经既有 memory policy 允许的 durable memory；临时承诺不进入该表 |

Commitment 是标记过的 completion watch。标记固定为：

```json
{
  "type": "all_terminal",
  "pending_verification_satisfies": false,
  "terminal_statuses": ["done", "failed", "cancelled"],
  "commitment": {
    "schema_version": "xw.supervisor-commitment.v1",
    "due_at": "2026-07-18T01:00:00.000Z",
    "retention": "operational_not_memory"
  }
}
```

`due_at` 可以为空；非空值必须是 RFC3339。Goal 不复制到 condition 或 memory，而是在读取时从 authoritative Work 投影。因此修改 Work goal 后，恢复上下文会读取新事实，不会由旧聊天摘要覆盖。

## 2. 生命周期与确定性门禁

Commitment 用户态为 `active | completed | failed | cancelled | expired | forgotten`：

- `active`：至少一个 Work 未到真正终态；`pending_verification` 仍是未完成。
- `completed`：watch 已满足且所有 authoritative Work 都是 `done`。
- `failed` / `cancelled`：watch 满足后 authoritative Work 含对应终态。
- `expired`：确定性时钟发现 `due_at` 已过且 watch 仍 active；watch 以 `supervisor_commitment_expired` 原因取消，并追加 audit event。
- `forgotten`：用户明确请求 forget；底层 watch 取消并从 resume prompt 排除，但保留 Work、action audit 和历史 notification，不做不可审计删除。

创建只能在 authoritative Work 与真实 `pi_conversations` 均存在时进行。LLM 只能提出 tool input；真正写入仍经过 `issue_completion_watch_create` 的 Action Gate。取消/遗忘复用 `issue_completion_watch_cancel`；遗忘使用固定 reason `supervisor_commitment_forget`。任何模型文本都不能直接改变状态、伪造 due、覆盖 Work 或生成完成事实。

## 3. 会话连续性与恢复

- origin conversation 来自当前 runtime context；调用方不传时，Runner action layer 自动补当前 `conversationID` 与 source turn id。
- 同项目的新 conversation 会在 runtime prompt 中读到 active commitment；显式 resume 还会追加 `supervisor_commitment_resumed` event，把新 conversation 加入 linked ids。
- prompt 只注入有界 operational projection：commitment/watch id、Work goal/id/status、due 和 origin conversation。不注入 transcript，不从聊天文本猜承诺。
- 启动时原有 completion-watch sweep 会先检查 commitment due，再按 authoritative Issue/Work 状态修复 missed lifecycle event 并生成 completion notification。正常运行中的 Work 事件与下一次 prompt build 也会执行确定性到期检查。
- 临时 follow-up、due、cancel/forget 和 resume link 的 retention 固定为 `operational_not_memory`。只有独立于当前 Work、经用户明确表达且符合现有 memory policy 的 durable goal 才能走 memory candidate。

## 4. 兼容与迁移

- **source of truth：** Goal/状态仍是 `issues-via-work-adapter`；Commitment 生命周期仍是既有 completion watch。`work_relations` 当前只承载 `parent_child` / `depends_on`，本期不伪造第三种 relation。
- **双写：0。** 创建 commitment 就是创建带闭合 metadata 的 completion watch；没有 legacy watch + new commitment 两份记录。
- **双读：0。** 新 projection 只读取带 `xw.supervisor-commitment.v1` 标记的 watch；普通 completion watch 保持原行为，不与 commitment 猜 winner。
- **兼容期：** W1 内 `issues` / `issue_events` 仍是 Work 写 authority；Work Ledger cutover 后只替换 Goal/Work reader，不改变 commitment/watch identity 与 audit provenance。
- **回滚：** 移除 commitment prompt projection、metadata adapter 与 due sweep 即恢复普通 completion-watch 行为。已创建 watch 仍可由旧 list/cancel/evaluator 读取，已有 Work、audit、notification/outbox 全部保留，不需要 destructive data rollback。
- **最终删除门禁：** 仅当 P08.05/P08.06 统一 Standing Order/Completion、P11 migration/decommission、G7 cutover、重启恢复与跨会话 golden journey、cancel/expire/forget audit、notification delivery/restore rehearsal 均通过，且连续一个正式 release 无 legacy-only consumer 后，才可删除 compatibility projection 或迁移 watch carrier。

## 5. 验证

Focused tests 覆盖：

1. SQLite close/reopen 后恢复未完成 Goal/Work/due；
2. 显式 link 到新 conversation，并从新会话注入 resume context；
3. `pending_verification` 不触发完成，`done` 才生成既有 notification intent；
4. cancel、forget、due expiry 都有 action event，且不删除 Work；
5. operational commitment 不产生 `pi_memory_items`。
