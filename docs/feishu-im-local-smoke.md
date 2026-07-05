# 飞书 IM connector 本地接入与 smoke

本文用于把真实飞书应用事件接到本地 `codex-issue-runner`，并验证这条链路：

`Feishu long connection → message event → external_events inbox → PI attention decision → OK reaction → Runner/PI conversation → Feishu reply`

## 1. 创建飞书应用

1. 在飞书开放平台创建企业自建应用。
2. 记录应用凭据，只放在本地未提交配置或环境变量：
   - `FEISHU_APP_ID`
   - `FEISHU_APP_SECRET`
   - `FEISHU_VERIFICATION_TOKEN`（仅 HTTP callback 兼容模式必需；长连接模式可留空）
   - `FEISHU_ENCRYPT_KEY`（仅 HTTP callback 且启用事件加密时需要）
3. 事件订阅选择长连接模式；runner 会主动连接飞书开放平台，不需要公网域名、Request URL、ngrok 或内网穿透。
4. 订阅事件：`im.message.receive_v1`。
5. 权限建议最小化：
   - 接收消息事件：按飞书后台提示开通接收 IM 消息相关权限。
   - 发送回复：开通发送消息相关权限。
   - 快速回执表情：开通添加消息表情回复相关权限，用于 PI 收到消息后先在原消息上点一个 `OK` reaction。
   - 不需要通讯录/文件内容读取权限；附件当前只记录 metadata。

> 注意：HTTP callback endpoint 仍保留为兼容模式，不走 runner bearer token；回调鉴权依赖 verification token 与可选签名/加密。其它 `/api/*` 仍需要 runner token。

## 2. Runner 环境变量

示例 `.env.local` 或 shell export（不要提交）：

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="..."
export FEISHU_RECEIVE_MODE="websocket"

# 仅 HTTP callback 模式需要：
export FEISHU_VERIFICATION_TOKEN="..."
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
- `misconfigured`：有部分配置但缺少 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`；只有 `FEISHU_RECEIVE_MODE=callback` 时才还要求 `FEISHU_VERIFICATION_TOKEN`。
- `configured`：长连接会在 runner 进程内启动；`/api/system/status` 的 `connectors[].runtime` 可看连接状态。
- `reply_mode=draft`：issue 写回仍走 draft/outbox；普通 IM 对话会直接把 Runner/PI 回复发回原 chat，避免“发 hi 没反应”。

## 3. 本地 fixture smoke（无真实飞书配置）

仓库测试覆盖完整本地链路，并断言输出不含 secret：

```bash
cd backend-ts
bun test src/http/feishuInboxApi.test.ts src/http/imReplyOutboxApi.test.ts src/integrations/feishu.test.ts src/http/systemStatus.test.ts
```

关键断言：

- 长连接模式不需要 challenge / Request URL。
- message event 被归一化并写入 `external_events`。
- 可信消息会进入 Runner/PI conversation，并把回复发回原 chat。
- attention decision 为 `propose_issue` 时，`/api/external-events/:id/create-issue` 创建 `triage` issue。
- issue 创建后生成 `im_reply_drafts`；approve 后进入 `sync_outbox`。
- 测试输出不包含 `app_secret`、`encrypt_key`、verification token 或本地临时路径。


## 4. 完成提醒本地 smoke（无真实飞书配置）

完成提醒（completion watch）使用创建提醒时的显式 Feishu target：`target_chat_id` / `target_message_id` / `target_thread_id`。它不依赖被 watch 的 issue 自身是否存在 Feishu link，因此不会再因 watched issue 缺少 external link 走到 `missing_feishu_link` 并静默丢通知。

可复制的本地端到端 smoke：

```bash
scripts/completion-watch-smoke.mjs
```

该脚本会在临时数据库中创建 fake Feishu conversation/event，通过自然语言完成提醒命令创建一个 watch，模拟两个 watched issues 先后进入 `done` / `failed`，并断言 `sync_outbox` 只产生一条汇总通知。输出包含 `watch_id`、`watched_issue_ids`、fake conversation id 与 outbox 状态，不会触发真实飞书发送。

最小管理 API：

```bash
# list active/recent watches
curl -fsS -H "Authorization: Bearer $CODEX_RUNNER_AUTH_TOKEN" \
  "http://127.0.0.1:3008/api/pi/issue-completion-watches?status=active"

# read watch detail, watched items and notification/outbox status
curl -fsS -H "Authorization: Bearer $CODEX_RUNNER_AUTH_TOKEN" \
  "http://127.0.0.1:3008/api/pi/issue-completion-watches/<watch-id>"

# cancel active watch
curl -fsS -X POST -H "Authorization: Bearer $CODEX_RUNNER_AUTH_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"reason":"manual cancellation"}' \
  "http://127.0.0.1:3008/api/pi/issue-completion-watches/<watch-id>/cancel"
```

`/api/system/status` 的 `pi_guardian.completion_watch` 暴露关键运维计数：`active_watches`、`satisfied_pending_notification`、`failed_notification`。

## 5. 手动半真实 smoke（默认不外发）

以下命令从仓库根目录运行。只检查本地 env 是否足够，不访问外网：

```bash
scripts/feishu-smoke.mjs --mode check
```

以下脚本验证的是 HTTP callback 兼容路径，不是长连接路径。向当前 runner 发送 URL verification challenge：

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

如果显式选择 `FEISHU_RECEIVE_MODE=callback` 并配置了公开 URL，也可以用脚本打公开 URL：

```bash
scripts/feishu-smoke.mjs --mode challenge --url https://<public-host>/api/integrations/feishu/events
```

脚本会脱敏输出；不要把 `FEISHU_APP_SECRET`、`FEISHU_ENCRYPT_KEY`、`FEISHU_VERIFICATION_TOKEN` 写进命令参数。

## 6. IM 对话回复与 reply draft / outbox

长连接收到可信普通消息后，runner 会把消息送进 Runner/PI conversation，并把返回文本发回原 chat。

issue 关联写回仍走 draft/outbox 安全边界。查看草稿：

```bash
curl -fsS -H "Authorization: Bearer $CODEX_RUNNER_AUTH_TOKEN" \
  "http://127.0.0.1:3008/api/im-reply-drafts?source=feishu"
```

批准草稿后进入待发送 outbox：

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

如果只想本地观察 issue 写回，不要执行 approve/dispatch；如果不想真实收发 IM，关闭飞书应用事件订阅或清空 App Secret。

## 7. 常见排障

- 长连接没连上：先看 `system status` 中 `connectors[].runtime.state/last_error`；通常是 App ID/App Secret、应用权限或事件订阅模式问题。
- HTTP callback URL verification 失败：先看 `system status` 中 `connectors=feishu:<state>`；`misconfigured` 通常是 callback 模式缺 token/secret。
- callback message 收到 503：connector 未 `configured`。
- callback message 收到 401：verification token 不匹配，或启用 `FEISHU_ENCRYPT_KEY` 后签名头缺失/错误。
- message 收到 202 但没有 issue：检查 `FEISHU_PROJECT_MAPPINGS`、allowlist，以及 `external_events.summary.attention_decision`。
- 真实飞书发消息没进入 runner：优先看长连接 runtime 状态，不要先排公网域名。
- 飞书没收到 Runner 回复：检查发送消息权限、allowed chat/user、`external_links` 是否已有 `feishu_agent_reply` 去重记录，以及 Runner/PI conversation 是否报错。
- 线上调试只贴 `raw_payload_ref=sha256:...`、状态码和脱敏摘要，不贴飞书 token/secret 原文。
