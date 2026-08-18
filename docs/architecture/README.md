# 玄武 canonical 架构文档索引

- 状态：Canonical
- 日期：2026-07-27
- 路线 issue：XW P11.08 / Runner #743
- 硬依赖：XW P00.01 / #631、XW P10.12 / #735（均为 `done`）

## 1. 使用规则

1. 当前产品与工程规范只从本索引列出的 canonical 文档进入；`docs/architecture/xuanwu/` 中的编号文档按主题定义当前合同。
2. `docs/architecture/` 顶层旧设计、评审、roadmap、research、snapshot、draft 和 completed migration plan 均为历史记录。它们保留决策 provenance，但不再授权新实现、schema/route 复制或 destructive migration。
3. `.private-notes/**` 是本机私有草稿，永远不是仓库规范或迁移依赖。私有笔记引用旧 PI/OpenClaw 路线或已完成 issue 时，必须回到本索引和当前代码复核。
4. 路线依赖、阶段门禁与 destructive precondition 的 machine-readable authority 是 [`xuanwu-migration/plan.json`](xuanwu-migration/plan.json)；说明见 [`xuanwu-migration/README.md`](xuanwu-migration/README.md)。
5. 文档描述合同，当前执行事实仍须以 live runtime、当前代码、迁移与审计 Evidence 复核；发现漂移时更新 canonical 文档，不得让历史记录重新成为第二 source of truth。

## 2. 当前 source of truth

| 主题 | canonical 入口 |
| --- | --- |
| 产品定位、术语、Golden Journey、核心对象 | [0088、0001–0005](#foundation) |
| Issue/Event 存储与保留 | [0006–0009](#foundation) |
| Work | [0011–0019](#work) |
| Run / Attempt / provider lifecycle | [0020–0026](#run) |
| Evidence / verification | [0027–0035](#evidence) |
| Handoff / delivery | [0036–0043](#handoff) |
| Supervisor、Workflow、Skill 与产品导航 | [0044–0059](#supervisor-workflow-skill) |
| Automation、Attention 与 Approval | [0060–0063](#automation-attention-approval) |
| Channel、Connector、安全、可靠性与退出迁移 | [0064 及以后](#connector-security-reliability-retirement) |
| IM 上下文预算、工具按需加载与 PI Session 自动换代 | [0092](xuanwu/0092-im-context-budget-and-session-rollover.md) |
| 发布、升级、回滚与操作命令 | 根 [`README.md`](../../README.md)、[`docs/runbooks/`](../runbooks/) |
| 迁移 DAG 与门禁 | [`xuanwu-migration/README.md`](xuanwu-migration/README.md)、[`plan.json`](xuanwu-migration/plan.json) |

### Foundation

- [ADR-XW-0088：常驻无人值守的 AI 工程控制面定位](xuanwu/0088-always-on-product-positioning.md)
- [ADR-XW-0001：玄武产品定位、用户承诺与非目标（产品类别表述已被 0088 supersede）](xuanwu/0001-product-positioning.md)
- [ADR-XW-0002：玄武品牌术语与兼容标识合同](xuanwu/0002-brand-terminology.md)
- [ADR-XW-0003：六条 Golden Journey 端到端验收合同](xuanwu/0003-golden-journey-contracts.md)
- [ADR-XW-0004：Work、Run、Evidence、Handoff、Attention、Automation 核心对象合同](xuanwu/0004-core-domain-objects.md)
- [ADR-XW-0005：现有能力 keep / merge / migrate / delete 清单](xuanwu/0005-capability-disposition-inventory.md)
- [XW P01.01：`issue_events` / `issue.log` 存储审计](xuanwu/0006-issue-events-storage-audit.md)
- [XW P01.02：事件保留、摘要、归档与删除策略](xuanwu/0007-event-retention-policy.md)
- [XW P01.04：`issue.log` 生产端收敛与超大 payload](xuanwu/0008-issue-log-persistence.md)
- [XW P01.05：事件摘要 projection 与游标重建](xuanwu/0009-event-summary-projection.md)
- [Sessions CSS ownership 与视觉基线](xuanwu/0010-sessions-css-ownership.md)

### Work

- [ADR-XW-0011：Work Ledger 领域合同与状态机](xuanwu/0011-work-ledger-domain-contract.md)
- [ADR-XW-0012：Work Ledger 持久化结构](xuanwu/0012-work-ledger-schema.md)
- [ADR-XW-0013：Work Ledger repository 与事务服务](xuanwu/0013-work-ledger-repository-service.md)
- [ADR-XW-0014：Issue → Work 兼容适配器](xuanwu/0014-issue-work-compatibility-adapter.md)
- [ADR-XW-0015：PI carrier → Work 关系兼容适配器（已退役）](xuanwu/0015-pi-work-relation-adapter.md)
- [ADR-XW-0016：Work HTTP API 与兼容 authority](xuanwu/0016-work-http-api.md)
- [ADR-XW-0017：Work timeline 与统一事件视图](xuanwu/0017-work-timeline.md)
- [ADR-XW-0018：Work backfill、双读一致性审计与回滚](xuanwu/0018-work-backfill-dual-read.md)
- [Work Board 与 Issues 兼容入口](xuanwu/0019-work-board-compatibility.md)

### Run

- [ADR-XW-0089：Provider Core 多 Coding Agent 重构计划（Proposed）](xuanwu/0089-provider-core-multi-code-agent-refactor-plan.md)
- [ADR-XW-0020：Run / Attempt 生命周期合同](xuanwu/0020-run-attempt-lifecycle-contract.md)
- [ADR-XW-0021：Run / Attempt 关联字段与迁移](xuanwu/0021-run-attempt-relations.md)
- [ADR-XW-0022：Codex / Claude provider Run event contract](xuanwu/0022-provider-run-event-contract.md)
- [ADR-XW-0023：Run retry / resume / interrupt / supersede command service](xuanwu/0023-run-lifecycle-command-service.md)
- [ADR-XW-0024：Run list / detail / control HTTP API](xuanwu/0024-run-http-api.md)
- [ADR-XW-0025：Run progress read projection 与紧凑时间线](xuanwu/0025-run-progress-projection.md)
- [ADR-XW-0026：Runs 主视图与 Sessions 兼容入口](xuanwu/0026-runs-compatibility-view.md)

### Evidence

- [ADR-XW-0027：Evidence 结构、状态和来源合同](xuanwu/0027-evidence-domain-contract.md)
- [ADR-XW-0028：Shell / Test / Lint / Build Evidence collector](xuanwu/0028-command-evidence-collector.md)
- [ADR-XW-0029：Git 状态、Diff 与 Revision Evidence collector](xuanwu/0029-git-evidence-collector.md)
- [ADR-XW-0030：HTTP/API Evidence verifier](xuanwu/0030-http-api-evidence-verifier.md)
- [ADR-XW-0031：Browser / Visual Evidence verifier](xuanwu/0031-browser-visual-evidence-verifier.md)
- [ADR-XW-0032：Workflow Verification Policy](xuanwu/0032-workflow-verification-policy.md)
- [ADR-XW-0033：Evidence Policy 完成门禁](xuanwu/0033-evidence-policy-completion-gate.md)
- [ADR-XW-0034：Verifier Agent 结构化审查输出](xuanwu/0034-structured-verifier-review.md)
- [ADR-XW-0035：Evidence API 与用户可读证据界面](xuanwu/0035-evidence-api-user-interface.md)

### Handoff

- [ADR-XW-0036：Handoff 与 Delivery 状态合同](xuanwu/0036-handoff-delivery-contract.md)
- [ADR-XW-0037：Changed Files 与 Diff Summary](xuanwu/0037-handoff-diff-summary.md)
- [ADR-XW-0038：本地 Branch 与 Commit Handoff](xuanwu/0038-local-branch-commit-handoff.md)
- [ADR-XW-0039：Remote Push 与 Pull Request Provider 合同](xuanwu/0039-remote-git-provider-contract.md)
- [ADR-XW-0040：GitHub / GitLab Handoff Adapters](xuanwu/0040-github-gitlab-handoff-adapters.md)
- [ADR-XW-0041：Tracker Update Handoff](xuanwu/0041-tracker-update-handoff.md)
- [ADR-XW-0042：Reviewer Loop 与修改回路](xuanwu/0042-reviewer-loop.md)
- [ADR-XW-0043：Handoff API、页面与交付通知](xuanwu/0043-handoff-api-page-notification.md)

### Supervisor, Workflow, Skill

- [ADR-XW-0044：Supervisor 角色与系统 Prompt 合同](xuanwu/0044-supervisor-role-prompt-contract.md)
- [ADR-XW-0045：Supervisor Runtime 受控资源装配](xuanwu/0045-supervisor-runtime-resource-assembly.md)
- [ADR-XW-0046：Supervisor Intent Router](xuanwu/0046-supervisor-intent-router.md)
- [ADR-XW-0047：Supervisor 项目、Work 与会话上下文解析器](xuanwu/0047-supervisor-context-resolver.md)
- [ADR-XW-0048：Issue Tracker 双向同步](xuanwu/0048-issue-tracker-bidirectional-sync.md)
- [ADR-XW-0048：Supervisor Work / Run / Evidence / Handoff 控制工具](xuanwu/0048-supervisor-domain-control-tools.md)
- [ADR-XW-0049：Workflow Manifest 与 Registry](xuanwu/0049-workflow-manifest-registry.md)
- [玄武产品导航与兼容路由合同](xuanwu/0050-product-navigation-compatibility.md)
- [Command Center 聚合 API 合同](xuanwu/0051-command-center-summary-api.md)
- [ADR-XW-0052：Supervisor Planner 与 bounded Work 分解](xuanwu/0052-supervisor-work-planner.md)
- [Supervisor Goal、Commitment 与会话连续性](xuanwu/0053-supervisor-goal-commitment.md)
- [ADR-XW-0054：Investigate 只读调查 Workflow](xuanwu/0054-investigate-workflow.md)
- [ADR-XW-0055：Implement 工程执行 Workflow](xuanwu/0055-implement-workflow.md)
- [ADR-XW-0056：Repair 与 Review Workflows](xuanwu/0056-repair-review-workflows.md)
- [XW P06.11：Release、Research 与 Migrate Workflows](xuanwu/0057-release-research-migrate-workflows.md)
- [ADR-XW-0058：可执行 Skill Runtime 与权限审计](xuanwu/0058-executable-skill-runtime.md)
- [Provider 推荐卡片与连接合同](xuanwu/0059-provider-presets-connections.md)

### Automation, Attention, Approval

- [ADR-XW-0060：Cron、PI Automation、Heartbeat 与 Watch 统一语义](xuanwu/0060-automation-semantics.md)
- [ADR-XW-0061：统一 Attention 模型和优先级规则](xuanwu/0061-unified-attention-model.md)
- [ADR-XW-0062：统一 Automation 模型与持久化](xuanwu/0062-automation-model-persistence.md)
- [ADR-XW-0063：Approval 模型、权限矩阵与确定性 Action Gate](xuanwu/0063-approval-action-gate.md)
- [ADR-XW-0063：Automation 调度 claim、恢复与退避](xuanwu/0063-automation-scheduler-recovery.md)

### Connector, Security, Reliability, Retirement

- [ADR-XW-0064：Channel 与 Connector 统一契约](xuanwu/0064-channel-connector-contract.md)
- [ADR-XW-0065：CLI 与签名 Webhook Channel Adapter](xuanwu/0065-cli-webhook-channel-adapter.md)
- [Supervisor 与 Workflow Evaluation Harness](xuanwu/0065-supervisor-workflow-evaluation-harness.md)
- [ADR-XW-0068：OpenClaw Gateway 可选适配](xuanwu/0068-openclaw-gateway-adapter.md)
- [ADR-XW-0069：重启恢复与一致性不变量](xuanwu/0069-restart-recovery-invariants.md)
- [数据库迁移演练与兼容门禁](xuanwu/0070-db-migration-rehearsal-gate.md)
- [ADR-XW-0071：Automation 执行接入 Work、Run、Evidence 与 Handoff](xuanwu/0071-automation-work-run-evidence.md)
- [ADR-XW-0072：Heartbeat 与 Standing Orders](xuanwu/0072-heartbeat-standing-orders.md)
- [ADR-XW-0072：威胁模型与 Prompt Injection 防线](xuanwu/0072-prompt-injection-defense.md)
- [ADR-XW-0073：统一 Secret 生命周期与脱敏注册表](xuanwu/0073-secret-lifecycle-redaction.md)
- [ADR-XW-0074：Completion、Failure 与 Thread Watch Automation](xuanwu/0074-watch-automation.md)
- [ADR-XW-0075：统一通知 Intent、Outbox 与 Daily Digest](xuanwu/0075-unified-notification-outbox.md)
- [ADR-XW-0076：Connector Health、Secret 引用与诊断](xuanwu/0076-connector-health-secrets-diagnostics.md)
- [ADR-XW-0077：Feishu 迁移到统一 Channel / Connector 契约](xuanwu/0077-feishu-channel-connector-migration.md)
- [ADR-XW-0077：生产 Skill/MCP fixture 退出](xuanwu/0077-production-fixture-retirement.md)
- [ADR-XW-0078：统一运行可观测性、成本与诊断包](xuanwu/0078-runtime-observability-diagnostics.md)
- [ADR-XW-0079：PI Action、Proposal、Approval 与 Attention 决策层收敛](xuanwu/0079-pi-decision-layer-consolidation.md)
- [ADR-XW-0080：旧 Inbox、Approval、Activity 与 Settings 占位入口退出](xuanwu/0080-placeholder-route-retirement.md)
- [ADR-XW-0081：Issues/Sessions 用户路由退役与 compat v1](xuanwu/0081-issues-sessions-route-retirement.md)
- [ADR-XW-0082：用户可见命名迁移与内部兼容清单](xuanwu/0082-user-facing-naming-migration.md)
- [ADR-XW-0083：legacy/compat 引用审计与通知单写路径收敛](xuanwu/0083-legacy-compat-notification-cleanup.md)
- [ADR-XW-0084：Issue event 写预算与有界 artifact](xuanwu/0084-issue-event-write-budgets.md)
- [ADR-XW-0086：Project 注册即自动接管](xuanwu/0086-project-enrollment-automatic-takeover.md)
- [ADR-XW-0092：IM 上下文预算、增量投影与 PI Session 换代（Accepted v7，Phase 0–3 已本地实现、未部署）](xuanwu/0092-im-context-budget-and-session-rollover.md)

## 3. 历史归档与 superseded 映射

这些文件保留原路径，避免破坏旧 issue、commit 和审计记录中的引用；其页首 banner 与下表指向替代规范。

| 历史记录 | 当前规范 |
| --- | --- |
| [ADR-XW-0001 的“本地优先、验证优先”产品类别表述](xuanwu/0001-product-positioning.md) | [常驻无人值守的 AI 工程控制面定位](xuanwu/0088-always-on-product-positioning.md) |
| [PI Guardian 完整技术设计](2026-06-17-pi-guardian-notification-supervisor-design.md) 与 [v1](2026-06-17-pi-guardian-design-review.md) / [v2](2026-06-17-pi-guardian-design-review-v2.md) 评审 | [Automation 语义](xuanwu/0060-automation-semantics.md)、[Approval / Action Gate](xuanwu/0063-approval-action-gate.md)、[通知 Outbox](xuanwu/0075-unified-notification-outbox.md)、[决策层收敛](xuanwu/0079-pi-decision-layer-consolidation.md) |
| [PI Guardian 通知路由边界](2026-06-23-pi-guardian-notification-routing.md) | [统一通知 Outbox](xuanwu/0075-unified-notification-outbox.md)、[Feishu Connector 迁移](xuanwu/0077-feishu-channel-connector-migration.md) |
| [provider worker outage 回归说明](2026-06-23-pi-provider-worker-outage-regression.md) | [Run 生命周期](xuanwu/0020-run-attempt-lifecycle-contract.md)、[provider event contract](xuanwu/0022-provider-run-event-contract.md)、[重启恢复不变量](xuanwu/0069-restart-recovery-invariants.md) |
| [Loop L3 架构快照](2026-06-30-loop-l3-architecture-snapshot.md)、[`loop_run` ledger v0 草案](2026-06-30-loop-run-ledger-v0.md) | [核心对象](xuanwu/0004-core-domain-objects.md)、[Run lifecycle](xuanwu/0020-run-attempt-lifecycle-contract.md)、[运行可观测性](xuanwu/0078-runtime-observability-diagnostics.md) |
| [PI Assistant Runtime Roadmap](2026-07-06-pi-assistant-runtime-roadmap.md)、[PI Agent 独立架构计划](pi-agent-architecture-plan.md) | [产品定位](xuanwu/0001-product-positioning.md)、[Supervisor 角色合同](xuanwu/0044-supervisor-role-prompt-contract.md)、[产品导航](xuanwu/0050-product-navigation-compatibility.md) |
| [PI Agent Issue Supervisor Recovery 设计](pi-agent-issue-supervisor-recovery-design.md) | [Run lifecycle](xuanwu/0020-run-attempt-lifecycle-contract.md)、[Run command service](xuanwu/0023-run-lifecycle-command-service.md)、[重启恢复不变量](xuanwu/0069-restart-recovery-invariants.md) |
| [PI CLI Connector Manifest v0](2026-07-07-pi-cli-connector-manifest-v0.md) | [Channel / Connector contract](xuanwu/0064-channel-connector-contract.md)、[CLI / Webhook adapter](xuanwu/0065-cli-webhook-channel-adapter.md)、[Connector diagnostics](xuanwu/0076-connector-health-secrets-diagnostics.md) |
| [PI Skill Manifest v0](2026-07-07-pi-skill-manifest-v0.md) | [Workflow Registry](xuanwu/0049-workflow-manifest-registry.md)、[可执行 Skill Runtime](xuanwu/0058-executable-skill-runtime.md)、[生产 fixture 退出](xuanwu/0077-production-fixture-retirement.md) |
| [OpenConnector 接入调研](2026-07-09-openconnector-inbox-integration-research.md) | [Provider / Connections](xuanwu/0059-provider-presets-connections.md)、[Channel / Connector contract](xuanwu/0064-channel-connector-contract.md)、[Connector diagnostics](xuanwu/0076-connector-health-secrets-diagnostics.md) |
| [Bun/TypeScript Backend Migration](bun-ts-backend-rewrite-plan.md)、[`docs/design.md`](../design.md) | 根 [README](../../README.md)、[发布/升级/回滚 runbook](../runbooks/release-upgrade-rollback.md)、[运行可观测性](xuanwu/0078-runtime-observability-diagnostics.md) |

## 4. 兼容、回滚与删除门禁

- 本次仅建立文档 authority：不改 runtime、public schema、route、状态机或 provider adapter，双读=0、双写=0。
- 历史文件继续原路径只读保留，兼容旧链接；新实现不得从这些文件复制 contract。回滚只需恢复 banner、索引和 README 入口，不涉及数据回填。
- 物理删除历史文件前，必须证明仓库内和 live 生成配置的 consumer/reference 为 0，保留可恢复 Git/备份 Evidence，通过断链检查，并由独立清理 issue 的非 LLM 审批记录授权。本 issue 不执行物理删除。
- 新 canonical 文档若 supersede 既有文档，必须同时更新本索引、在旧页增加指向新 source of truth 的 banner，并保持旧审计链接可访问。
