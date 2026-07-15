# XW P01.04：`issue.log` 生产端收敛与超大 payload

状态：accepted（2026-07-16）

依赖：XW P01.01（issue 637，`done`）、XW P01.02（issue 638，`done`）

## 1. 决策与边界

P01.01 已证明膨胀来自 runner 对每条 provider notification 逐行写入，并在同一行同时保存完整 `raw_payload` 与抽取后的 `text` / `command` / `payload`。本期不改 `providers/codex`、`providers/claude` 的 adapter 或公共 `ProviderEvent` contract，只在 `providerRuntime` → `issueEvents` 持久化边界收敛写入。

`issues`、`issue_runs`、`issue_events` 仍是唯一 timeline source of truth。Oversize artifact 是某条 `issue_events.payload` 的内容寻址扩展，不产生第二套 event identity、状态机或写入 authority；event ID、issue、时间和顺序仍只由 `issue_events` 决定。

## 2. 生产端规则

规则由 `backend-ts/src/runner/issueLogPersistence.ts` 确定性执行。原始 provider event 仍逐条进入 `onLog`、`onRuntimeEvent`；approval、Session lifecycle 和 terminal/Guardian 依赖的 decisive event 均不采样、不合并。只有高频 `issue.log` durable projection 被收敛。

### 2.1 Chunk 聚合

仅聚合 Codex 的连续文本 delta：

- `item/agentMessage/delta`
- `item/commandExecution/outputDelta`
- `item/fileChange/outputDelta`

provider、session、turn、method、type、command、path 必须全部相同。单 chunk 最多 64 个事件、32 KiB 文本；不同 key、100 ms idle、显式 flush 或 terminal event 会先落当前 chunk。聚合行保持原 `raw_method` 和拼接后的 `text`，并写入 `payload.aggregation=concatenated_delta`、`chunk_count`；逐 delta raw envelope 不再重复落盘。

Claude 当前 provider 在进程结束后按 stream-json record 产出完整 text/tool/result，不是 token delta；为了不误拼 content block，本期不合并 Claude record。其 payload 上限和 artifact 规则与 Codex 相同。

### 2.2 采样

仅采样可恢复的 R1 operational telemetry：

| raw method | 间隔 | 规则 |
| --- | ---: | --- |
| `turn/diff/updated` | 16 | 首条、每第 16 条、最后变化值 |
| `thread/tokenUsage/updated` | 20 | 首条、每第 20 条、最后变化值 |
| `turn/plan/updated` | 10 | 首条、每第 10 条、最后变化值 |
| `turn/taskProgress/updated` | 10 | 首条、每第 10 条、最后变化值 |

完全相同的采样 payload 不重复写。最后变化值在 terminal 前、显式 flush 或 2 秒 idle 时落盘。`done`、`error`、`turn/completed`、approval、item lifecycle、普通 text/tool 和未知事件不采样；因此 decisive output 与错误诊断不依赖概率或 LLM 判断。

## 3. Payload 上限与 artifact

`issue.log.payload` inline 上限为 64 KiB（UTF-8 bytes）。超过上限时：

1. 对完整 legacy JSON 计算 SHA-256；
2. 以 gzip level 9 写到 `<stateDir>/artifacts/issue-logs/<sha-prefix>/<sha>.json.gz`；
3. 同内容复用同一 content-addressed 文件，不重复写 blob；
4. DB 行保留 type/provider/raw method/status，以及有界的 text、command、path、error；error/failed 行额外保留有界 raw diagnostic；
5. DB 行写入相对 `ref`、原始/压缩 bytes、encoding 和 checksum。

Artifact 使用 state directory 内的相对路径，reader 拒绝绝对路径、反斜线和 `..`；解压后同时校验原始 bytes、SHA-256 和 JSON。文件缺失或校验失败时 fail soft：返回 DB 内的有界摘要，错误、状态和 artifact ref 仍可诊断，不让整个 issue timeline 不可读。

## 4. 兼容读取、新旧形态与回滚

- 历史 inline 行不迁移、不重写；`listIssueEvents()` 同时读取 legacy inline JSON 和 artifact-ref 行。
- Artifact 校验成功时，repository 返回原来的完整 JSON shape；Issue API、Session replay、Guardian/PI consumer 不需要认识 artifact schema。
- 直接 SQL consumer 只看到有界摘要，因此摘要固定保留 meaningful progress、terminal、provider error 所需的 decisive 字段。
- 没有双写：一个 event 只写一个 `issue_events` row；payload 要么 inline，要么由该 row 唯一引用一个 content-addressed artifact。
- 兼容双形态读取至少保留两个 release observation window，并且在全部历史 inline row 被独立、可回滚的 migration 处理前不得删除 legacy inline branch；本期不安排该 migration，因此当前 branch 没有可提前执行的删除日期。

回滚分两层：

1. 发现采样/聚合行为回归时，停止或回退 `issueLogPersistence`，但保留 `issueEvents` artifact reader；新写恢复逐 event，既有 artifact-ref 行仍可完整回放。
2. 一旦已有 artifact-ref 行，禁止直接降级到不认识该 ref 的旧 binary。若必须降级，先从当前 reader 或完整 stateDir 备份恢复 inline payload、校验 event ID/order/hash，再切旧 binary。

数据库备份从本期起必须同时包含 `<stateDir>/artifacts/issue-logs`；只有 `.db` 的副本仍能读取 decisive 摘要，但不是完整 payload 备份。

## 5. 删除门禁与可审计性

Artifact 写入由引用它的 `issue.log` row 审计；ref 不含绝对路径或敏感 preview。内容寻址允许跨重复 payload 复用，因此 issue delete 不能直接删除单个 artifact。

本期不删除历史行或 artifact。未来 GC 必须是独立 destructive migration，并同时满足：

- 全库 ref scan 证明零引用，且 active/failed run、pin/legal hold、Handoff Evidence 未受影响；
- backup 包含 DB 与 artifact，完成 checksum 和 clean restore rehearsal；
- Issue/Session/Guardian/PI activity 对 ID、order、decisive output 和错误诊断完成 parity；
- batch manifest、actor、reason、policy version、audit ref 和结果可审计；
- 至少两个 release observation window 无 missing/corrupt artifact；
- 有可执行 rollback，且 LLM 不能直接授权或扩大删除范围。

## 6. 验证基线

Focused tests 覆盖：513 个 message delta 的长 Session 回放、行数/bytes 对比、Codex telemetry 采样、Claude oversize output、content-addressed dedupe、缺失 artifact fallback、429 错误诊断、approval 与 terminal Guardian 回归。测试只使用临时 stateDir，不修改 live 数据。

同一确定性 fixture 的 before/after：

| 场景 | legacy baseline | 新写入 | 降幅 |
| --- | ---: | ---: | ---: |
| 513 delta + 1 terminal | 514 events / 72,985 payload bytes | 10 events / 7,825 bytes | events 98.05% / bytes 89.28% |
| 两条相同 220 KiB oversize error | 440,428 payload bytes | 33,660 inline + 417 artifact bytes | total bytes 92.26% |

长 Session fixture 逐字重放与 513 个输入 chunk 完全一致；oversize error 经 artifact hydrate 后仍识别 HTTP 429、`retry_after=120`，artifact 删除后有界摘要仍保留 429 分类与 terminal error。
