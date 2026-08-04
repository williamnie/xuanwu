# ADR-XW-0068：OpenClaw Gateway 可选适配

- 状态：Accepted（W0 additive optional adapter）
- 日期：2026-07-18
- 路线 issue：XW P09.06 / Runner #722
- 硬依赖：[ADR-XW-0063](0063-approval-action-gate.md)、[ADR-XW-0064](0064-channel-connector-contract.md)、[ADR-XW-0065](0065-cli-webhook-channel-adapter.md)
- 实现：`backend-ts/src/integrations/openclawGatewayAdapter.ts`
- sandbox fixture / 测试：`docs/fixtures/openclaw-gateway-v1.fixture.json`、`backend-ts/src/integrations/openclawGatewayAdapter.test.ts`

## 决策与范围

OpenClaw 可以作为外层多渠道 gateway；它的 plugin 调用本适配器，把请求翻译为**已存在**的 Runner Webhook、Work、PI approval 与 Handoff HTTP/CLI 表面。它不是新的 Runner、Work writer、outbox、approval authority，也不嵌入或复制 OpenClaw 的 memory/runtime。

| 需要 | adapter 行为 | 唯一 source of truth |
| --- | --- | --- |
| Work create | `build/signOpenClawWorkCreate` 生成 P09.03 的已签名 `POST /api/integrations/webhook/events` | `issues` / `issue_events`，以及 `external_events` / `external_links` audit |
| Work query | gateway 使用既有 `GET /api/works/:id`，或 `xuanwu work status/result` | Work HTTP projection |
| approval callback | `buildOpenClawApprovalCallback` 只生成已有的 bearer-authenticated `POST /api/pi/approval-requests/:id/resolve` | `pi_approval_requests`、resolver audit、provider acknowledgement |
| Handoff response | `GET /api/handoffs/:id` 后用 `buildOpenClawHandoffResponse` 返回原会话 | derived Handoff、Evidence、Git/delivery audit |

`OPENCLAW_GATEWAY_MANIFEST` 声明 `work.create`、`approval.callback`、Work/Handoff read capability，且所有 mutating capability 都要求授权。它仅通过 P09.01 connector contract 校验；不会注册常驻 receiver、provider、memory store 或出站 dispatcher。

## Identity / session mapping

gateway 给 adapter 传入 `{ channel_id, user_id, session_id }`。adapter 用稳定 SHA-256 截断值生成：

- `identity_ref = openclaw:identity:<digest(channel,user)>`
- `session_ref = openclaw:session:<digest(channel,user,session)>`

同一输入的 retry 得到同一 event/idempotency key；不同 channel、user 或 session 得到不同 refs，避免跨渠道串会话。Work webhook 的 raw inbound event 保留这些 refs 和 source event ref 作为审计上下文，但 Runner 不建立 OpenClaw session table，也不以此成为 OpenClaw memory 的 owner。

OpenClaw 自己可以在**它自己的活动会话中**保存 `session_ref -> runner_session_id` 的短生命周期 binding。不得把该 binding 迁入 Runner 或添加平行持久化 runtime；重启后由 OpenClaw 重建并重新查询 Runner authority。

## 调用边界

### Work create / query

```ts
const signed = signOpenClawWorkCreate(input, process.env.XUANWU_WEBHOOK_SIGNING_SECRET!);
await fetch(`${runner}/api/integrations/webhook/events`, {
  method: "POST", headers: signed.headers, body: signed.raw_body
});
// 收到 poll URL 后，使用 bearer auth 查询 /api/works/:id。
```

`XUANWU_WEBHOOK_SIGNING_SECRET` 仅用于 HMAC header，绝不放进 body、OpenClaw message、Runner audit 或日志。P09.03 的 timestamp、idempotency、raw-payload conflict 与 external-event/link audit 仍是唯一 ingress 语义。

### Approval callback

gateway 必须先通过现有 bearer-authenticated read API 获得 pending request，并将其 `session_id`（无则 `thread_id`）和**本会话已绑定的** `runner_session_id` 交给 `buildOpenClawApprovalCallback`。两者不同或空值时函数 fail closed，不能发起 resolve。函数只生成 request，不决定 approve/deny，也不调用 provider；实际 resolver 继续执行既有 deterministic safety policy、scope constraint、resolver attempt audit 与 provider acknowledgement。

OpenClaw 的 LLM/message output 不能直接拼 `decision` 请求、不能拿 webhook secret，也不能调用公开 callback route：approval resolver 仍要求 Runner bearer auth 和精确 session binding。外层 gateway 必须以已认证的人类 action 作为 callback actor，并记录其自身 transport audit。

### Handoff response

adapter 只把已读 Handoff projection 包回原 `OpenClawSessionMapping`，不会主动 `fetch`、投递消息或标记 Handoff delivered。任何外部发布、Git/Tracker 或通知仍必须经过既有 Action Gate、approval 和 durable outbox/provider receipt；不得把 Handoff readback 当成外写成功。

## 迁移、回滚与删除门禁

W0 **双读=0、双写=0**。OpenClaw 是可选 client adapter：不存在时，Feishu、CLI、Webhook、Git、Tracker 和 PI runtime 完全不变；启用后也只调用上述 authority，不复制状态。

- 回滚：停止加载 OpenClaw plugin / 不再调用 adapter。已创建 Work、external-event/link、approval audit 和 Handoff projection 不删除、不反写。
- 若未来要持久化 OpenClaw identity/session、主动 delivery 或新 connector receiver，必须另立迁移 ADR，逐字段指定 source of truth、最多两个正式 release 的 W1/W2 dual-read 期限、无副作用 parity、rollback 和 consumer-zero 删除门禁；本期不得临时旁路。
- 最终删除遵循 P11/G7：replay/recovery、idempotency/audit parity、连续一个 release legacy consumer=0、fresh backup + isolated restore、retained rollback artifact 和明确非 LLM cutover approval。

## 最小验证

```bash
cd backend-ts
bun test src/integrations/channelConnectorContracts.test.ts \
  src/integrations/openclawGatewayAdapter.test.ts \
  src/http/webhookEventsApi.test.ts
```

覆盖 sandbox fixture、同 session replay、跨渠道不串、webhook HMAC 无 secret body、approval 跨 Runner session fail-closed、Handoff transport-only response，以及既有 webhook audit/replay。
