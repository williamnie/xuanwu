# ADR-XW-0076：Connector Health、Secret 引用与诊断

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P09.07 / Runner #723
- 硬依赖：XW P09.01 / #717、XW P10.06 / #729（均为 `done`）
- canonical 实现：`backend-ts/src/integrations/connectorDiagnostics.ts`
- UI/API：Settings → Connections、`/api/pi/connectors*`

## 决策与边界

根因不是缺少单个 Feishu 或 CLI 状态，而是既有状态分散在 `systemStatus.ts`、CLI health、各 provider config、
`external_events`、Tracker 表和 `sync_outbox`，且 `/api/pi/connectors` 会执行 CLI probe，却没有统一的显式测试、
退避、secret lifecycle 或可下载诊断合同。本期增加只读 projection 与受审计操作，不创建 connector 状态表、第二套
registry、第二个 outbox 或 provider writer。

| 事实 | 唯一 source of truth | 本期 projection |
| --- | --- | --- |
| manifest / permission | P09.01 manifest、CLI manifest、现有 adapter capability | 统一显示 connector kind、capability 和 authorization requirement |
| secret material / revoke | P10.06 `SecretService` backend 与 `secret://` metadata | 只显示 ref/status/version；revoke 复用 `SecretService.revoke()`，无 readback |
| 最近同步 / 错误 | `external_events`、`tracker_sync_events`、`sync_outbox`、既有 provider audit | 只读聚合；不写 shadow health row |
| 外部写与重试 | 既有 provider adapter、Action Gate、`sync_outbox` | health 不改变 writer；test connection 只发只读 probe |
| test / backoff | `pi_action_events(event_type='connector.tested')` | 失败次数派生 30 秒指数退避，最多 15 分钟，并尊重 provider `Retry-After` |

## API 与安全语义

- `GET /api/pi/connectors`：兼容已有 Browser/CLI 结果并增加 Feishu、Webhook、Git event 与 Tracker registry projection。
- `GET /api/pi/connectors/diagnostics`：返回 `xuanwu.connector-diagnostics.v1`；不含 secret material、provider response body
  或绝对 manifest path。
- `POST /api/pi/connectors/:id/test-connection`：显式只读 probe；结果以稳定错误码记录
  `connector.tested`。退避期内返回 `429`，LLM 文本不能覆盖退避门禁。
- `POST /api/pi/connectors/:id/revoke`：只接受该 connector 当前声明且 active 的 `secret://`；必须给出 reason。
  `env://` 与 legacy raw carrier 不可由 Runner 撤销。成功后 P10.06 记录 `secret.revoked`，并清除对应当前运行态 material。

错误分类固定为 `not_configured`、`credential_expired`、`rate_limited`、`network_unreachable`、
`provider_error`，不透传 response body 或异常文本。无配置、401/403、429 和 fetch 断网 fixtures 覆盖这些分支。

## 兼容、回滚与删除门禁

本期 DB migration 为 0；health/test history 都从既有 authority 派生。`/api/system/status.connectors` 保持原 Feishu
兼容结构，新统一 projection 追加在 `connector_health`。`/api/pi/connectors` 保留 Browser/CLI 字段，新增字段是 additive。

- **双写=0：** connector test 只写既有 audit stream；不写健康状态表。
- **双读：** P10.06 已定义的 legacy raw / `secret://` 双读期限不变；本期不延长、不新增 raw secret writer。
- **回滚：** 回滚 scoped commit 即停止 projection 和 API；既有 adapter、event、outbox 与 secret backend 不受影响。
  已执行的 revoke 是不可逆安全操作，只能通过 audited rotate/put 提供新 material，不能从诊断包恢复。
- **最终删除：** 只有 P10.06 的连续两个 release legacy scan=0、connector restart smoke、backup/restore 与旧 binary
  consumer=0 门禁全部通过，后续 issue 才能删除 legacy reader。

## 最小验证

```bash
cd backend-ts
bun test src/integrations/connectorDiagnostics.test.ts \
  src/http/piConnectorHealthApi.test.ts src/pi/cliConnectorHealth.test.ts src/http/systemStatus.test.ts

cd ../frontend
node --test src/utils/runtimeDiagnostics.test.js src/pages/settingsLayout.test.js
npm run build
```

验证覆盖无配置、过期、限流、断网、显式测试审计、退避、secret revoke/no-readback 与诊断脱敏。
