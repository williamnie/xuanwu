# ADR-XW-0065：CLI 与签名 Webhook Channel Adapter

- 状态：Accepted（W0 additive adapter）
- 日期：2026-07-18
- 路线 issue：XW P09.03 / Runner #719
- 硬依赖：[ADR-XW-0016](0016-work-http-api.md)、[ADR-XW-0064](0064-channel-connector-contract.md)
- 实现：`backend-ts/src/cli/work.ts`、`backend-ts/src/http/webhookEventsApi.ts`

## 1. Authority、回执与迁移边界

CLI 与 webhook 都是 P09.01 `channel` adapter；它们不创建 Work、外部事件、权限或 outbox 的第二套模型：

| 事实 | 唯一 source of truth | 本 adapter 的行为 |
| --- | --- | --- |
| Work 状态及写审计 | P02.06 `issues` / `issue_events` | 仅调用 `createIssueBackedWork` 或 Work HTTP API |
| 入站 webhook、raw payload、dedupe | `external_events` | 按 `source=webhook` + `Idempotency-Key` 归档和重放 |
| 外部事件与 Work 的关联 | `external_links` | 写入 `relationship=work_create` provenance link |
| 面向调用方的结果回执 | 同步 HTTP response + `GET /api/works/:id` | 返回 poll URL，不把结果伪造成已发送的外部消息 |

W0 **双读=0、双写=0**：Webhook 创建的 Work 仍是 Issue-backed，现有 Feishu IM / Tracker `sync_outbox` 的 producer、dispatcher 和状态机完全不变。当前不接受 callback URL、token 或任意出站 headers，因而不会绕过 P06/P08 的 Action Gate 或把未授权外写塞进 outbox。若未来需要主动回调，必须先复用经授权的 durable outbox，定义 target allowlist、receipt/retry/idempotency、Action Gate audit、W1/W2（最多两个正式 release）双读期限、rollback 和 consumer-zero 删除门禁；本期不能以临时 HTTP `fetch` 绕过这些要求。

回滚只需注销 `webhookEventsApi` route 和 CLI `work` command；所有已创建 Work、入站 audit 和关联仍留在既有 authority，不删除或反写数据。删除该 adapter 也必须等 P11/G7 的 replay、备份/恢复和零 consumer 门禁完成。

## 2. CLI contract

CLI 复用 runner bearer auth 与 P02.06 HTTP contract：

```bash
codex-issue-runner work create \
  --project demo \
  --title "修复 build" \
  --goal "定位并修复 build 失败" \
  --status todo \
  --idempotency-key ci-20260718-build \
  --occurred-at 2026-07-18T00:00:00.000Z \
  --json

codex-issue-runner work status --id xw:work:issues:123 --json
codex-issue-runner work result --id xw:work:issues:123 --json
codex-issue-runner work timeline --id xw:work:issues:123 --json
```

`create` 强制 caller 提供 `--idempotency-key` 和 `--occurred-at`。P02.06 的 authoritative audit fingerprint 包含完整 audit；CI/Agent 重试必须原样复用两者和业务 payload，才会返回原 Work，而不是被判定为冲突。CLI 不打印 bearer token；HTTP error 已沿用既有 redact 路径。

## 3. Webhook contract

Endpoint 为 `POST /api/integrations/webhook/events`。它是 runner bearer middleware 的 public callback exception，但**只**在下列签名验证通过后接受：

- 环境变量 `XUANWU_WEBHOOK_SIGNING_SECRET` 必须非空；未配置固定返回 `503 webhook_unavailable`；
- `Idempotency-Key`：1--192 个 `[A-Za-z0-9._:-]` 字符，首字符为字母或数字；
- `X-Xuanwu-Timestamp`：ISO timestamp，和 runner 当前时间相差不超过 5 分钟；
- `X-Xuanwu-Signature`：`v1=` + `hex(HMAC-SHA256(secret, timestamp + "." + rawBody))`，使用 constant-time comparison。

请求 body 仅支持一个显式事件：

```json
{
  "id": "ci-event-719",
  "type": "work.create",
  "occurred_at": "2026-07-18T00:00:00.000Z",
  "data": {
    "project_id": "demo",
    "title": "修复 build",
    "goal": "定位并修复 build 失败",
    "status": "triage"
  }
}
```

它先归一化为 P09.01 inbound envelope，并使用固定的 route-boundary `deterministic_policy/allow` audit gate；payload 内无法提交 gate、actor 或出站能力。相同 key + 相同 raw body 返回 `200` 与 `replayed=true`，不创建第二个 Issue/Work；同 key + 不同 body 固定返回 `409 webhook_idempotency_conflict`。首次接受返回 `202`，并携带：

```json
{
  "accepted": true,
  "replayed": false,
  "callback": { "mode": "poll", "status_url": "/api/works/xw%3Awork%3Aissues%3A123" }
}
```

稳定公开错误是 `{ "code", "message" }`：`invalid_idempotency_key`、`invalid_signature_timestamp`、`invalid_signature`、`invalid_json`、`unsupported_event`、`invalid_event`、`project_not_found`、`webhook_idempotency_conflict` 和 `webhook_unavailable`。响应、audit 和错误都不得包含 signing secret 或 runner bearer token。

## 4. 最小验证

```bash
cd backend-ts
bun test \
  src/integrations/channelConnectorContracts.test.ts \
  src/cli/work.test.ts \
  src/http/workApi.test.ts \
  src/http/webhookEventsApi.test.ts \
  src/http/auth.test.ts
```

覆盖 CLI→HTTP Work create/status/result、同 audit replay、签名/过期拒绝、event normalization、external event/link audit、同 key 冲突、无 token/secret 回显和稳定错误码。测试使用 fixture SQLite 与 in-process request handler；不访问真实外部系统，也不 dispatch IM/Tracker outbox。
