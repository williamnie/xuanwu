# ADR-XW-0037：Changed Files 与 Diff Summary

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P05.02 / Runner #673
- 硬依赖：XW P04.03 / #665（`done`）、XW P05.01 / #672（`done`）
- 可执行 builder：`backend-ts/src/domain/handoff/diffSummary.ts`
- canonical 级别：本文与 `HANDOFF_DIFF_SUMMARY_SCHEMA` 定义 Git Evidence 到 Handoff changed-files/summary/risk hints 的确定性 projection；Git repository 与 P04 Git Evidence 继续拥有事实，P05.01 `HandoffRecord` 继续拥有交付合同

## 1. 输入、authority 与边界

`buildHandoffDiffSummary()` 只接受 `passed + kind=git + system_observation + git_repository` 的 P04 Evidence。它不运行 Git、不读取 diff body、不写 repository/Issue/Work/Handoff，也不执行 commit、push、PR、通知或 tracker update。输入若是 agent/LLM claim、aggregate 与逐文件 stats 不一致、artifact 缺失或 sha256 不匹配，builder fail closed。

Git snapshot manifest v2 在原 changed paths/aggregate stats 上增加逐文件：

- `path`；
- tracked diff 的 `additions/deletions/binary`，untracked 或不在 numstat 的 path 保持 null；
- 当前 worktree `lstat` 的 `size_bytes`，删除文件、目录/submodule 或不可用值保持 null；symlink 不跟随 target。

Evidence fact JSON 超过 8 KiB 时仍复用 P04.03 content-addressed redacted artifact。builder 由调用方传入已解析范围内的 artifact 内容，并核对 Evidence artifact ref 的 sha256；不自行扫描 state dir。

## 2. Summary contract

`HANDOFF_DIFF_SUMMARY_SCHEMA_VERSION=1`，输出是可丢弃、可重建 projection：

| 区域 | 稳定合同 |
| --- | --- |
| provenance | `source_evidence_id`、`snapshot_sha256`、`detail_level=per_file_v2\|paths_only_v1` |
| changed files | byte-order 排序的 `changed_files`；按第一个 path segment 分组，root 文件固定为 `(root)` |
| diff stats | changed paths、tracked diff files、insertions、deletions、binary 和显式 nullable untracked count |
| notable files | tracked numstat 可证明的 binary paths；当前 worktree size 大于等于 5 MiB 的 large files；`handoff-generated-path:v1` path heuristic 命中的 generated paths |
| narrative | `summary` 与 aggregate-only `notification_summary` |
| handoff input | 与 P05.01 `HandoffRisk` 同形的 `risk_hints`；调用方仍须通过 Handoff validator/状态门禁，不能把 hint 当 allow 或 review decision |

binary path scope 固定为 tracked diff；large-file scope 固定为 snapshot 时仍存在的 worktree file；generated 是可审计的 path heuristic，不冒充 `.gitattributes` 或构建系统 authority。unknown 不转成 false/0。

## 3. 风险与用户摘要

builder 以稳定 ID 生成 `binary_diff`、`large_files`、`generated_files` 和 legacy metadata `file_metadata_unavailable` risk hints。风险正文只包含计数、缓解方式与 Evidence ref，不嵌入文件内容。

`notification_summary` 只含 changed count、总 insertions/deletions 与 binary/large/generated counts。它不包含 Evidence `excerpt`、diff body、artifact body、文件内容或逐 path 清单。通知 producer 只能选择该字段或同等更小的 allowlisted projection；不得对完整 summary object/Evidence/diff artifact 直接 `JSON.stringify` 后发送。

## 4. 兼容、迁移、回滚与删除门禁

- **source of truth：** Git repository 是 revision/tree/diff authority；P04 Git Evidence 是带 provenance 的 observation；本 summary 是 Handoff builder projection，不能反写 Git/Evidence/Work status。
- **本期写入：** Git manifest 从 v1 additive 升为 v2；没有新 DB/schema/API/public route/provider adapter，Handoff 无新持久化。本期双写窗口为 0。
- **兼容读：** 已存在的 inline/artifact manifest v1 继续作为 `paths_only_v1` 读取，保留 aggregate binary/stats，逐文件 binary/size 不猜测，并产生 `file_metadata_unavailable`。fresh v2 才能给 binary path 与 large-file 判断。
- **cutover：** P05.03/P05.08 接线时必须重新读取 authoritative Evidence、校验 snapshot/revision freshness，并把 `changed_files`、`summary`、`risk_hints` 交给 P05.01 validator；不得从旧 prose 或通知反推事实。
- **回滚：** 停止使用 v2 detail/summary builder，恢复 P04 path/aggregate Evidence reader；已有 Evidence/artifact 保留，不删除或反写 Git/raw event。
- **最终删除门禁：** 仅 P11.03/P11.06 + G7、所有 Evidence/Handoff/notification consumer 完成映射、legacy v1 consumer 连续一个正式 release 为零、fixture 与 artifact restore rehearsal 通过后，才能删除 v1 reader 或旧 projection。

## 5. 验证

```bash
cd backend-ts
bun test src/domain/evidence/gitCollector.test.ts src/domain/handoff/diffSummary.test.ts src/domain/handoff/contracts.test.ts
```

fixtures 覆盖 text、binary、large、generated、root/top-level grouping、untracked unknown、manifest v1/v2、artifact checksum、aggregate mismatch 与非 authority claim。另有断言证明完整 Evidence diff excerpt 不进入 `summary`、risk hints 或 `notification_summary`。
