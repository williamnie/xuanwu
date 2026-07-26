# ADR-XW-0015：Action / Automation Watch → Work 关系适配器（已退役）

- 状态：Retired
- 原决定日期：2026-07-16
- 退役日期：2026-07-26
- 路线 issue：XW P02.05 / Runner #651

## 原决定

曾将 `pi_actions` 与 `automation_watches` 确定性投影为 Issue-backed Work 的
`execution` / `observation` 关系，并通过 `/api/work-relations` 与
`/api/works/:id/relations` 暴露。该投影只读，不写 `works` 或
`work_relations`，也不改变 Work transition、Evidence 或 Handoff authority。

## 退役决定

真实运行数据表明，一个 Work 可被数百条历史 Action 投影为关系；这些记录与
Activity/Run 已有事实重复，显著放大 Work Detail 响应和前端注意力列表，却没有
产生独立决策价值。因此删除：

- `piRelationAdapter.ts` 及其专用测试；
- `GET /api/work-relations`；
- `GET /api/works/:id/relations`；
- Work Board / Work Detail 的 relation badge、filter 和详情投影。

Work Activity 如需显示 PI Action，只按当前 Issue ID 直接读取有界 action 引用并
压缩为 timeline item，不再构造 relation、unmapped gap 或 carrier lifecycle。

## 保留边界

`pi_actions`、`pi_action_events`、`automation_watches` 及各自审计仍由原 domain
负责；本次只删除重复的产品/API 投影，不删除 authority 数据，不放宽权限、验收
或完成门禁。历史实现可从本 ADR 退役前的 Git revision 恢复。
