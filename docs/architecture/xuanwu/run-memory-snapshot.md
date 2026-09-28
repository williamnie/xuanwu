# Run 经验快照（Issue #970）

复用 #969 的 `retrievePiMemoryContext` 和 #968 复盘形成的带来源经验，不新增工具、Provider、模型调用、权限或数据库 schema。

| 调用路径 | 行为 |
| --- | --- |
| `projectLoop → runIssueWithProvider` | 执行策略解析后、调用 Provider 前冻结快照并注入实际 Prompt |
| 验收继续/重试 → `recoverIssueWithProvider` / `runIssueWithProvider` | 按所创建的 Run 固定快照；同一 Run 再调用不会重新选择 |
| Pi 验收 → `runPiIssueAcceptance` | 使用完成卡中的精确 Run id，传入 runtime context；不以 Issue 最新 Run 偷换验收对象 |
| Pi 恢复 → `runPiSupervisorDecision` | 使用信号上下文中的 Run id，传入相同 runtime context |
| Supervisor resume / session steer | 在现有授权和生命周期校验后，将对应 Run 的快照与适用性复核加入发送给执行器的 Prompt |

`issue.run_memory_snapshot.v1` 是每个 Run 首次注入时冻结的有界事件。内容包含 id、修订号、内容指纹、经验版本、摘要正文（保留结构化经验中的条件/反例/验证/来源）、来源、选择阶段/原因和预算；快照另有 SHA-256 与事件引用。默认条目预算 900 tokens，沿用 #969 估算方法，固定规则与封装元数据另计。没有历史会话合并。

快照选择沿用 #969 的有界任务检索，不把 `text_candidate` 冒充 Pi 已做过语义筛选。Pi 与执行器仍须检查每项条件、版本、反例以及当前代码。无匹配时冻结空快照并保持原执行 Prompt；验收不会补进后来新增的记忆。升级前没有快照的 Run 显式标为 `not_captured`，只保留既有作用域偏好/策略投影，不补入技术经验；首次恢复注入则标为 `captured_for=recovery`，不追溯声称初始执行见过这些条目。

恢复和验收重新筛查快照条目：已停用/遗忘、修订或指纹变化、版本/条件不匹配的内容不再投影，只留下原身份和排除原因。原快照作为 Run 审计事实不改写。当前检索窗口之外的条目也保守排除，不能据此认定历史经验本身无效。通过 Host 文本筛选仅标为 `requires_current_fact_check`，不是语义批准。旧 Session 中曾注入但现已排除的经验也不得继续使用。

经验是待核实的数据。当前规范、代码、运行事实优先；历史验证不能证明本轮测试通过，也不能授予权限、修改流程或替代 Work 状态。现有 Action Gate、工具白名单及执行策略继续独立生效。

- `issue.run_memory_injected.v1`：只表示 Provider 输入已构造，保存快照引用、实际条目和 Prompt 段摘要；不证明模型收到、读过或采纳。
- `issue.run_memory_cited.v1`：执行器消息中显式输出 `MEMORY_REF: {"snapshot_id":"...","id":"...","revision":1,"content_fingerprint":"..."}`，Host 校验精确快照身份并去重后记录。普通工具输出不算引用。
- runtime context audit 带相同快照引用和复核结果。两类观察均为 `effectiveness=not_evaluated`，不增加记忆采纳次数，不用作进展、验收或收益证据。

本 Issue 仅做本地自动验证与独立 commit。正式项目启用、真实模型遵循情况和最终体验验收由 #973 完成。
