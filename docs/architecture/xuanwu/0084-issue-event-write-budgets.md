# ADR-XW-0084：Issue event 写预算与有界 artifact

状态：accepted（2026-07-20，MEM-05 / issue 766）

依赖：MEM-04 / issue 765 已 `done`；matching Evidence 为 `xw:evidence:issue_events:524896` 等 completion gate 输入，gate outcome event `524932` 为 `passed`。本项不删除或回写 live 历史 `issue_events`。

## 1. 根因与 authority

live 只读审计确认写放大来自 provider notification 在 `providerRuntime` 的逐事件 durable projection，而不是 SQLite freelist。`issue_events`、`issue_runs` 继续分别承担事件 identity/order 和 Run authority；artifact 只是某条 event payload 的内容寻址扩展，不建立第二个状态 authority，也不改变 public schema、route、provider adapter 或状态机。

`auditIssueEventRuns()` 按 Run、terminal status、event type、raw method 输出 rows、payload bytes、unique payload、duplicate rows/share。2026-07-20 live 样本的高位项包括：

- `issue-61-attempt-1` / done / command output delta：6,483 rows、9,157,405 bytes、97.9% duplicate rows；
- `issue-62-attempt-1` / done / command output delta：10,080 rows、9,134,475 bytes、65.4% duplicate rows；
- `issue-765-attempt-1` / pending_verification / diff：46 rows、1,943,239 bytes；
- 成功、失败、取消和 pending_verification 均存在超大 output delta，不能用 terminal status 推断可静默丢弃。

该审计只读 `issue_runs+issue_events`，不输出 payload 正文、不修改 live DB。

## 2. 每 Run 写预算

每次 `createIssueLogPersistence()` 对应一个 provider Run/恢复段。预算只治理未来 `issue.log` projection；`onLog` 与 `onRuntimeEvent` 仍收到原始逐事件流。

| 类别 | event/raw method | 每 Run/method 行预算 | 字节预算 | 溢出行为 |
| --- | --- | ---: | ---: | --- |
| delta | message / command / file output delta | 64 | 2 MiB text | 64-event / 32 KiB chunk；超出部分不再线性写行，写 `issue-log-budget-marker.v1`，最终状态由对应 `item/completed` 保留 |
| cumulative sample | diff / plan / progress / token usage | 64 | 单 event 受 inline/artifact 门禁 | 首条、间隔、最终变化值；为最终样本预留一行，溢出显式 marker |
| lifecycle snapshot | 已知 `item/started`、reasoning completed | 256 / method+item type | necessary snapshot | 去除重复 raw envelope；超限写 marker，只留 item id/type/phase/process id 与 normalized command/path/status |
| final/protected item | command/file/agentMessage completed、approval/unknown | 1,024 / method | 8 KiB 起按 method 外置；inline hard cap 64 KiB | 不采样；超限先写 marker 再 fail closed，使 Run 失败而非静默漏掉 final/Evidence |
| decisive terminal | error、turn terminal、Evidence/status/audit | terminal/error 不设 operational cap | inline hard cap 64 KiB，超限 artifact | 不合并、不采样；保持既有 authority 与审计顺序 |

Marker 固定记录 source method、category、persisted rows、omitted events/bytes、预算和 final carrier。它使 UI/诊断能区分“确无日志”和“有界截断”，禁止静默丢失。恢复会创建新的 persistence scope；失败/取消 terminal 与恢复后的事件各自保留。

## 3. Artifact、hash 与读取兼容

- 高放大 method payload 超过 8 KiB 即外置；其他事件继续使用 64 KiB hard cap。
- 完整 legacy JSON 经 gzip 写入 `artifacts/issue-logs/<sha-prefix>/<sha>.json.gz`，DB row 保留 relative ref、SHA-256、raw/stored bytes、encoding 与有界 decisive summary。同内容复用同一 hash 文件。
- 旧 inline row 原样读取；合法 artifact row 校验 relative path、stored bytes、gunzip bytes、SHA-256 和 JSON 后，hydrate 为旧 payload shape，UI timeline、日志、diff、最终消息、Evidence consumer 无需双读。
- ref malformed、文件缺失、bytes/hash/JSON 不符时，reader **fail closed**，不再把 bounded summary 冒充完整 payload；确定性创建/复用 `attention_inbox_items`，evidence ref 为 `issue_event:<id>:issue_log_artifact`，随后返回读取错误。
- state backup/restore 必须同时包含 DB 与 `artifacts/issue-logs`。只有 DB 的副本不再满足完整恢复。

## 4. Consumer zero-loss 清单

| Consumer | 依赖 | 治理后保证 |
| --- | --- | --- |
| Issue/Run UI、sessionObserver、projectSnapshot | text/command/path/status、顺序 | legacy hydrate shape；marker 可见；最终 agent message text 保留 |
| eventSummaryProjection、Work timeline、runtimeObservability | raw method、summary、source event id/hash | source row identity/order 不变；artifact 必须完整后才投影 |
| providerApprovalRequests | approval request/resolution | approval 不采样、不合并 |
| providerTerminalSignals、Guardian/recovery | error/turn completed/status | terminal/error 不采样；失败与取消回归覆盖 |
| providerErrorParser | raw diagnostic、status/error | error summary 与完整 artifact 均保留；hash 缺失 fail closed |
| completionGate runtime Evidence | command `item/completed`、correlation | command completed 不 compact raw；先持久化并 hydrate 后采集 Evidence |
| Handoff / verification | `issue.verification_*`、Evidence refs | 非 `issue.log` authority 完全不变 |
| live bus / runtime hooks | 原始逐 delta 流 | coalesce 只位于 durable write sink；hook 输入不变 |

Canonical machine-readable matrix 为 `issueEventRetentionMatrix()`；新增 method 默认不进入 compact 集合，继续 fail-safe 保留，需显式分类后才可治理。

## 5. Before/after DB 增长 benchmark

`issueLogStorageBenchmark.test.ts` 对完全相同的成功 Run fixture（4,096 message delta、1,024 diff、final item、terminal）分别执行 legacy 逐写与 bounded writer：

| 指标 | legacy | bounded | 降幅 |
| --- | ---: | ---: | ---: |
| `issue_events` rows | 5,122 | 131 | 97.44% |
| payload bytes | 724,103 | 77,333 | 89.32% |
| SQLite allocated growth | 1,081,344 | 102,400 | 90.53% |

超长 10,000 command deltas + 10,000 cumulative diff 的 focused test 证明每 method 不超过 64 data rows，随后只有显式 marker 与 decisive final/terminal；增长不再随每条 delta 线性增加。测试同时覆盖成功、provider error、取消、恢复新 stream、超大 command output、lifecycle snapshot、legacy inline、missing/malformed artifact Attention 和 content-addressed dedupe。

## 6. 兼容与 rollback

读兼容必须先于写治理回滚：

1. 若 coalesce/预算导致 UI 或恢复回归，可只回退 `issueLogPersistence`，恢复逐事件写；保留 artifact reader 与 Attention 逻辑，既有 ref 仍可读。
2. 不得直接部署不认识 artifact ref 的旧 binary。降级前必须从完整 state backup hydrate/校验回 inline，保持 event id/issue/time/order/hash；该 destructive migration 不属于 MEM-05。
3. artifact integrity failure 先从 verified backup 恢复并核对 SHA-256，再重试读取；不得绕过校验或把摘要当完整输出。
4. 本项不改 live 历史 row、不 GC artifact、不 VACUUM。未来删除仍须独立 consumer-zero、backup/restore、manifest、non-LLM approval 与 rollback gate。
