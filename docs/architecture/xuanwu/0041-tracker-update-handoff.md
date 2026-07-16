# ADR-XW-0041：Tracker Update Handoff

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P05.06 / Runner #677
- 硬依赖：XW P05.01 / #672（`done`）
- contract：`backend-ts/src/integrations/tracker/contracts.ts`
- outbox / dispatcher：`backend-ts/src/db/repositories/trackerUpdateOutbox.ts`、
  `backend-ts/src/domain/handoff/trackerUpdate.ts`
- fake adapter：`backend-ts/src/integrations/tracker/fakeAdapter.ts`

## 1. 决策与边界

本期建立 tracker-neutral 的 comment/status mapping、durable outbox、dedupe、bounded retry、audit、Attention
和 fake adapter，不接真实 Tracker、不新增 HTTP route，也不修改 Issue/Work/Handoff 共享状态机。P05.08 才负责
provider 注册、Handoff API/UI 和 workflow 接线；具体 Tracker 双向同步由集成阶段承接。

`buildTrackerUpdateCommand()` 从 P05.01 `HandoffRecord` 确定性生成 comment，并由调用方提供完整的
`draft | ready | delivered | superseded -> external status | null` mapping。Comment 只使用 Handoff 的 summary、
branch/commit/PR ref、Evidence verification 摘要、review 和 risks；adapter 不重新解释 Handoff，也不能修改 mapping。

## 2. 权限与审计

外部写不得信任 request/LLM 自报的 allow。Queue 前必须同时满足：

1. Handoff 通过 P05.01 validator，且存在 target 精确匹配的 `tracker_update + external_write` delivery action；
2. delivery action 为 `gate_decision=allow + outcome=not_executed`；
3. `authorization_action_id` 指向现有 `pi_actions` 中 `handoff.tracker_update` action；
4. action scope、payload fingerprint、status、`gate_decision=execute` 与 `pi_action_events` 的 gate audit 全部匹配；
5. Handoff `audit_event_ref` 精确引用该 gate event。

Queue、每次 attempt、retry 和 outcome 都追加到现有 `pi_action_events`。Action 在 queue 后进入 `executing`，
provider receipt 持久化后进入 `completed`；终态失败进入 `failed`。Audit/result 不保存 comment body、credential
或原始 provider error，错误统一脱敏。

## 3. Outbox、dedupe 与 retry

Migration `043_tracker_update_outbox` 扩展现有 `sync_outbox`，不创建第二套 outbox authority：

- `operation_kind='im_reply'` 是所有旧行和旧 writer 的默认值；Feishu dispatcher 显式只读取该 kind；
- Tracker 行使用 `operation_kind='tracker_update'`，并保存 project/work/Handoff/target、canonical payload、result、
  correlation、provider request ref 和 Attention ref；
- `(source, operation_kind, dedupe_key)` partial unique index 是 queue dedupe authority；相同 key 与不同 payload
  fail closed；
- legacy `reply_draft_id` unique index 改为 `reply_draft_id > 0` 的 partial index，继续保证 IM draft 幂等，避免
  tracker 行的 `0` sentinel 互相冲突；
- claim 使用 compare-and-set、attempt count 和 lease；stale `sending` 可在 lease 到期后恢复；retry 受
  `max_attempts <= 10` 和 cooldown 限制，不 sleep、不无界重试。

Adapter 必须按 idempotency key 幂等。若 provider 已写入但本地 receipt commit 丢失，lease 后重试同一个 key；
fake adapter 会 replay 原 receipt，payload fingerprint 不同则报 permanent conflict。Provider receipt、outbox sent
和 `external_links(relationship='handoff_tracker_update')` 在同一 DB transaction 落地；重复 dispatch 不产生第二条 link。

## 4. Attention

Permanent error 或 attempts 耗尽后，dispatcher 在同一 transaction：

1. 把 outbox 标记为 `failed`；
2. 把 PI action 标记为 `failed`；
3. 复用现有 `pi_guardian_alerts` 创建/合并 `handoff_tracker_update_failed` open alert；
4. 写 `handoff.tracker_update.outcome.v1` audit，并把 `attention_ref` 保存回 outbox。

因此失败不会创造平行 Attention 表或静默留在 retry。

## 5. Source of truth、兼容窗口与回滚

- **当前 source of truth：** P05.01 Handoff 是交付意图和 refs contract；`pi_actions/pi_action_events` 是权限与
  audit authority；`sync_outbox` 是 pending/attempt/delivery state authority；真实 Tracker（本期只有 fake）是外部
  comment/status fact authority；`external_links` 保存跨系统 provenance；Guardian alert 是失败 Attention authority。
- **双写/双读期限：** 0。IM 与 tracker 是同一 outbox 内按 `operation_kind` 隔离的两类 workload，不是两个
  tracker writer。当前没有 live producer/consumer 注册，也不替换 legacy completion/comment writer。
- **回滚：** 停止 P05.08 的 tracker adapter/dispatcher 注册并保留 outbox、receipt、audit、external link 和 alert。
  Migration 为 additive；不能删除已发送外部 comment/status、清空 audit，或把 Work 反写成成功来伪装回滚。
- **最终删除门禁：** 只有 P11.03/P11.06 + G7、至少一个正式 release 的 operation parity、durable receipt
  restore、response-loss replay、Attention/audit restore rehearsal，以及 legacy tracker writer 连续一个正式 release
  为零后，才能删除兼容 writer/reader或收紧旧列；本 issue 不执行删除。

## 6. Focused verification

```bash
cd backend-ts
bun test \
  src/db/database.test.ts \
  src/pi/imReplyOutboxDispatcher.test.ts \
  src/domain/handoff/trackerUpdate.test.ts
```

Fixture 覆盖 fake tracker E2E、queue dedupe、response-loss duplicate dispatch replay、transient retry、permanent
failure → Guardian Attention、gate fail-closed，以及 legacy Feishu outbox 隔离；不会访问真实外部系统。
