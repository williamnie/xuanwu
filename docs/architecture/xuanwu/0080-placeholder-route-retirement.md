# ADR-XW-0080：旧 Inbox、Approval、Activity 与 Settings 占位入口退出

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P11.02 / Runner #737
- 硬依赖：P07.03 / #695、P07.11 / #703、P07.14 / #706、P08.09 / #715（均为 `done`）
- 数据迁移：不复制、不改写、不删除业务记录；仅迁移前端 route/nav consumer

## Live reference 与根因

2026-07-18 对 launchd/3008 live runtime 做只读审计：

- `GET /api/command-center/summary?sections=attention&limit=1` 返回
  `xw.command-center.summary.v1`、`sections.attention.status=ok`，共有 7 条 Attention；Command Center 已是
  Attention/Approval 的产品入口，并继续从现有 carrier 做 request-time projection；
- `GET /api/pi/attention-inbox/items` 返回 200，当前记录数为 0；该 API 和
  `attention_inbox_items` 仍是 intake carrier，不因删除旧页面而删除；
- `GET /api/pi/activity?limit=1` 返回 200 和 1 条审计节点；Advanced Activity 已有真实读模型，不再是占位页；
- 源码审计发现 `navigateTo` 仍会把 Work 和 Command Center 中的来源按钮送进旧 `AttentionInbox`，而
  `assistantModules` 只把它标成隐藏父路由；App 因而仍按需加载一套重复 Inbox/Proposal UI；
- 普通及 Advanced Settings 已接入现有 Agent、Connector、Permission、Notification、MCP、Skill、Memory、
  Activity 和 Policy 面板，但每个真实面板前仍叠加 `SettingsPlaceholderPanel` 空壳说明卡。

因此根因不是缺少新模型，而是新入口上线后旧 route consumer 和占位组件没有完成退出。

## Route/nav 迁移

| 旧 page id | canonical 入口 | 兼容方式 |
| --- | --- | --- |
| `attention-inbox`、`pi-inbox` | `command-center` | `resolveProductPage` 确定性 redirect |
| `pi-approvals` | `command-center` | 保留既有 redirect；Decision 详情和 mutation 仍走统一 Attention service |
| `pi-activity` | `settings` → Advanced Activity | 保留 `assistantModules` 的 tab redirect，不恢复顶层 Activity |
| `pi-overview`、`pi-connectors`、`pi-skills`、`pi-memory`、`pi-policies` | Settings 对应真实 section | 保留定向 deep link，不创建并行页面 |

新 nav 不包含 Inbox、Approvals 或 Activity 一级入口。旧 Inbox deep link 不再挂载页面，统一解析到 Command Center；
旧 Inbox carrier 的来源事实通过其只读 `links.self` 打开，避免重新引入第二套 action/proposal mutation UI。

## 数据、authority 与删除边界

- Attention/Approval source of truth 继续遵循 P08.07/P11.03：`attention_inbox_items`、Guardian、
  `pi_actions`、`pi_action_proposals` 和 provider approval 各保留单一 carrier，由 Command Center 做一次 projection；
- Activity source of truth 仍是 append-only event/audit authorities，Advanced Activity 只读现有
  `/api/pi/activity`；Settings 不复制 Activity 数据；
- Settings 各 section 直接挂载已有真实 panel 及其 API。删除的只是 `AssistantSettingsPlaceholders`、旧
  `AttentionInbox` JSX/CSS 和相应静态测试，不删除 API、表、事件或审计记录；
- 无双写、无 request-time old/new UI 双读、无 backfill。这个 zero-copy 迁移避免把导航清理误做成 schema/public-contract 变更。

## 回滚与最终门禁

- 回滚只需恢复本次前端 commit；业务数据没有迁移，旧 carrier/API 仍可读，不需要反向数据脚本；
- 不得通过回滚重新启用旧 Inbox 的 mutation 实现作为长期入口；Approval 外部写仍必须经过统一确定性 Action Gate；
- 完成门禁：route/nav 测试证明旧 deep link redirect，源码中不存在旧页面/占位组件引用，focused frontend tests、
  lint、build 和 Command Center/Settings visual smoke 通过；
- 表/API 的最终 destructive removal 不属于本 issue，仍受 P11.03/P11.09、consumer-zero、backup/restore 和
  人工 destructive approval 门禁约束。
