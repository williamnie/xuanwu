# PI 飞书 IM connector v0 契约

本契约只定义 PI 首个真实 IM 通道的配置、事件归一化与安全边界；默认使用飞书长连接接收事件，本机 runner 主动连接飞书开放平台，不要求公网域名。

## 配置来源

仅从环境变量或本地未提交配置读取，不写入仓库：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_VERIFICATION_TOKEN`
- `FEISHU_ENCRYPT_KEY`（可选，启用飞书事件加密时需要）
- `FEISHU_RECEIVE_MODE`：默认 `websocket`；只有兼容旧 Webhook 时才设为 `callback`。
- `FEISHU_ALLOWED_CHAT_IDS` / `FEISHU_ALLOWED_USER_IDS`：逗号或分号分隔 allowlist。
- `FEISHU_PROJECT_MAPPINGS`：例如 `chat:oc_x=codex-issue-runner,user:ou_x=ops-runner`。

未配置 required secrets 时服务仍应启动，connector 状态为 `disabled`；部分配置缺失时为 `misconfigured`；完整配置后才为 `configured`。状态输出只能暴露 configured/count/missing 信息，不输出 token/secret 原文。

## 归一化消息模型

飞书 message event 归一化为：

- `message_id`
- `chat_id`
- `chat_type`
- `sender`：`type/id/open_id/tenant_key`
- `mentions[]`：`id/name/tenant_key`
- `text`
- `attachments[]`：仅 metadata，图片不下载
- `thread_id` / `root_id`
- `timestamp`
- `raw_event_ref`
- `source_id` / `dedupe_key`

Dedupe/source 约定：`feishu:message:<message_id>`。写入 `external_events` 时 `source=feishu`、`external_id=<message_id>`、`dedupe_key=<source_id>`、`trust_level=untrusted`。

## v0 支持范围

- 接收文本消息和 mention。
- 图片附件只记录 metadata，不下载、不解析内容。
- 不自动回复；任何 IM 外部写回默认为 draft/proposal，自动发送必须经过 policy/action gate。
- PI 可以只读 repo/issue/session/project/memory 上下文并生成 context pack / issue proposal；真正代码修改仍由 runner/executor 完成。

## 飞书 Open Platform 事件接收门禁

默认接收模式是长连接：

- runner 进程启动后用 App ID / App Secret 建立 WebSocket 长连接。
- 无需 Request URL、公网域名、内网穿透或防火墙白名单。
- 长连接事件复用同一套归一化、allowlist、project mapping 与 `external_events` 去重逻辑。

兼容 HTTP callback 时必须处理：

- URL verification challenge。
- 事件签名/verification token 校验。
- 可选事件加密解密（依赖 `FEISHU_ENCRYPT_KEY`）。
- 日志、审计、测试 fixture 必须脱敏。

## 本地 smoke 与接入文档

完整本地/半真实 smoke、飞书应用配置、权限、禁用自动回复与排障路径见：

- [飞书 IM connector 本地接入与 smoke](./feishu-im-local-smoke.md)
