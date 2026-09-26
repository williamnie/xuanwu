# ADR-XW-0048：Issue Tracker 双向同步

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P09.05 / Runner #721
- 硬依赖：XW P09.01 / #717、XW P05.06 / #677（均为 `done`）
- GitHub 的自动接管、状态权威和生产运行接线由 [ADR-XW-0096](0096-github-issue-agent-loop.md) 更新；本文件其余 provider 的兼容合同保持不变。

## 边界与接口

`integrations/tracker/issueSync.ts` 是认证事件导入接口中 GitHub Issues、GitLab Issues、Linear 类 Tracker 的 inbound
normalizer：各 provider 将已取得的 webhook 或 poll payload 转为 `TrackerIssueEvent`，再通过 P09.01
`InboundEnvelope` 校验。`TrackerIssueAdapter.poll()` 是 poll port；HTTP webhook 和受限的 poll batch 都进入同一
`syncTrackerIssueEvent()`，不会在 provider 内复制 Issue writer。GitHub 常驻轮询与调查工作流使用 ADR-XW-0096
的不可变 Issue ID、源版本和接管策略，仍通过 canonical `createIssue` 创建 Work。此处带 Bearer 认证的事件接口
不等于可直接接受 GitHub Webhook 的验签入口。

Handoff outbound 继续使用 P05.06 的 `TrackerAdapter`、`sync_outbox(operation_kind='tracker_update')` 和
`createTrackerUpdateHandoffService()`；本期不新建第二套 outbox。具体 provider 的外部写 adapter 必须实现既有
`applyUpdate(command, context)` 幂等 contract，并由已有 deterministic PI gate、outbox 和 audit 触发。

## 路由、链接和冲突

- `PUT /api/integrations/trackers/mappings` 将 `provider + scope` 显式映射到项目；每次变更写
  `tracker_sync_events` audit。
- `PUT /api/integrations/trackers/:provider/links` 是人工把外部 issue 连接到既有 Runner Issue 的入口；需要
  `audit.actor/reason/correlation_id`，不会猜测或重绑已有 link。
- `POST /api/integrations/trackers/:provider/events` 接收 GitHub/GitLab/Linear webhook payload；
  `POST .../poll` 接收最多 100 个已取得的 poll event，cursor 持久化到 `tracker_sync_cursors`。
- 未映射的 inbound event 只进入 `external_events(status='attention')` 和 audit，不创建 Runner Issue。

GitHub 首次映射 event 始终创建 `triage`，后续 open/closed 只记录外部状态审计；只有 PI 能决定本地完成。
重复、撤回、符合设计、未复现都不能由 closed 推导为修复成功。其他 Tracker 的首次映射 event 仍按兼容映射创建
`triage/todo/in_progress/done/cancelled` 的 Runner Issue，并写
`external_events`、`external_links`、`tracker_issue_links`。之后只可按状态映射更新 Issue；title、description
绝不由同步覆盖。若 `issues.updated_at` 已不同于 link 的 `last_synced_issue_updated_at`，外部更新会记录
`local_conflict`，保持用户当前状态。GitHub 幂等键还包含事件类型和 payload hash，以区分共享 updated_at 的评论/标签事件；
其他 provider 仍以 `provider + external_id + external_updated_at` 幂等。旧时间戳
记为 `stale_external`，均不产生第二次 Issue/外部写。

GitHub 的 `external_events.external_id` 使用 `github-event:<dedupe-key sha256>` 标识每一次源事件，防止共享事件
仓库按 Issue ID upsert 时覆盖旧事件。逻辑 Issue ID 留在 `normalized_message.external_issue_id`、
`tracker_issue_links.external_id` 与 `external_links.external_id`。因此处理后续更新后，重放较早的同一事件仍命中原记录。
此变化仅发生在 GitHub 适配层，不修改共享事件仓库或其他 Tracker 的 upsert 行为，也不伪造已经丢失的历史载荷。

## Source of truth、迁移与回滚

| 事实 | authority |
| --- | --- |
| 外部 issue 内容、状态和 delivery | Tracker provider |
| Runner Issue 人工修改和执行状态 | `issues` |
| inbound provenance | `external_events` / `external_links` |
| 路由、link checkpoint、cursor、conflict audit | `tracker_*` tables |
| Handoff 外部写与 receipt | P05.06 `sync_outbox` / `pi_actions` / `pi_action_events` |

`048_tracker_issue_sync` 为 additive migration，没有双写/双读期限，也没有替换旧 Issue 或 Handoff authority。
回滚时停止注册 webhook/poll worker 和 outbound adapter，保留 event、link、cursor、outbox receipt 和 audit；不得删除
已写入的外部 comment 或回写 Issue 伪造成功。删除兼容路径的门禁为：三个 provider 的 payload parity、response-loss
幂等、人工冲突恢复、outbox receipt restore 和至少一个正式 release 的 audit 演练全部通过。

## Focused verification

```bash
cd backend-ts
bun test src/db/database.test.ts src/integrations/tracker/issueSync.test.ts src/domain/handoff/trackerUpdate.test.ts
```

测试覆盖 fake poll E2E、cursor、幂等 replay、用户修改不被外部状态覆盖、GitHub/GitLab/Linear normalizer，以及
P05.06 fake Handoff outbox write/replay；不访问真实 Tracker。
