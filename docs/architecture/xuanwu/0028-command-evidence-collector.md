# ADR-XW-0028：Shell / Test / Lint / Build Evidence collector

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P04.02 / Runner #664
- 依赖：[ADR-XW-0027](0027-evidence-domain-contract.md)
- 可执行 collector：`backend-ts/src/domain/evidence/commandCollector.ts`
- canonical 级别：本文定义 command observation 到 `EvidenceRecord` 的收集边界；Evidence schema、状态与 provenance 规则继续以 ADR-XW-0027 和 `contracts.ts` 为准

## 1. 当前运行态与边界

Runner 当前从 provider 的 command completion observation 得到 `command`、`cwd`、`status`、`exitCode`、`durationMs` 与完整/聚合输出，并把原始 observation 作为 `issue.log` 保存。PI 的 `VerificationEvidenceV0` 仍是兼容 payload，不包含 signal、timeout、环境指纹或确定的 output overflow 合同。

P04.02 增加一个显式、provider-neutral 的 collector，把**已经发生且由 runner/tool 观察到的命令结果**投影为 P04.01 `EvidenceRecord`。collector 不执行 shell、不修改 Issue/Work/Run 状态、不自动把所有 Agent 探索命令当成验证，也不根据命令文本猜测 test/lint/build。调用方必须在确定性 workflow/verification step 中明确选择 `shell | test | lint | build` 并提供 provenance/audit ref。

这保证 Agent narrative、issue comment 或命令字符串中的 “passed” 不能覆盖真实 exit/timeout/signal。

## 2. Collector interface

`CommandEvidenceCollector.collect()` 接受：

- `kind`：`shell | test | lint | build`；
- `observation`：command、cwd、start/end、duration、exit code、signal、timeout、stdout/stderr；
- `environment`：platform、architecture、runtime name/version、shell 和环境变量**名称集合**；省略时读取 runner 当前进程环境；
- `context`：Evidence/Work/Run/Attempt ID、producer、source ref、audit event ref 与 collected timestamp；
- 可选 success exit code 集合、已有 artifact refs。

输出始终通过 `validateEvidence()`。确定性结果映射为：

| observation | Evidence status | `facts.outcome` |
| --- | --- | --- |
| 未 timeout、无 signal、exit 属于 success set | `passed` | `passed` |
| 非 success exit | `failed` | `exit_nonzero` |
| timeout | `failed` | `timeout` |
| signal termination | `failed` | `signal` |
| 无 exit、无 timeout、无 signal | `blocked` | `missing_exit` |

timeout/signal 优先于 exit code，防止 kill race 中迟到的 `0` 被误判为通过。`test/lint/build` provenance 分别使用 `test_runner/linter/build_system`；shell 使用 `command_execution`，assertion origin 固定为 `tool_result`。

## 3. Decisive output 与 overflow

Evidence inline 只保存：

- command、normalized cwd、exit、duration、signal/timeout、stdout/stderr byte counts；
- outcome 与一段 UTF-8 安全、默认最多 4 KiB 的 decisive tail；
- environment fingerprint；
- output 是否 overflow。

完整 transcript 超过默认 8 KiB，或 command/cwd 超过 schema scalar 上限时，collector **必须**得到 `CommandEvidenceArtifactStore`。没有 store 就失败，不允许静默截断后仍产生 passed Evidence。

`FileSystemCommandEvidenceArtifactStore` 提供当前本地实现：

- 写入 `artifacts/evidence-command-output/<sha-prefix>/<sha256>.log`；
- content-addressed、原子 rename、目录 `0700`、文件 `0600`；
- 写前对 command/output 做统一 redaction，Evidence ref 记录 media type 与 sha256；
- store 校验 bytes/digest，collector 再校验返回 artifact checksum。

Artifact ref 不等于永久可用保证；retention/hold/restore 与后续 Evidence API 仍由 artifact authority 管理。P04.06 policy 在需要 artifact availability 时必须显式验证，不能只看 Evidence status。

## 4. Environment fingerprint 与跨平台路径

fingerprint 对以下 canonical JSON 做 SHA-256：platform、architecture、按 observation platform 语义 normalized cwd/shell、runtime name/version，以及排序去重后的非敏感环境变量名称。它不采集环境变量值，也排除 token/secret/password/key/auth 类变量名。

路径 normalization 明确使用：

- `win32` observation：`node:path.win32`；
- 其他 observation：`node:path.posix`。

因此在 macOS/Linux runner 上处理 `C:\\workspace\\repo` 时不会把反斜杠误当普通字符，也不会把 Windows path 转成宿主 POSIX path。fingerprint 是环境比较依据，不是机器身份或 credential。

## 5. Source of truth、兼容与迁移

- **事实 source of truth：** 真实 command process/provider completion observation 与其 raw/full-output artifact；structured Evidence 是带 provenance 的标准化记录，不反向改写原 observation。
- **W1 写入：** 新 verification step 只产生一条 structured record，并用 `source_ref/audit_event_ref` 指向原 observation；不得把同一事实再复制成竞争 authority。当前所有探索性 `issue.log` 不批量回填。
- **兼容读取：** `VerificationEvidenceV0` 继续只经 `legacyAdapter.ts` projection；它保持 `legacy_import`，即使 status=passed 也不能升级成 tool proof。W1/W2 双读总期限仍按 ADR-XW-0027，最多两个正式 release window。
- **回滚：** 停用 command collector/policy consumer，恢复 V0/current event/command 读取；保留已生成的 additive Evidence、audit 和 artifact，不反写、不删除。
- **最终删除门禁：** 仍是 P11.03/P11.06 + G7、所有 provenance/audit consumer 映射完成、legacy consumer 连续一个正式 release 为零、contract fixture 与 artifact/raw-event 恢复演练通过。本 issue 不删除 `issue.log`、V0 或 provider raw event。

P04.07 才负责把 policy 接入 done 状态 mutation；P04.09 才负责持久化/API/UI read path。本 collector 自身不能绕过完成门禁或 deterministic permission gate。

## 6. 验证

```bash
cd backend-ts
bun test src/domain/evidence/commandCollector.test.ts src/domain/evidence/contracts.test.ts
bunx tsc --noEmit --pretty false
```

Fixtures 覆盖四种 kind、通过、非零失败、超时、signal、缺失 exit、超大输出/真实 artifact/redaction、无 store 拒绝、POSIX/Windows path 与稳定 environment fingerprint。
