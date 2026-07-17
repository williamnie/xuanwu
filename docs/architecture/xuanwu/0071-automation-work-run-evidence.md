# ADR-XW-0071：Automation 执行接入 Work、Run、Evidence 与 Handoff

- 状态：Accepted（P08.04 / G0-W0 native execution composition）
- 依赖：ADR-XW-0013（Work command）、P03.05 Run service、ADR-XW-0049（Workflow Registry）、ADR-XW-0063（Automation scheduler）
- 实现：`automationRuntime.ts`、`automationWorkRunExecutor.ts`、`automation_execution_links`

## 决策

实际启动的 schedule layer 为 native Automation 构造一次 production executor。该 executor 使用全部内建 Workflow contribution、当前 Tool/Skill Registry 与 Agent Profile snapshot 组装真实 Workflow Registry，再按 Automation mode 分发：

- `observe`：创建来源关联的 Work/Run，记录 blocked Evidence 与 draft Handoff，并把 Automation run 终结为 `skipped`；不调用 provider。
- `propose`：以已创建的 Work/Run 作为提案交付，记录 passed Evidence 与 ready Handoff；不把提案等同于目标工作已经完成。
- `execute_allowed`：通过既有 provider runtime 执行 exact Workflow revision，沿用 project/profile 的 sandbox 与 approval policy；prompt 明确禁止绕过 Workflow stage 的确定性权限和审批门禁。

同一 `automation_run_id` 只允许一条 `automation_execution_links`。失败重试复用同一 Issue-backed Work 和 issue Run，每次 attempt 追加独立 Evidence/Handoff；重复 due scan 由 Automation idempotency key 与 lease claim 拦截，不创建第二套历史。

## Authority 与来源追溯

- `automation_definitions`、`automation_runs`、`automation_run_events` 是 definition、trigger slot、lease、retry 与 Automation terminal outcome 的唯一 authority。
- `issues` 与 `issue_runs` 继续分别作为 Work 与 engineering Run 的 write authority；P04/P05 repository 继续作为 Evidence/Handoff authority。
- `automation_execution_links` 只保存上述 authority 之间的稳定关系，不拥有状态，不反向推导或改写 Automation lease。
- Work provenance 固定引用 `automation_definitions` 和 `automation_runs:<run_id>`；Evidence/Handoff 同时引用相同 Automation run 和 canonical Work/Run id，形成可读 history links。

## 兼容、迁移与回滚

本期只启用 native `automation_definitions` 的执行 composition。`cron_tasks`、`pi_automations`、heartbeat、watch 和 notification 继续由各自现有 carrier 负责；不双读、不双写，也不从 legacy log 伪造 Work/Run。W0 dual-read/dual-write 均为 0。

回滚只需移除 schedule layer 的 native executor registration；既有 Automation run、execution link、Work/Run、Evidence/Handoff 必须保留审计，不回写或删除 legacy carrier。后续迁移窗口最多跨两个正式 release，且每个 legacy producer 必须先完成 cursor parity、来源关联和 rollback rehearsal。

最终删除 legacy carrier 或 compatibility projection 前必须同时满足：连续两个 release 无 legacy producer/consumer、所有历史 Automation run 均可追到 Work/Run/Evidence/Handoff、重启与 retry parity 通过、备份恢复演练通过，并由非 LLM 的 destructive gate 独立批准。
