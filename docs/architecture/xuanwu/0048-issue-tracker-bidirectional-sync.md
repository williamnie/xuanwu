# ADR-XW-0048：Issue Tracker 双向同步

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P09.05 / Runner #721
- 硬依赖：XW P09.01 / #717、XW P05.06 / #677（均为 `done`）

## 边界与接口

`integrations/tracker/issueSync.ts` 是 GitHub Issues、GitLab Issues、Linear 类 Tracker 的唯一 inbound
normalizer：各 provider 只将 webhook 或 poll payload 转为 `TrackerIssueEvent`，再通过 P09.01
`InboundEnvelope` 校验。`TrackerIssueAdapter.poll()` 是 poll port；HTTP webhook 和受限的 poll batch 都进入同一
`syncTrackerIssueEvent()`，不会在 provider 内复制 Issue writer。

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

通用 Tracker 事件导入层的 GitHub 状态规则依据已认证的人类决策 `event_id=549106`（2026-09-26）修订，
替代本节原有的 GitHub 状态映射。此规则仅约束 `syncTrackerIssueEvent()` 的导入行为：不能把 `closed`
直接变为本地 `done`；首次映射的 GitHub event 一律创建 `triage` 的 Runner Issue，包括首次收到 `closed`。
已关联的 GitHub `closed/reopened`（重开 payload 的 `state=open`）及其他状态在导入层只记录外部事实，
不改变本地 Issue 状态、内容或 `updated_at`；语义完成须由 PI 基于交付证据验收。首次接入写
`intake_created` audit；后续新鲜 event 写
`external_status_recorded` audit（包含 `external_status`、`issue_status`）及同名 `external_links` relationship，
只推进 link 的 `last_external_updated_at`，保留 `last_synced_issue_updated_at`。本地已有新修改也正常记录
外部事实，不产生状态映射的 `local_conflict`。

业务工作流仍需按交付事实联动：手动关闭 GitHub Issue 或撤回玄武接管时应停止未完成任务，重新打开应
重新调查，修复成功则需要证据与 PI 验收。依据评审决策 `github-pr-comment:5846220205`，关闭或撤回时
停止任务、重开后重新调查的联动属于集成层后续能力，本 PR 未实现。导入层保留本地状态的规则不代表
整个玄武永远不响应 GitHub 关闭或重开，也不替代该业务工作流。

GitHub 以 `provider + external_id + external_updated_at + payload SHA-256` 区分事件，摘要取自
`JSON.stringify(payload)`，cursor 不参与身份判定。同一时间戳的 closed/reopened 或不同编辑 payload
分别创建 `external_event`，保留各自的原始 payload、外部状态和关联记录，不因时间戳相同而冲突或判旧。
相同事件重放返回原记录及 `replayed=true`，不新增 event、link 或 audit。已有旧时间戳键仅在 payload
摘要相同时作为重放命中，无需数据迁移。GitHub 写事务内复查去重键，避免并发事件重复落库；通用
`externalEvents` 的 `source + external_id` 上插语义保持不变。

GitLab、Linear 和 fake Tracker 保持既有兼容行为：首次映射 event 创建一个
`triage/todo/in_progress/done/cancelled` 的 Runner Issue，之后可按状态映射更新 Issue；若目标状态不同且
`issues.updated_at` 已不同于 link 的 `last_synced_issue_updated_at`，记录 `local_conflict`，保持用户当前状态。

所有 provider 都写 `external_events`、`external_links`、`tracker_issue_links`；后续 title、description 绝不由
同步覆盖。非 GitHub provider 继续以 `provider + external_id + external_updated_at` 幂等，同键不同 payload
仍拒绝为 `tracker_event_dedupe_conflict`。GitHub 严格早于 checkpoint 的事件记为 `stale_external`，其他
provider 仍将早于或等于 checkpoint 的新事件判旧；均不产生第二次 Issue/外部写。

## Source of truth、迁移与回滚

| 事实 | authority |
| --- | --- |
| 外部 issue 内容、状态和 delivery | Tracker provider |
| Runner Issue 人工修改和执行状态；GitHub 语义完成 | `issues` / PI 验收 |
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

测试覆盖 fake poll E2E、cursor、幂等 replay、用户修改不被外部状态覆盖、GitHub/GitLab/Linear normalizer、
GitHub 导入层 closed/reopened 保留所有本地状态与外部事实审计、首次 closed webhook intake 进入 triage、同时间戳
closed/reopened/编辑事件分别持久化与重放、旧键重放兼容、poll 重开、旧事件保护、非 GitHub 状态映射兼容，
以及 P05.06 fake Handoff outbox write/replay；不访问真实 Tracker。
