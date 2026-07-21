# 玄武产品导航与兼容路由合同

> P11.05 更新：`issues` 已从隐藏挂载入口升级为到 Work 的确定性 redirect；期限和 telemetry 见
> [ADR-XW-0081](0081-issues-sessions-route-retirement.md)。
>
> 2026-07-21 更新：Connections 已从 Settings compatibility carrier 升级为独立产品页；旧 Settings
> `connections` / `connectors` 输入只保留确定性 redirect，不再挂载重复 writer。

- 状态：Accepted
- 日期：2026-07-17
- 依赖：[ADR-XW-0002](0002-brand-terminology.md)、[Work Board 兼容合同](0019-work-board-compatibility.md)、[Runs 兼容视图合同](0026-runs-compatibility-view.md)
- canonical 级别：`frontend/src/brand.js` 是用户可见导航名称的 source of truth；`frontend/src/pages/assistantModules.js` 是导航顺序、可用性和 page id 兼容映射的 source of truth

## 1. 用户可见导航

侧栏按以下顺序展示唯一的玄武产品导航：Command Center、Ask Xuanwu、Work、Runs、Handoffs、Automations、Projects、Connections；Settings 保留在底部工具区。侧栏不再展示独立的 PI/Supervisor 分组，也不再把 Issues、Sessions 或 Cron 当作并列产品入口。

当前 route 到已验证能力的投影如下：

| canonical page id | 当前承载页面 | availability |
| --- | --- | --- |
| `command-center` | 现有 Dashboard 聚合视图 | compatibility；P07.02–P07.05 后续替换数据与分区 |
| `ask-xuanwu` | 现有 `PiChat` 与 `/api/pi/*` conversation | compatibility；不复制第二套 chat/runtime |
| `work` | Work Board；关闭既有 feature flag 时回退 Issues | compatibility；沿用 Work/Issue 迁移合同 |
| `runs` | Runs 与 provider Session drill-down | compatibility；沿用 Run/Session 迁移合同 |
| `handoffs` | 现有 Handoffs 页面与 API | available |
| `automations` | 现有 Cron 页面 | compatibility；P08 统一 Automation 前不合并状态机 |
| `projects` | 现有 Projects 页面与 API | available |
| `connections` | 独立 Connections：AI Providers、PI Agent、Integrations、MCP | available |
| `settings` | 现有 Settings 页面 | available；普通/Advanced 两层由 P07.11/P07.14 迁移 |

`availability` 只描述当前 UI carrier，不改变底层完成状态、权限或 authority。受 feature flag 关闭的页面不得留下可点击死入口。

### 1.1 Settings 两层 IA

Settings 普通层固定为 General、Models & Agents、Permissions、Notifications。Connections 将 AI Providers 与 PI Agent 按配置顺序相邻呈现；自定义 Provider 收进 AI Providers 的高级折叠入口。Connections PI Agent 与 Settings Models & Agents 复用同一组件和 agent writer，只写 Supervisor 行为与默认模型，不写 provider credential。外部 connector 与 MCP 的连接 writer 统一归属顶层 Connections。Runtime、Skills、Memory、Activity、Policies、诊断导出与 Restart 只能从显式 Advanced gate 进入。General 的项目设置入口跳转现有 Projects 编辑面，不复制项目表单或状态。

旧 tab 按确定性规则继续可读：`assistant → Models & Agents`、`runner-brain → Advanced / Runtime`、`connections|connectors|advanced:model-runtime → 顶层 Connections`、`skills → Advanced / Skills`、`approvals → Permissions`、`memory → Advanced / Memory`、`activity → Advanced / Activity`、`policies → Advanced / Policies`。新入口使用 canonical page/tab id；旧 id 只作为兼容输入。`mcp` 和 `model-runtime` 不再是 Settings tab，MCP 与自定义 provider 管理只在顶层 Connections 挂载。

## 2. 旧 deep link 与隐藏兼容入口

纯 UI page id 做确定性跳转：`dashboard → command-center`、`pi-chat → ask-xuanwu`、`sessions → runs`、`cron → automations`、`pi-connectors → connections`。

`issues`、`pi-inbox`/`attention-inbox` 和其余 `pi-*` Settings page id 继续作为隐藏兼容入口，不出现在侧栏。Issue detail/new issue、Attention Inbox 和原 Settings tab 仍复用当前组件；进入这些入口时，侧栏分别把 Work、Command Center 或 Settings 标为所属产品面。Handoff hash deep link 保持现有合同不变。

## 3. Source of truth、窗口与回滚

- 本变更没有 schema、API、状态机、双写或双读；SQLite、Work/Run/Handoff API、Cron 与 `/api/pi/*` 仍按各自现有迁移合同 authoritative。新 page id 只是前端内存路由 projection。
- 兼容 page id 最多保留 W1/W2 两个正式 release window。删除必须满足 P11.05、一个正式 release 的 consumer-zero 证明、旧 deep-link 测试清单、retained compatibility artifact 和 G7；不能在普通 UI 清理中顺手删除。
- 回滚只需恢复旧导航配置与默认 page id。没有数据回放、DB downgrade 或外部状态恢复动作。
- Connections / Settings IA 不新增 schema、API、双写或双读：PI agent/provider API、integration settings、MCP API、runner settings 与 policy/runtime API 仍分别是唯一 source of truth。旧 Settings connection tab 只 redirect 到顶层 Connections，不能重新挂载 connection writer。旧 tab id 在 W1/W2 两个正式 release window 内保留读取兼容；删除旧 id 必须满足 P11.05、一个正式 release 的 consumer-zero 证明、旧 deep-link 测试清单、retained compatibility artifact 与 G7。

## 4. 验证门禁

`frontend/src/pages/productNavigation.test.js` 必须证明：导航顺序与名称唯一；feature flag 不产生死入口；旧 page id 确定性跳转；Issue/Attention/Settings 隐藏 deep link 仍可达；`App.jsx` 将 canonical route 投影到当前已验证页面。前端 build 和品牌术语审计必须同时通过。
