# 未开始 Issue 规划元数据更新合同

## 决策

正式支持创建后修正 `title`、`description` 和结构化依赖。它们属于排队前的规划元数据：用户可能在拆分任务后补齐依赖，也可能在执行前修正文案。强制删除并重建 Issue 会丢失稳定 ID、评论与审计上下文，因此不可变并不是更安全的产品语义。

支持范围必须保持窄：只有当前状态为 `triage` 或 `todo`，并且 `issue_runs` 中从未出现该 Issue 的记录时，才能产生上述字段的有效变化。状态为 `in_progress`、`needs_user`、`done`、`failed`、`cancelled` 时一律拒绝；即使状态后来被人工改回 `triage`/`todo`，只要曾创建过 Run 也拒绝。完全相同的 payload 是无副作用重放，可以在状态变化后返回当前值，但不能修复或改变规划元数据。

`agent_profile_id`、状态等既有字段继续遵循各自合同，不因本合同扩大权限。

## 写入权威与兼容性

- `issues` 仍是 Issue-backed Work 的写入权威；Issue API 直接调用 `updateIssue`，Work API 通过 `updateIssueBackedWork` 调用同一个入口。
- `work_relations(kind='depends_on')` 是调度硬边；`issues.dependency_issue_ids_json` 是兼容快照。依赖替换必须在一个数据库事务中同步二者。
- `description` 单独更新时保留现有 `title`。创建时“未给 title 则从正文推导”的行为不变；更新时不再隐式推导标题。
- 正文没有 `Dependencies`/`依赖` 章节时，不要求复制结构化依赖。正文存在该章节时，章节中的 Issue ID 必须与结构化依赖完全一致；否则创建或更新失败。正文声明不能单独改变调度边。
- `PATCH /api/issues/:id` 与 `PATCH /api/works/:id` 都接受 `depends_on_issue_ids`，含义是全量替换。字段未提供表示保留；显式 `[]` 表示清空。

## 依赖安全与事务

依赖输入必须是无重复的正安全整数数组。每个目标 Issue 必须存在、属于同一项目且不能是自身。更新以“dependent → prerequisite”为方向，在现有 JSON 快照与硬边的并集图上检查从新 prerequisite 回到 dependent 的路径；存在路径即拒绝成环。

所有生命周期检查、目标校验、环检测、Issue 快照更新、旧边删除、新边插入和审计事件写入都在同一 `IMMEDIATE` 事务内完成。任一步失败会回滚 title、description、JSON 快照、硬边和事件，不留下部分写入。

## 审计与幂等

有效变化更新一次 `issues.updated_at`，并追加一个 `issue.planning_metadata_updated.v1` 事件，记录实际变化字段以及依赖全量快照。相同的规范化 payload 重放时不更新时间、不重写关系、不追加事件。

Work API 继续要求 `audit.event_id` 和 `expected_revision`：相同事件和相同 payload 返回既有结果；相同事件但不同 payload 冲突。Raw Issue PATCH 没有调用方幂等键，因此依靠规范化后的 no-op 检测提供重放安全。

## CLI 合同

```bash
xuanwu issue update --id 123 --title "新标题" --body-file /tmp/issue.md --depends-on 10,11 --json
xuanwu issue update --id 123 --clear-dependencies --json
```

`--body` 与 `--body-file` 互斥；`--depends-on` 与 `--clear-dependencies` 互斥。`--depends-on` 至少包含一个逗号分隔的正 Issue ID，重复 ID 直接报错。

## 个人 `$xuanwu` Skill 更新建议

本仓库不修改 `/Users/xiaobei/.codex/skills/xuanwu/SKILL.md`。后续由 Skill 所有者审查并加入以下提示：

> 仅对当前为 `triage`/`todo` 且从未创建 Run 的 Issue 使用 `issue update --title/--body/--body-file/--depends-on/--clear-dependencies`。正文单独 PATCH 不会重算标题，也不会改变硬依赖；依赖必须通过结构化参数更新，`--clear-dependencies` 才表示显式清空。正文若包含依赖章节，必须与结构化依赖一致。不要对运行中、已运行、人工等待或终态 Issue 使用这些规划字段；raw PATCH 同样受此限制。
