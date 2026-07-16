# ADR-XW-0033：Evidence Policy 完成门禁

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P04.07 / Runner #669
- 依赖：P02.03、P04.02、P04.06
- 可执行实现：`backend-ts/src/domain/evidence/completionGate.ts`

## 1. 决策

`done` 不再等价于 Agent 的完成声明。现有 `PATCH /api/issues/:id {status:"done"}`、PI executor completion 与 PI state repair 的 `done` 请求必须进入同一个确定性 completion gate：

1. 把 authoritative Issue 投影为 `Work(xw:work:issues:<id>)`；
2. 把当前 Run 内由 Runner 实际观察到的单条 `test|lint|build` command completion 交给 P04.02 command collector，生成 P04.01 `EvidenceRecord`；
3. 由 P04.06 evaluator 执行 `verification-policy:agent-execution-contract@1`；
4. `passed|overridden` 才沿 `in_progress -> pending_verification -> done` 完成；缺失 Evidence 保持/进入 `pending_verification`；决定性失败或 invalid policy 进入 `failed`，并由既有 Work Board/Attention/Guardian 视图解释为 needs-attention，不增加平行 `needs_attention` Work status；
5. Work transition 继续消费当前 acceptance version、被 policy 选中的 passed Evidence，以及本次 legacy completion request 对应的 `ready` derived Handoff。P05 落地前不新建第二套 Handoff storage。

任意 issue comment、Agent summary、`issue.verification_report`、`VerificationEvidenceV0` 或只写了 `tests passed` 的 error 文本都不能满足 V1 policy。成功 Run 也不自动等于 Work `done`。

## 2. Runner 与人工验证

Runner completion adapter 只识别当前 Run 内、带真实 terminal `exitCode` 的单条 verification command。读取/搜索命令、文件名里的 `.test`、复合多命令和无法绑定当前 Run 的记录不会被猜成 passed Evidence。原始 command observation 仍由 `issue.log`/provider event authority 持有；W1 Evidence 是 completion 时的确定性投影，不反写原始日志。

`POST /api/issues/:id/verification` 保留 `accept|reject|request_changes`：

- `accept` 是 authenticated manual override，生成绑定精确 Work、policy revision、risk 和 audit ref 的 human Evidence；evaluator 结果必须明确为 `overridden`，不能伪装成 `passed`；
- `reject` 进入 `failed`，`request_changes` 回到 `triage`，继续使用既有 `issue.verification_reviewed` 审计；
- forbidden risk 仍由 policy fail closed，LLM 生成 comment/reason 不能构成 user attestation。

## 3. 审计与幂等

每次 completion mutation 在同一 SQLite transaction 内写入：

1. `issue.verification_gate_intent.v1`：actor、correlation、policy ref 与完整 snapshot、input Evidence ids、manual override ref、request fingerprint；
2. authoritative Issue status change；
3. `issue.verification_gate_outcome.v1`：完整 evaluator result、projection errors、target status 与实际 transition path。

人工 accept 另写 `issue.verification_human_evidence.v1`，保存 human Evidence 与 audit binding。相同 fingerprint/target 的重放读取已有 outcome；状态写、PI run-group 同步和审计 outcome 不分裂成两个 authority。所有 permission/PI action gate 仍在外层生效，verification passed 不能授权外部写或 destructive action。

## 4. Source of truth、兼容与迁移

| 窗口 | authority / 行为 |
| --- | --- |
| W1（P04.07–P04.08） | `issues` 仍是 Work status write authority；`works` 仍为 shadow/compatibility target。P04.01 Evidence contract 与 P04.06 policy 是 verification 语义 authority；当前 Run 的 `issue.log` command observation 只在 gate 时投影，legacy verifier report 仅展示/parity |
| W2（P04.09 起，最多两个正式 release window） | structured Evidence/policy repository/API primary；W1 on-demand projection 只作带 provenance 的 compatibility read/parity |
| W3 | structured-only completion consumer；legacy report/V0/raw event 按 retention/audit 保留，不再参与 gate |

- **schema/public route：** 本期不新增 table、column、status 或 route；现有 Issue/verification route 调用同一 completion command，避免第二次状态写。
- **双写期限：** 本期没有 Evidence 双主；W1/W2 compatibility 总窗口最多两个正式 release，延期必须有 superseding ADR、owner 和退出日期。
- **回滚：** 停用 completion consumer，恢复旧 Issue completion caller；保留 additive intent/outcome/human-evidence events，不能删除或把它们反向改写成 legacy report。回滚不迁移、不 drop table。
- **最终删除门禁：** 仅 P11.03/P11.06 在 G7、P04.09 repository/API、Workflow Registry、Guardian/PI consumer 映射完成，legacy producer/consumer 连续一个正式 release 为零，override 抽审和 artifact restore 演练通过后，才能删除 W1 projection/V0 compatibility path。

## 5. 验证

Focused regression 必须至少证明：

- 没有 trusted Evidence 的 runner `done` 请求进入 `pending_verification`；
- 当前 Run 的 passed test Evidence 可完成，failed Evidence 进入 `failed`；
- legacy verifier report/Agent narrative 不能关闭 Work；
- manual accept 产生 `overridden` 和完整 override audit，reject/request-changes 保持旧行为；
- PI state repair 不能用 legacy evidence_refs 绕过 gate。
