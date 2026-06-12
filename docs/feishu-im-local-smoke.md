# 飞书 IM connector 本地接入与 smoke

本文用于把真实飞书应用事件打到本地 `codex-issue-runner`，并验证这条链路：

`challenge → message event → external_events inbox → PI attention decision → triage issue proposal/create → reply draft → sync outbox`

## 1. 创建飞书应用

1. 在飞书开放平台创建企业自建应用。
2. 记录应用凭据，只放在本地未提交配置或环境变量：
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
   - `FEISHU_VERIFICATION_TOKEN`
   - `FEISHU_ENCRYPT_KEY`（可选；如果在飞书后台启用事件加密则必须配置）
3. 事件订阅里配置 Request URL：
   - 本地直连：`http://127.0.0.1:3008/api/integrations/feishu/events`
   - 通过 ngrok/内网穿透：`https://<public-host>/api/integrations/feishu/events`
4. 订阅事件：`im.message.receive_v1`。
5. 权限建议最小化：
   - 接收消息事件：按飞书后台提示开通接收 IM 消息相关权限。
   - 发送回复（只在手动批准 outbox 后使用）：开通发送消息相关权限。
   - 不需要通讯录/文件内容读取权限；附件当前只记录 metadata。

> 注意：飞书 callback endpoint 是公开回调路径，不走 runner bearer token；回调鉴权依赖 verification token 与可选签名/加密。其它 `/api/*` 仍需要 runner token。

## 2. Runner 环境变量

示例 `.env.local` 或 shell export（不要提交）：

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="..."
export FEISHU_VERIFICATION_TOKEN="..."
# 如果飞书后台启用了 Encrypt Key：
export FEISHU_ENCRYPT_KEY="..."

# 可选 allowlist，配置后仅允许指定 chat/user 触发 attention：
export FEISHU_ALLOWED_CHAT_IDS="oc_xxx,oc_yyy"
export FEISHU_ALLOWED_USER_IDS="ou_xxx"

# 建议至少配置 chat/user 到 runner project 的映射：
export FEISHU_PROJECT_MAPPINGS="chat:oc_xxx=codex-issue-runner,user:ou_xxx=codex-issue-runner"
```

启动或重启 runner 后检查摘要：

```bash
codex-issue-runner system status --json | jq '.connectors[] | select(.id=="feishu")'
codex-issue-runner system status
```

状态语义：

- `disabled`：未配置任何飞书必需项，服务仍可启动，本地测试不依赖真实飞书。
- `misconfigured`：有部分配置但缺少 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_VERIFICATION_TOKEN`。
- `configured`：callback 可以接收 challenge/message。
- `auto_reply=false` / `reply_mode=draft`：不会自动把 PI 回复发回飞书；只生成 draft/outbox，发送需要显式 approve + dispatch。

## 3. 本地 fixture smoke（无真实飞书配置）

仓库测试覆盖完整本地链路，并断言输出不含 secret：

```bash
cd backend-ts
bun test src/http/feishuInboxApi.test.ts src/http/imReplyOutboxApi.test.ts src/integrations/feishu.test.ts src/http/systemStatus.test.ts
```

关键断言：

- challenge 返回 `{ challenge }`。
- message event 被归一化并写入 `external_events`。
- attention decision 为 `propose_issue` 时，`/api/external-events/:id/create-issue` 创建 `triage` issue。
- issue 创建后生成 `im_reply_drafts`；approve 后进入 `sync_outbox`。
- 测试输出不包含 `app_secret`、`encrypt_key`、verification token 或本地临时路径。

## 4. 手动半真实 smoke（默认不外发）

以下命令从仓库根目录运行。只检查本地 env 是否足够，不访问外网：

```bash
scripts/feishu-smoke.mjs --mode check
```

向当前 runner 发送 URL verification challenge（用于验证 callback/token/config，不需要真实飞书）：

```bash
scripts/feishu-smoke.mjs --mode challenge --addr 127.0.0.1:3008
```

向当前 runner 发送一条测试 message event：

```bash
scripts/feishu-smoke.mjs \
  --mode message \
  --addr 127.0.0.1:3008 \
  --chat-id oc_xxx \
  --user-id ou_xxx \
  --text "@PI 帮我实现这个折叠面板功能"
```

如果飞书后台已通过 ngrok/内网穿透指向本机，也可以让真实飞书发事件；或者用脚本打公开 URL：

```bash
scripts/feishu-smoke.mjs --mode challenge --url https://<public-host>/api/integrations/feishu/events
```

脚本会脱敏输出；不要把 `FEISHU_APP_SECRET`、`FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN` 写进命令参数。

## 5. reply draft / outbox 与禁用自动回复

当前契约默认 `auto_reply=false`，所以 PI 只会创建回复草稿：

```bash
curl -fsS -H "Authorization: Bearer $CODEX_RUNNER_AUTH_TOKEN" \
  "http://127.0.0.1:3008/api/im-reply-drafts?source=feishu"
```

批准草稿后才进入待发送 outbox：

```bash
curl -fsS -X POST -H "Authorization: Bearer $CODEX_RUNNER_AUTH_TOKEN" \
  "http://127.0.0.1:3008/api/im-reply-drafts/<draft-id>/approve"
```

真正发送需要再显式 dispatch：

```bash
curl -fsS -X POST -H "Authorization: Bearer $CODEX_RUNNER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":5}' \
  "http://127.0.0.1:3008/api/sync-outbox/dispatch"
```

如果只想本地观察，不要执行 approve/dispatch；或者保持 `FEISHU_APP_SECRET` 未配置，使 connector 处于 `disabled/misconfigured`。

## 6. 常见排障

- 飞书 URL verification 失败：先看 `system status` 中 `connectors=feishu:<state>`；`misconfigured` 通常是缺 token/secret。
- message 收到 503：connector 未 `configured`。
- message 收到 401：verification token 不匹配，或启用 `FEISHU_ENCRYPT_KEY` 后签名头缺失/错误。
- message 收到 202 但没有 issue：检查 `FEISHU_PROJECT_MAPPINGS`、allowlist，以及 `external_events.summary.attention_decision`。
- 已创建 issue 但飞书没收到回复：这是默认行为；先查 `im_reply_drafts`，再人工 approve/dispatch。
- 线上调试只贴 `raw_payload_ref=sha256:...`、状态码和脱敏摘要，不贴飞书 token/secret 原文。
