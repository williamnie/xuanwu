# ADR-XW-0082：用户可见命名迁移与内部兼容清单

- 状态：Accepted
- 日期：2026-07-19
- 依赖：[ADR-XW-0002](0002-brand-terminology.md)、[Supervisor 角色与 Prompt 合同](0044-supervisor-role-prompt-contract.md)、[导航兼容合同](0050-product-navigation-compatibility.md)
- canonical 范围：玄武用户界面、外部通知、运行时 Prompt、当前操作文档与兼容别名

## 1. 结论

用户可见产品名统一为 **玄武 / Xuanwu**，监督人格与交互运行时统一为 **Xuanwu Supervisor / Supervisor**，执行子系统与故障监督能力分别称为 **Runner** 与 **Guardian**。内部 `pi_*`、`Pi*`、`runner-default`、`codex-issue-runner` 以及 `/api/pi/*` 不因本次迁移改名或复制。

运行状态的唯一 source of truth 仍是现有 SQLite、API、Issue/Session/Work/Run/Evidence authority。本次只改变显示字符串和 Prompt 描述，不增加 schema、状态机、路由、双写或双读。

## 2. String inventory

| 表面 | canonical 输出 | 本次审计范围 | 兼容边界 |
| --- | --- | --- | --- |
| Web UI | 玄武、Xuanwu Supervisor、Runner、Guardian | `frontend/index.html`、`frontend/src/components`、`frontend/src/pages` | `Pi*` 组件、`pi-*` route ID 和 API client 名保持内部稳定 |
| 默认 Supervisor | `runner-default` 显示名为 `Xuanwu Supervisor`，instructions 使用玄武 Supervisor 合同 | `backend-ts/src/db/defaultPiAgent.ts`、`frontend/src/pages/piAgentSettingsState.js` | 只投影精确历史默认值；自定义名称/instructions 原样保留 |
| 外部通知 | 前缀统一为 `玄武 Supervisor`；能力名使用 Guardian/Runner | `backend-ts/src/notifications`、Feishu formatter/card、digest、watch 与 Guardian fallback | event type、outbox kind、payload 字段和幂等键保持不变 |
| Prompt/工具描述 | `Xuanwu Supervisor` 或 `Supervisor` | intake、issue recovery、manager cycle、memory、repo context、tool descriptions | tool ID、skill ID、action type 和 `pi_*` carrier 不变 |
| 当前文档 | 玄武作为产品，Supervisor 作为监督运行时 | `README.md`、`frontend/README.md`、当前 runbook、connector/smoke/context-pack 文档 | 命令、环境变量、路径、API/DB 名按代码原值书写 |
| 历史设计记录 | 保留原始术语作为 provenance | `docs/architecture/2026-*`、旧 review/roadmap | 由 [canonical 架构文档索引](../README.md) 归档；不得把历史快照当作当前产品文案 |

## 3. Compatibility aliases 与现有配置升级

- **稳定标识：** `codex-issue-runner` 二进制/CLI/skill、`CODEX_RUNNER_*`、`runner-default`、`pi_*` 表/列/事件、`Pi*` 类型与内部文件名不变；GitHub 仓库从 `v0.2.0` 起使用 `williamnie/xuanwu`；产品 API 已收敛为 `/api/pi/supervisor`。
- **默认配置迁移：** `055_collapse_pi_agents_to_supervisor` 与启动自愈会把精确匹配的旧默认名称/instructions 改写为 canonical 值、归一项目与会话引用，并删除 `runner-default` 之外的旧 agent 配置；前端不再保留 compatibility projection。
- **mention alias：** Feishu 输入继续接受既有 `@PI` mention，输出只显示玄武/Supervisor。该 alias 不创建新 route、agent 或状态。
- **无双写/双读：** 没有第二份 Supervisor authority；旧多 agent 产品 API 已删除。

## 4. i18n readiness

- 前端 canonical 固定词由 `frontend/src/brand.js` 导出。
- 后端通知前缀和固定角色词由 `backend-ts/src/xuanwu/userFacingTerminology.ts` 导出。
- 业务状态、provider 名、issue 标题和审计字段不得混入固定品牌常量；未来 locale catalog 可替换固定文案而不改 DB/API payload。
- 兼容 literal 只允许出现在精确 migration projection 或已记录的输入 alias 中，禁止建立宽泛 allowlist。

## 5. 回滚与验证

回滚只需恢复本次字符串、formatter、Prompt 和文档变更；数据库和 API 无需回滚。回滚后内部标识、状态和审计记录仍可读取。

自动化门禁必须验证：

1. UI、通知和 Prompt 源码中没有未登记的旧用户可见身份；
2. 默认配置的历史值只在精确 projection 中出现，自定义值不被改写；
3. `codex-issue-runner`、`runner-default`、`/api/pi/*`、`pi_agents` 和 `pi_agent_id` 保持原值；
4. 通知 formatter、Guardian fallback、manager/recovery/intake Prompt 与 frontend build 通过定向测试。
