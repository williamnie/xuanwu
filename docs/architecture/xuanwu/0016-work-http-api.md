# ADR-XW-0016：Work HTTP API 与兼容 authority

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P02.06 / Runner #652
- 依赖：[ADR-XW-0013](0013-work-ledger-repository-service.md)、[ADR-XW-0014](0014-issue-work-compatibility-adapter.md)
- 实现：`backend-ts/src/http/workApi.ts`

## 1. HTTP contract

本期注册以下 authenticated API：

- `GET /api/works`：支持 `project_id`、`status`、`type`、`q` filter，`created_at | updated_at | title | status` sort，以及 `page` / `page_size` 分页；
- `GET /api/works/:id`：仅返回当前 Work；
- `GET /api/works/:id/timeline`：按游标返回只含展示所需字段的有界 Activity；
- `POST /api/works`：创建 Issue-backed `engineering_task`，初始状态只允许 `triage | todo`；
- `PATCH /api/works/:id`：带 `expected_revision` 更新 `title | goal`；
- `POST /api/works/:id/actions/:action`：带 `expected_revision` 执行 `enqueue | retry | cancel`；

Work route 的业务错误固定为 `{ code, message }`，mutation gate 拒绝额外返回 `violations` 与当前 `work`。非法输入返回 400，不存在的 Project/Work 返回 404，optimistic/state/gate conflict 返回 409，未分类内部错误返回不泄露细节的 500。Bearer/cookie auth 沿用全局 API middleware，未授权仍使用现有 `{ message: "unauthorized" }` contract。

HTTP request 必须提供 audit actor、reason、correlation、event id 和 timestamp，但不得提供 gate。gate 由 authenticated route boundary 固定生成 `deterministic_policy/allow`；因此 UI、Supervisor payload 或 LLM 输出不能自行声明权限。创建、更新和 action 分别落入 `issue.created` 或 `issue.work_adapter_write` audit，event id 同时作为幂等键。

## 2. authority 与边界

G4 前 `issues` / `issue_events` 仍是唯一读写 authority。Work list/detail 从 P02.04 adapter 确定性投影；create/update/action 也只经 adapter 与现有 Issue repository 写入。HTTP route 强制 `shadow_mode=disabled`，不会因查询或写入创建 `works` row。

P02.05 的 PI carrier 关系投影已按 ADR-XW-0015 退役。`parent_child` / `depends_on` 没有无损 legacy 写位点，因此 G4 前不开放结构关系写 API，也不把 dormant/shadow `work_relations` 当作 authoritative read。`objective` 同样没有 legacy carrier，本期明确返回 authority conflict，而不是创建 target-only 数据或复制第二套存储。

列表、详情、board 和 mutation 响应不再携带 migration `compatibility` 元数据；authority 是服务端实现约束，不是产品页字段。readiness declaration 仍是独立的 fail-closed 控制 API，但不再扩展 Work Detail 响应。

## 3. 双读、回滚与删除门禁

- 当前 dual read 为 `none`，target shadow 为 `disabled`；不存在请求可切换 authority。
- W1 只有 P02.08 经审计打开后才允许一个正式 release 的 legacy-primary shadow window；W1/W2 双读总计最多两个 release window，冲突在 G4 前始终由 legacy 获胜。
- 回滚本期只需注销 Work routes；全部 authoritative 数据仍在 Issue/PI carrier 中，无需数据迁移或删除 `works` rows。
- 删除 Issue adapter/carrier 仍要求 P11.05/P11.09、G7、零 consumer、备份/恢复演练和观察窗全部通过；任一门禁缺失都保留旧路径。
