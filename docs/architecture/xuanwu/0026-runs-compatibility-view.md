# ADR-XW-0026：Runs 主视图与 Sessions 兼容入口

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P03.07 / Runner #662
- 依赖：[ADR-XW-0024](0024-run-http-api.md)、[ADR-XW-0025](0025-run-progress-projection.md)
- 可执行实现：`frontend/src/pages/Runs.jsx`、`frontend/src/pages/runs/runPageModel.js`

## 1. 用户模型与 source of truth

侧栏和主路由以 **Runs** 命名。Runs list 只读取 `GET /api/runs`，以 Work title / Work ID、统一 Run status、provider 和 Attempt 展示执行；raw provider session ID 不再是列表身份。

Run lifecycle 的唯一 authority 仍是 `issue_runs`，Attempt child facts 是 `run_attempts`，progress 由 `issue_runs + run_attempts + issue_events` read-through rebuild。`agent_sessions` 和 provider session file 只用于 observation / transcript drill-down，不能反向决定 Run 状态。

## 2. 路由与旧操作映射

- `runs` 是 canonical page id；所有新导航进入 Runs list/detail。
- `sessions` 保留为 compatibility page id。旧 `navigateTo('sessions', null, providerSessionRef)` deep link 会进入 Runs shell 的 provider session 兼容视图，不改写旧引用。
- Run 详情中的 provider session transcript 为只读 observation。`interrupt`、`resume`、`retry` 分别映射到 `POST /api/runs/:id/actions/:action`，携带 user actor、event/correlation id 与 Run/Attempt revision，由 Run command service 写入 lifecycle audit。
- 独立的“新建 provider session”仍可使用旧 Session create/message/steer 能力；它不会伪装成 Work Run。只有被 Work claim 的正式执行才进入 Runs list。

## 3. 并存窗口、回滚和删除门禁

| window | UI read/control policy |
| --- | --- |
| W1（当前） | Runs list/detail primary；旧 Sessions deep link 与独立 provider 对话保留；Run control 只走统一 Run API |
| W2（最多一个正式 release） | Runs projection primary，legacy Session/Issue projection 仅 parity fallback 与 observation |
| W3 | Sessions 仅保留明确标记的 provider drill-down，所有 Work execution control 已迁入 Run command |

- **双写期限：0。** UI 不建立第二套 Run 状态，也不把 provider session 写成 Run authority。
- **双读期限：仅 W2、最多一个正式 release。** 任一 Work association、Attempt 或 progress parity drift 立即回到 W1，并保留 legacy deep link。
- **代码回滚：** 将 `sessions` page id 恢复为旧 `Sessions.jsx`，从侧栏撤下 Runs，并注销 frontend Run API consumer；不删除 `issue_runs`、`run_attempts`、event 或 session data。
- **最终删除门禁：** 只有 P11.05、G7、一个 W2 parity release、Sessions consumer 为零、旧 route contract 留档、备份/恢复演练与观察窗全部通过，才可删除 Sessions compatibility route。无 superseding ADR 不得删除 `issue_runs`。

## 4. 最小验证

```bash
cd frontend
node --test src/pages/runs/runPageModel.test.js src/pages/Runs.compatibility.test.js
npm run build
```

运行态 smoke 还必须覆盖：真实 Codex Run、真实 Claude Run、旧 Sessions provider-session deep link，以及对应 `/api/runs/:id` provider observation ref。
