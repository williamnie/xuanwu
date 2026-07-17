# XW P06.11 — Release、Research 与 Migrate Workflows

## 决策

本阶段注册三个固定 revision 的内建 Workflow：

- `workflow:release@1`：冻结 revision 与 readiness Evidence，经外部写审批后发布，并把发布 receipt 与 release rollback 写入 Handoff。
- `workflow:research@1`：只读收集来源，把每条结论映射到具体 source Evidence，再交付研究报告。
- `workflow:migrate@1`：冻结 source/target contract，经 target write 审批后执行跨仓库迁移，并验证目标 revision。

三个 Workflow 复用现有 Workflow Registry、P04 Evidence 和 P05 Handoff。没有新增第二套 Issue、Run、Evidence、Handoff 或 provider 状态机，也不直接调用真实外部系统。

## 确定性门禁

### Release

`publish` 是 `dangerous` stage，使用 `before_external_write`。Handoff 中所有 `classification=destructive` 的 action 必须同时满足：

1. `gate.authority=human_approval`；
2. `gate_decision=allow`；
3. 结果具备可审计 `audit_event_ref` 与成功后的 `after_ref`。

LLM 只能提出发布意图，不能自行生成 allow 决策。完成 Release 还必须通过 `verification-policy:release-readiness@1`，并保留 available、带引用的 release rollback。

### Research

Research 四个 stage 全部是 read-only。source locator、retrieval time、Evidence id 和报告 claim 的 source id 必须形成闭环；URL 来源只接受 HTTP/Browser Evidence，repository/file 来源只接受 Git/Shell Evidence。报告审计固定要求 state mutation、external write 和 destructive operation 均为空。

### Migrate

`apply` 使用 `before_stage`，target write receipt 必须来自 `human_approval` allow。Source/target repository、revision、contract ref、contract digest 和 path mapping 都必须冻结；target Handoff 必须指向同一 revision，并保留 rollback checkpoint。

## Source of truth 与迁移窗口

- Release：Git revision、P04 Evidence、外部发布 receipt 各自对自己的事实负责；P05 Handoff 只聚合交付，不反向伪造发布成功。
- Research：P04 Evidence 是来源观察的 authority；Research report 是带引用 projection，不是新的来源存储。
- Migrate：在正式 cutover 前，source repository 是唯一 source of truth，target 只是 derived projection。
- 双写：0。Workflow 不写回 source contract，也不同时维护两套 authority。
- 双读：仅 bounded validation window。只允许在一次 Migrate Run 内比较 source snapshot 与 target verification；不引入长期 fallback read。

兼容窗口最多跨两个正式 release window。旧调用方仍可按 exact manifest ref 使用现有 Investigate/Implement/Repair/Review；三个新 Workflow 不改变公共 manifest schema、状态词汇或 provider adapter contract。

## 回滚

- Release：按 Handoff 的 release rollback plan 与 refs 恢复上一已知健康 release，再采集新的 P04 Evidence；回滚本身若 destructive，仍须独立 human approval。
- Research：只移除未交付的 report projection，不删除来源 Evidence。
- Migrate：只根据 execution/Handoff 共同引用的 checkpoint 恢复本次映射过的 target paths；source repository 不受影响。

任何 rollback blocked 状态都必须带风险与原因，不能把 Work 标记完成。

## 最终删除门禁

只有同时满足以下条件，才可删除旧 Workflow revision、adapter 或 source contract：

1. bounded compatibility window 已结束，且无 Work/Run snapshot 引用旧 revision；
2. 所有交付已存在可读 Evidence 与 Handoff；
3. Migrate 已由人工批准 cutover，target contract 连续两个 release window 验证通过；
4. rollback rehearsal 通过，且无 rollback checkpoint 或未完成 Handoff 仍依赖待删对象；
5. 删除动作本身通过独立 destructive approval 并落审计事件。

本 issue 不执行 cutover、真实 release、远端写入或最终删除。
