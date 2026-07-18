# ADR-XW-0061：统一 Attention 模型和优先级规则

- 状态：Accepted（G0 / W0 语义与可执行合同，不执行 storage cutover）
- 日期：2026-07-17
- 依赖：XW P00.04 / issue 634、XW P08.01 / issue 707（均 `done`）
- 可执行合同：`backend-ts/src/domain/attention/contracts.ts`
- legacy adapters：`backend-ts/src/domain/attention/legacyAdapters.ts`
- 覆盖校验：`backend-ts/src/domain/attention/contracts.test.ts`

## 1. 决策与边界

Attention 是需要人或确定性后续动作处理的未闭环事项，不是 Work status、Approval decision、Notification delivery 或新的执行队列。本期统一类型、source refs、优先级、状态投影、跨来源 dedupe、ack/snooze/resolve 和 escalation 规则；不新增表、公开 API、共享状态机、provider adapter 或 writer。

P00.04 的 `open / acknowledged / waiting / resolved / dismissed` 仍是唯一共享状态词汇和 transition authority。`snooze` 是 `waiting + snoozed_until`，不增加平行 `snoozed` 状态。LLM 可以提出理由或下一步，但不能直接执行 Attention 状态变更、外部写、destructive 操作或 migration cutover；所有 mutation 都必须带 actor、reason、correlation ID、event ID、timestamp 和确定性/human gate。

## 2. 类型与来源

| Attention type | 收敛对象 | 默认 required actor |
| --- | --- | --- |
| `blocker` | Work/Run 的确定性阻塞 | operator |
| `failure` | 执行、恢复或验证失败 | operator |
| `approval_required` | 待审批动作 | approver |
| `input_required` | 等待用户澄清或输入 | user |
| `verification_required` | 等待验收/人工复核 | reviewer |
| `connection_issue` | provider、auth、heartbeat、watchdog 或 connector 异常 | operator |

统一 source ref 为 `{ authority, local_id, source_state, resolution, correlation_refs[] }`。当前允许的 authority 与 source of truth：

| authority | 当前 authority | canonical projection |
| --- | --- | --- |
| `attention_inbox_items` | intake item 内容与 lifecycle | `new/failed -> open`；`triaged -> acknowledged`；`proposal_created -> waiting`；`actioned -> resolved`；`ignored -> dismissed` |
| `pi_guardian_alerts` | Guardian runtime alert 与 ack/resolve/suppress | `open -> open`；`acked -> acknowledged`；`resolved -> resolved`；`suppressed -> dismissed` |
| `pi_approval_requests` | permission request 与最终 decision | `pending -> waiting`；其他终态 `-> resolved` |
| `pi_actions` | internal Action Gate decision 与 execution audit | P11.03 起只投影需要决定的 active Action；终态仍由 Action audit detail 读取 |
| `issues` | 尚未迁入 Inbox 的 blocker/failure 事实 | 只读 compatibility projection；Issue status 仍是 Work authority |

Proposal 只作为 related ref/next action；Notification/outbox 只负责 delivery，均不得成为 Attention 状态 authority。连接异常当前由 Guardian carrier 承载，不再新建 connections alert 表。

## 3. dedupe 与 source resolution

`dedupe_key = owner scope + Attention type + strongest correlation`。correlation 强度固定为：

1. approval
2. Run / Run Group
3. connection
4. Issue / Work
5. conversation
6. 缺少上述 correlation 时退回精确 `authority:local_id`

因此，相同 Issue 上的 Guardian failure 与 Inbox failure 可以合并；同一 Issue 的 failure 与 approval 不合并；只有 project 相同、但没有更强 correlation 的不同来源也不合并，避免把项目内不同事故误关成一个事项。所有 key 由结构化字段确定，禁止 LLM 生成或覆盖最终 dedupe key。

合并项保留全部 source refs 和各自 source state。单个 source 终结时只更新对应 ref；**全部 active source 都进入 `resolved|dismissed` 后**，统一 projection 才自动进入 `resolved`（全部 dismissed 时进入 `dismissed`）。任何仍 active 的 source 都阻止自动 resolve，避免跨来源误关单。

## 4. 优先级表

优先级由 `type × severity` 确定，数字越小越先处理：

| type | critical | high | medium | low |
| --- | --- | --- | --- | --- |
| blocker | P0 | P1 | P1 | P2 |
| failure | P0 | P1 | P1 | P2 |
| approval_required | P0 | P1 | P2 | P3 |
| input_required | P0 | P1 | P2 | P3 |
| verification_required | P0 | P1 | P2 | P3 |
| connection_issue | P0 | P1 | P1 | P2 |

同优先级按 `created_at` 先后，再按 `dedupe_key` 稳定排序。每次确定性 escalation 提升一级，P0 封顶。默认 due window：P1 1 小时、P2 4 小时、P3 24 小时；P0 不再自动升级。有效 snooze 到期前不升级，终态不升级。

## 5. 生命周期与审计

| command | allowed result | gate |
| --- | --- | --- |
| acknowledge | `open/waiting -> acknowledged` | allowed deterministic policy 或 human approval |
| snooze | `open/acknowledged -> waiting` + future `snoozed_until` | allowed deterministic policy 或 human approval |
| resolve | 非终态 `-> resolved` | allowed deterministic policy 或 human approval |
| dismiss | 非终态 `-> dismissed` | allowed deterministic policy 或 human approval |
| escalate | status 不变，priority 提升，记录 count/time | allowed deterministic policy |
| source reconcile | 全部 source terminal 时自动 resolve/dismiss | **allowed deterministic policy only** |

每条 command 必须做 revision CAS；`deny/ask` 不能 mutation，terminal 状态不能重开。审计结果记录 before/after status、operation、actor、reason、gate、correlation/event ID、timestamp 和全部 source refs。后续 writer 必须把该审计合同落到现有 source event/audit carrier；不得只在 UI 或 LLM transcript 留痕。

## 6. source of truth、兼容、迁移与回滚

- **P08.07 G0/W0 基线：** 当时的四个 legacy carrier 各自保持唯一写 authority；P11.03 后 active `pi_actions` 也只作确定性 Attention projection，仍不复制 writer。`domain/attention` 是 read projection/command contract，双写为 0，runtime 双读为 0。
- **W1 shadow：** P08.09/P11 只能从 authoritative rows 构建可重建 projection，按 `dedupe_key/source_refs/status/priority` 做 deterministic parity。shadow failure 不得改 legacy source。
- **W2 cut read：** parity、source auto-resolve、restart recovery 和审计通过后，统一 Inbox 可先读 projection；legacy detail 仍按 source ref drill down。W1 + W2 最多两个连续正式 release，延期必须 superseding ADR。
- **G4 cut write：** 先收敛成一个 command seam，旧 route 翻译到该 command，再经非 LLM approval 切唯一 writer。不得先做多 carrier 双写后再找 authority。
- **回滚：** G4 前移除 projection reader/adapters 即恢复 legacy reads，零数据回滚；G4 后先停 target writer，按 audit correlation/cutover checkpoint 回放差异，确认不存在两个 writer 后才恢复 legacy writer。
- **最终删除门禁：** P08.08/P08.09、P10 restart invariants、P11.03 与 G7 完成；跨来源 dedupe/source resolve/approval decision/notification delivery parity 通过；一个正式 release legacy storage consumer-zero；fresh backup、隔离 restore、rollback rehearsal 和精确 destructive approval 全部有 Evidence。任一失败即保留旧 carrier，不新增第三条路径。

## 7. 最小验证

```bash
cd backend-ts
bun test src/domain/attention/contracts.test.ts
```

测试固定覆盖完整 priority table、不同来源 dedupe、legacy source/status 映射、ack/snooze/resolve/escalation 审计 gate，以及全部源对象解决后的自动 resolve。
