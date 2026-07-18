# Work Board 与 Issues 兼容入口

> P11.05 更新：用户级 `issues` page id 已按 [ADR-XW-0081](0081-issues-sessions-route-retirement.md)
> redirect 到 Work；旧 Issues 页面只作为关闭 Work feature flag 时的 rollback artifact。API/storage authority 不变。

## 决策

`Work Board` 是统一 Work Ledger 的新用户入口；`Issues` 页面、Issue detail 和现有 `/api/issues*` 操作继续保留。Work 卡片通过 canonical `xw:work:issues:<issue_id>` 映射打开原 Issue detail，不复制详情或执行逻辑。

前端由 `VITE_WORK_BOARD_ENABLED` 控制入口：默认启用；设置为 `false`、`0` 或 `off` 时隐藏 Work 导航，并把内部 `work` 页面导航兼容解析到 `issues`。该 flag 只控制 UI/route，不改变数据 authority。

## 并存合同

- **Source of truth**：当前仍为 `issues`。Work Board 读取 `/api/works` 的 Issue 投影，create/edit 经 Work HTTP adapter 写回 Issues；PI Action、Delegation、Watch 只通过 `/api/work-relations` 只读投影关联。
- **双写 / 双读期限**：本页面不启动双写或 authority 切换；当前 Work HTTP policy 为 `dual_read=none`、`target_shadow=disabled`。若进入 W1/W2，沿用 `0018-work-backfill-dual-read.md` 的最多两个正式 release window 门禁，不允许 UI 自行切换 authority。
- **回滚**：关闭 `VITE_WORK_BOARD_ENABLED` 并重新构建前端即可恢复 Issues 单入口；Work HTTP route 可按既有 API policy 注销。两种回滚都不迁移、不删除 Issues 或 Work shadow 数据。
- **最终删除门禁**：不得在 P11.05、P11.09、G7、零 legacy consumer、contract snapshot、备份恢复观察窗全部通过前删除 Issues 页面、route、table 或兼容分支。

## 过滤语义

- `Type`、`Status`、`Project` 直接使用 Work 字段。
- `Attention=Needs attention` 是确定性视图：Work 为 `triage`、`pending_verification`、`failed`，或关联 carrier lifecycle 为 `pending`、`paused`、`failed`、`legacy_unknown`。
- `Delivery` 由 Work 状态投影：`done=delivered`、`cancelled=closed`、`pending_verification=verification`，其余为 `outstanding`。

这些过滤只改变页面投影，不写状态，也不替代 Guardian/Attention 的权限和审计门禁。
