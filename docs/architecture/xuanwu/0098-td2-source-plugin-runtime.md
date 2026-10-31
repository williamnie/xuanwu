# TD-2：来源插件运行时与合同

- 状态：Draft
- 日期：2026-10-31
- 上游：ADR-XW-0098 第 2.4 节；TD-0 第 3 节、5.2；TD-1 第 3、5、10.1 节（本文按 TD-1 的事件要求定义合同）
- 相关：ADR-XW-0064（Channel 与 Connector 统一契约）、ADR-XW-0076（Health、Secret 引用与诊断）、`docs/design/remote-agent-plan.md`（远程节点）
- 状态合同：ADR-XW-0088；全部 `preview / not live-tested`，直到第 13 节对应步骤完成实测

## 1. 目标与范围

**目标**：玄武能安装、配置、启停"来源插件"，由插件持续收取用户本人渠道里的消息，规范化成 TD-1 要求的标准事件交给 Inbox；插件能按会话读历史；能在 Action Gate 批准后代发消息。插件可以跑在中心机器上，也可以跑在远程节点上（用户的钉钉 `dws` 只在 Mac mini 上授权）。

**本文负责**：

1. 插件的定位：与 ADR-0064 的 `event_source` / `external_target` 的关系，与现有 CLI connector、原生 channel 的边界。
2. manifest 格式。
3. 插件与宿主之间的协议：事件、游标、`history`、`send`、`auth`、`setup`。
4. 插件运行时：进程管理、重启、健康、限流、断档补拉。
5. 插件宿主位置：本机或远程节点。
6. 数据模型、设置与秘密、目录与安装。
7. 首批官方插件的要求与测试。

**不在本文**：会话档位与分拣（TD-1）；授权规则（TD-3）；插件中心页面（TD-5）；"联系我"复用插件发送（TD-6）。

## 2. 现状（已核）

| 现有部件 | 位置 | 能复用的 | 缺的 |
| --- | --- | --- | --- |
| CLI connector manifest `pi-cli-connector.v0` | `pi/intake/cliConnectorManifest.ts` | 命令模板校验（无 shell、`{{input.x}}`）、退出码合同、stderr 摘要、env 声明（禁止写值）、超时 | 只有"工具式"命令，必须有 `commands`；没有常驻、游标归宿主、history、send、setup、settings |
| CLI 运行器 | `pi/intake/cliToolRunner*.ts` | `buildAllowedEnv` 最小环境、秘密值脱敏、stdout 上限、超时 | 只支持一次性 JSON 输出，不支持 JSONL 流 |
| 注册表 | `pi/intake/cliConnectorProvider.ts` | 从配置目录加载 manifest、诊断 | 没有安装状态、启停、设置 |
| 原始事件入库 | `pi/intake/cliRawEventSync.ts` | 字段兼容映射、`dedupe_key` | 不认识会话、本人 |
| Connector 合同 | `integrations/channelConnectorContracts.ts`（ADR-0064） | `event_source` / `external_target` 种类；`InboundEnvelope`；`OutboundEnvelope`（必须带 `action_gate_ref`，authority 只能是确定性策略或人工批准）；`ConnectorHealth` 五态；`ConnectorCursor` | 没有任何实现在用它承载外部来源 |
| Secret | `security/secrets/*`（`secret://` 引用，钥匙串后端） | 插件设置里的秘密项 | — |
| 诊断 | `integrations/connectorDiagnostics*`（ADR-0076） | 健康与诊断展示 | 不认识插件 |
| 远程节点 | `nodes/*`，设计见 `remote-agent-plan.md` | 同一个 `xuanwu` 程序、节点主动连接、SSE 下行 + POST 上行、`req/res` + 带 `seq` 的事件流、断线缓冲与按 `ackSeq` 补发 | 只能跑 provider；明确"不提供任意命令执行通道" |

朱雀协议（`zhuque/src/sources.ts`、`plugins.ts`）已经在钉钉、飞书、Gmail 上跑过两周，本文以它为底稿，按玄武的合同和 TD-1 的要求修改。

## 3. 定位与边界

### 3.1 来源插件是什么

一个来源插件 = 一个目录：manifest + 几个薄脚本。它在 ADR-0064 的分类里同时是：

- `event_source`：收消息，产出 `InboundEnvelope`；
- `external_target`：代发消息，只接受带 `action_gate_ref` 的 `OutboundEnvelope`；
- 加上一个只读能力 `history`。

插件**只做渠道知识**：收、规范化、判断 `is_self`、维护渠道侧游标、读历史、发送。插件不调用 LLM，不做分拣，不决定动作。

### 3.2 与现有部件的边界

| 部件 | 关系 |
| --- | --- |
| 工具式 CLI connector（v0） | 保留，给 Pi 按需调用的工具用。一个插件的 manifest 可以同时声明 `source` 和 `commands`（第 4 节），两者走各自的路径 |
| 原生 channel（飞书机器人、Telegram，ADR-0064 `channel`） | **不迁**。它们是对话入口：用户本人对玄武说话，内容是指令（仍受 Action Gate 约束）。来源插件读到的永远是数据 |
| 飞书 | 拆分：机器人 = 原生 channel，不动；"以用户本人身份读写飞书消息" = 来源插件 `feishu-user` |
| `feishuIntakeBridge` | TD-1 第 12 节已定：本阶段不动 |
| `external_events` | 插件事件写入同一张表（TD-1 4.3 的新列），不另建事件表 |
| outbox / Action Gate | `send` 只是 outbox 的一个投递目标，不新增写路径 |

## 4. Manifest

### 4.1 版本

新版本 `pi-cli-connector.v1`，是 v0 的超集：

- `commands` 变为可选；
- 新增 `source`、`settings`、`requires`、`setup`、`auth.check` / `auth.login`；
- v0 manifest 继续按 v0 解析，行为不变。

解析器拆成 `parseConnectorManifest`（按 `manifest_version` 分派），v0 的校验函数原样复用。

### 4.2 结构（以钉钉为例）

```json
{
  "manifest_version": "pi-cli-connector.v1",
  "id": "dingtalk",
  "name": "钉钉",
  "kind": "cli",
  "version": "0.4.0",
  "description": "通过 dws 个人事件长连接接收单聊、@我 和指定群的消息；以用户本人身份读历史、代发。",
  "requires": [
    { "bin": "dws", "check": { "executable": "dws", "args": ["version"] },
      "install_doc": "https://github.com/DingTalk-Real-AI/dingtalk-workspace-cli" }
  ],
  "setup": null,
  "auth": {
    "type": "custom",
    "check": { "executable": "dws", "args": ["auth", "status", "--readonly", "--format", "json"] },
    "login": { "executable": "dws", "args": ["auth", "login", "--device"] }
  },
  "settings": [
    { "key": "DWS_KINDS", "label": "监听范围", "type": "multi",
      "options": ["at-me", "all-direct", "all-group"], "default": ["at-me", "all-direct"] },
    { "key": "DWS_GROUPS", "label": "另外监听的群", "type": "list", "default": [] },
    { "key": "DWS_SELF_ID", "label": "你的 openDingTalkId", "type": "text", "required": true,
      "role": "self_id" }
  ],
  "source": {
    "mode": "stream",
    "command": { "executable": "bun", "args": ["run.ts"] },
    "stop_grace_ms": 20000,
    "default_tier": { "direct": "triage", "group": "context_only" },
    "history": { "command": { "executable": "bun", "args": ["history.ts"] }, "timeout_ms": 30000 },
    "send": { "command": { "executable": "bun", "args": ["send.ts"] }, "timeout_ms": 30000,
              "idempotent": true },
    "catch_up": "history"
  }
}
```

### 4.3 字段规则

| 字段 | 规则 |
| --- | --- |
| `id` | `^[a-z0-9][a-z0-9._-]*$`，即 Inbox 的 `source`。宿主按插件 id 填事件的 `source`，**插件不能冒充别的来源** |
| `requires[]` | 只检测程序在不在（可带检测命令），不替用户安装第三方程序 |
| `setup` | 可选；安装和升级时在插件目录里跑一次（如 `bun install --frozen-lockfile`），失败则安装失败。只能装插件目录里锁文件声明的依赖 |
| `auth.check` | 退出码 0 = 已授权。宿主只看退出码和脱敏后的首行输出 |
| `auth.login` | 交互式登录，输出（链接、设备码）脱敏后展示在页面上。凭据由插件背后的程序自己保管，玄武不读也不存 |
| `settings[]` | 类型：`text` / `list` / `select` / `multi` / `bool` / `secret`。值通过环境变量传给插件，不拼进命令行。`secret` 类型的值存 secret store，manifest 里不能有默认值 |
| `settings[].role` | 宿主认识的语义：`self_id`（本人 ID，可多个，供 TD-1 校验 `is_self`）。其余设置宿主不解析 |
| `source.mode` | `stream`（常驻）或 `poll`（定时跑一次） |
| `source.interval_ms` / `timeout_ms` | 仅 poll；间隔 10s ~ 1d，默认 300s |
| `source.stop_grace_ms` | 仅 stream；1s ~ 120s，默认 15s |
| `source.default_tier` | 插件建议的默认档位（TD-1 3.2 第 3 级），按 `chat_type` 给 |
| `source.history` | 可选，读会话历史 |
| `source.send` | 可选，代发。`idempotent: true` 表示插件会把幂等键传给下游，或自己记录发过的 id |
| `source.catch_up` | `none` / `history` / `cursor`：断档后怎么补（第 7.4 节） |
| 命令 | 一律 `{executable, args}`，复用 v0 的模板校验：无 shell 语法，参数不以 `-` 开头的用户值插入 |

## 5. 事件协议

### 5.1 输出格式

插件往 stdout 写 JSONL，每行一个对象：

```jsonc
// 事件
{ "type": "event",
  "id": "msgXXXX",                    // 渠道内唯一，宿主据此去重
  "occurred_at": "2026-10-31T08:00:00Z",
  "chat": { "key": "cidHRig...", "type": "direct", "label": "张三（单聊）" },
  "thread_key": "",                    // 可选
  "sender": { "key": "DRhld...", "name": "张三" },
  "is_self": false,
  "text": "…",
  "reply_target": { "chat": "direct", "openDingtalkId": "…" },  // 宿主不解析，原样交回 send
  "hints": { "mentions_self": true, "system_notice": false },   // 只当数据
  "attachments": [{ "kind": "image", "name": "a.png", "ref": "…" }],
  "url": null }

// 游标（可选）
{ "type": "cursor", "cursor": "…opaque…" }

// 状态（可选，stream 用）
{ "type": "status", "state": "connected" | "reconnecting" | "auth_required", "detail": "…" }
```

### 5.2 必填与校验

| 字段 | 要求 | 不满足时 |
| --- | --- | --- |
| `id` | 非空，≤ 512 | 丢弃该行，计入 `invalid_lines` |
| `occurred_at` | ISO 时间；秒或毫秒时间戳也接受并转换 | 丢弃 |
| `chat.key` | 非空、稳定。**必须是会话 ID，不能是发送方**（TD-1 10.1 的教训） | 丢弃 |
| `chat.type` | `direct` / `group` / `email_thread` / `other` | 按 `other` |
| `sender.key` | 非空 | 丢弃 |
| `is_self` | 布尔，必填 | 丢弃 |
| `text` | ≤ 8000 字，超出截断并标 `truncated` | — |
| `reply_target` | 对象，≤ 4KB | 缺失时该事件不能被回复（TD-1 不会产生回复草稿） |
| 单行 | ≤ 256KB | 丢弃，健康记 `degraded` |

宿主做的事：

1. 按插件 id 填 `source`，`dedupe_key = id`。
2. **再校验 `is_self`**：`sender.key` 在 `self_id` 设置里时强制为真（插件说假、宿主说真，以真为准，并记诊断）。
3. 转成 ADR-0064 的 `InboundEnvelope`（`event_type = "message"`），交给 TD-1 的 `inboxIngest`。
4. `trust_level` 固定为 `untrusted`。

### 5.3 游标

- **poll**：宿主把上次保存的游标通过环境变量 `XUANWU_CURSOR` 传入；只有进程**成功退出**时，才保存本次输出的最后一个游标。失败时本次事件仍入库（靠去重防重复），游标不前进。
- **stream**：游标行表示"在它之前的事件都已输出"。宿主在把它之前的事件**写入数据库之后**再保存游标。重启时同样通过 `XUANWU_CURSOR` 传入，渠道支持断点续传的插件据此续传。
- 游标对宿主是不透明字符串，≤ 4KB，按 ADR-0064 `ConnectorCursor` 存（`connector_id`、`scope = 插件实例`、`position`）。

### 5.4 本人发出的消息与回声

- 本人在其他客户端发的消息：`is_self = true`，归到它所在会话的 `chat.key`（不是本人自己的"会话"）。
- 玄武经 `send` 代发的消息，渠道会再推回来，同样是 `is_self = true`。宿主用 `send` 回执里的 `provider_message_ref` 匹配，给这条事件标 `origin = xuanwu_sent`，TD-1 的影子评测不把它当作"用户本人回复"。

## 6. history 与 send

### 6.1 history

- 调用：stdin 写一行 `{"chat": {...}, "reply_target": {...}, "start": ISO, "end": ISO, "limit": 1..100}`。
- 输出：同 5.1 的事件行，**包含本人发的**，`is_self` 必须正确。
- 宿主处理：按 `id` 去重写入 `external_events`。来自 history 的事件标 `origin = history`，在 TD-1 里一律是 `inbox_status = context`；只有第 7.4 节的断档补拉才会把它们标为 `pending`。
- 退出码非 0 或超时：本次失败，TD-1 退回只用本地记录。

### 6.2 send

- 只由 outbox 投递器调用，输入必须来自 ADR-0064 的 `OutboundEnvelope`：带 `action_id`、`idempotency_key`、`action_gate_ref`，authority 是 `human_approval`（第一版只可能是这个，见 TD-0 D6）。
- stdin：`{"idempotency_key": "...", "reply_target": {...}, "text": "...", "quote_ref": "..."}`。
- stdout：最后一行 `{"type": "receipt", "provider_message_ref": "..."}`（可选）。
- 退出码：`0` 已发出；`3` 结果未知；其他是没发出去。**超时按结果未知处理。**
- **结果未知绝不重发**（与 OCS 铁律一致）：outbox 标 `unknown`，进 Attention，由用户确认。
- 没发出去的：按 outbox 现有重试策略，最多 2 次，幂等键不变。
- 文本上限 2000 字；内容经 stdin 传，不进命令行。

## 7. 运行时

### 7.1 组件

```
PluginCatalog ─ 发现官方插件与本地插件，解析 manifest
PluginRegistry ─ 安装状态、设置、启停（数据库）
PluginSupervisor ─ 每个已启用插件一个实例：起进程、读输出、重启、健康
PluginHost（接口）
  ├─ LocalPluginHost ─ 在中心机器上起进程
  └─ NodePluginHost ─ 经远程节点起进程（第 8 节）
SourceEventSink ─ 校验、转 InboundEnvelope、交给 TD-1 inboxIngest、推进游标
```

新目录 `backend-ts/src/integrations/sourcePlugins/`。挂在 `runtime/core.startup.ts`，只在 `core` 角色运行。

### 7.2 进程规则

| 项目 | 规则 |
| --- | --- |
| 工作目录 | 插件目录 |
| 环境 | 复用 `buildAllowedEnv`：只给 `PATH`、`HOME`、`LANG`、`TZ`，加插件设置和 `XUANWU_CURSOR`、`XUANWU_SOURCE`。不给玄武的任何环境变量和凭据 |
| 进程组 | 独立进程组（detached），停止时整组处理 |
| 停止 | 关 stdin → 给进程组发 SIGTERM → 等 `stop_grace_ms` → SIGKILL。长连接客户端要靠正常退出去服务端取消订阅，直接 kill 会留下脏订阅（朱雀踩过） |
| stderr | 一直读走（不读会塞满管道卡住插件），只保留最后 4KB，脱敏后进健康信息 |
| 单实例 | 同一插件实例同时只有一个进程；poll 上一次没结束时跳过本次 |
| 限流 | 每插件 50 条/秒，超出的行丢弃并标 `degraded`；用于防插件失控，不是业务限流 |

### 7.3 重启与健康

- stream 进程退出：退避重启 5s → 15s → 1min → 5min（上限），连续稳定运行 10 分钟后退避清零。
- 1 小时内重启 ≥ 10 次：停止重启，状态 `failed`，进 Attention。
- `auth.check` 失败或插件输出 `status: auth_required`：停止重启，状态 `failed`（原因 `auth_required`），页面给出登录入口。
- 健康映射到 ADR-0064 的五态：

| 状态 | 条件 |
| --- | --- |
| `disabled` | 未启用 |
| `healthy` | 进程在运行（stream）或最近一次成功（poll），且没有降级条件 |
| `degraded` | 有无效行、限流丢弃、stderr 报错，或 history / send 最近失败 |
| `disconnected` | 进程退出正在退避重启，或节点离线（第 8 节） |
| `failed` | 重启熔断、未授权、依赖缺失 |

- 健康经 ADR-0076 的诊断接口暴露，复用 `ConnectorDiagnosticsPanel` 的数据形状。

### 7.4 断档补拉

stream 插件在进程重启、节点离线期间会漏消息。按 `source.catch_up` 处理：

| 取值 | 做法 |
| --- | --- |
| `cursor` | 渠道支持按游标续传，插件自己补，宿主不做额外工作 |
| `history` | 宿主记录断档区间 `[断开时间, 恢复时间]`。恢复后，对最近 7 天有消息的会话（上限 50 个）逐个调 `history`，补回区间内的消息。补回的他人消息标 `pending`、进入分拣；本人消息标 `context` |
| `none` | 只记断档，在 Inbox 页面上提示"某段时间可能漏收" |

钉钉 `dws event +listen-im` 是否支持续传未核实（第 14 节），先按 `history` 实现。

## 8. 插件宿主位置：本机或远程节点

### 8.1 为什么要支持节点

用户的 `dws` 只在 Mac mini 上授权。渠道 CLI 的登录态和机器绑定是常态（`lark-cli`、Gmail 回环 OAuth 也是），所以插件必须能跑在"有登录态的那台机器"上，事件回到中心。

### 8.2 做法

复用远程节点（`remote-agent-plan.md`）的连接，不另起连接：

- 节点与中心是同一个 `xuanwu` 程序，**官方插件随程序一起发布**，节点本地就有插件文件，中心不往节点推代码。
- 插件实例记录宿主：`host = "local"` 或 `host = "node:<node_id>"`。
- 节点协议新增 `req` 方法：`plugin.start`（带插件 id、版本、设置、游标）、`plugin.stop`、`plugin.history`、`plugin.send`、`plugin.auth_check`、`plugin.status`。
- 插件输出作为 `event` 流上报，`runRef = "plugin:<实例 id>"`，沿用 `seq` 与 `ackSeq` 补发机制。节点断线期间事件缓冲在节点上（上限 8MB），重连后补发；超出上限时丢最旧的事件，标断档，由 7.4 补拉。
- 中心负责校验与入库（第 5.2 节），节点只转发原始行。
- 秘密类设置随 `plugin.start` 下发，只在节点进程内存里，不写节点磁盘。
- 节点离线：实例状态 `disconnected`；`send` 不可用（outbox 标失败，可重试）；`history` 不可用（TD-1 退回本地记录）。

### 8.3 节点的安全边界

`remote-agent-plan.md` 明确"节点不提供任意命令执行通道"。来源插件不能破坏这一点：

- 节点只运行**随程序发布的官方插件**，按插件 id 和版本匹配本地文件。本地自定义插件只能在中心本机运行。
- 节点配置新增 `allowedPlugins`（默认空 = 拒绝所有插件），必须显式写 `["dingtalk"]` 才能在该节点上跑钉钉插件。
- 中心下发的只有插件 id、设置值和游标，不下发命令行。

## 9. 数据模型

### 9.1 `source_plugins`（新表）

```sql
create table if not exists source_plugins (
  id text primary key,                      -- 实例 id，第一版 = 插件 id（每个插件一个实例）
  plugin_id text not null,
  version text not null,
  origin text not null,                     -- catalog | local
  host text not null default 'local',       -- local | node:<node_id>
  enabled integer not null default 0,
  settings_json text not null default '{}', -- 非秘密设置
  secret_refs_json text not null default '{}', -- key → secret://...
  cursor text not null default '',
  health_json text not null default '{}',
  gap_json text not null default '[]',      -- 未补齐的断档区间
  installed_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

每个插件第一版只允许一个实例（一个钉钉账号）。多账号以后再说，表结构已留了 `id` 与 `plugin_id` 分开。

### 9.2 审计

以下操作写入现有审计（`pi_action_events` 或 settings 审计，二选一，实现时以现有 settings 审计为准）：安装、升级、卸载、启用、停用、修改设置（秘密只记"已修改"）、修改宿主、登录发起。

### 9.3 本人身份

`role = self_id` 的设置值就是该来源的本人 ID 列表。TD-1 的 `inboxIngest` 通过 `PluginRegistry.selfIds(source)` 读取，不另存。

## 10. 目录、安装与升级

- **官方目录**：仓库 `backend-ts/plugins/<id>/`，随程序发布，代码审查过。首批：`dingtalk`、`feishu-user`、`gmail`、`jsonl-file`。
- **本地插件**：数据目录 `plugins/<id>/`，页面上标"未经审查"，只能在中心本机运行。
- **安装**：校验 manifest → 检测 `requires` → 跑 `setup` → 写 `source_plugins`（默认不启用）。
- **升级**：官方插件随程序升级。版本变化时，重跑 `setup`；已启用的实例停止后用新版本启动；设置按 key 保留，新增的 key 取默认值，删除的 key 丢弃并记审计。
- **卸载**：停止、删除实例记录；已入库的事件不删。

## 11. 首批官方插件

| 插件 | 来源 | 必须修改的地方 | 测试 |
| --- | --- | --- | --- |
| `dingtalk` | 朱雀 `plugins/dingtalk` | `chat.key` 用 `conversation_id`（TD-1 10.1 的 bug）；单聊的 `reply_target` 保存对方 openDingtalkId，与会话 key 分开；输出改为 5.1 格式；"联系我"相关的 `owner` 逻辑移出（TD-6 再定） | 用录制的 dws 输出做映射单测：本人单聊消息归到原会话、群消息、引用、合并转发、撤回与已读被丢弃 |
| `feishu-user` | 朱雀 `plugins/feishu` 的"本人身份"那半 | 去掉机器人路径（留给原生 channel）；跳过用户与机器人的单聊（那里的话是对话入口）；`+messages-search` 的索引延迟按朱雀做法多拉 5 分钟 | 映射单测；跳过机器人单聊的测试 |
| `gmail` | 朱雀 `plugins/gmail` | `chat.key` = 线程 ID；`is_self` 按发件人是否为本人地址；输出改格式 | 映射单测：线程归并、本人发出的邮件 |
| `jsonl-file` | 朱雀 `plugins/jsonl-file` | 直接按 5.1 格式读文件；支持虚拟时钟回放（TD-1 10.3） | 作为所有运行时测试的夹具 |

插件脚本继续用 Bun（玄武本身就跑在 Bun 上，节点也是同一个程序，不增加依赖）。

## 12. 安全不变量

1. 插件进程拿不到玄武的任何凭据；它的渠道凭据由它自己的 CLI 保管。
2. 插件不能冒充其他来源；`source` 由宿主按插件 id 填。
3. `is_self` 只能被宿主从假改成真，不能从真改成假（宁可多当上下文，也不把本人的话当外部消息分拣）。
4. `send` 只接受带 `action_gate_ref` 的投递；结果未知不重发。
5. 节点只运行官方插件，且必须在 `allowedPlugins` 里。
6. 插件输出全部是不可信数据；`hints` 只供分拣参考，不改变授权。
7. 命令行里不出现用户数据和秘密，全部经 stdin 或环境变量传入。

## 13. 实施步骤

| 步 | 内容 | 验收 | 依赖 |
| --- | --- | --- | --- |
| P1 | manifest v1 解析与校验，v0 兼容 | v0 现有测试不回归；v1 校验各分支有单测 | — |
| P2 | `jsonl-file` 插件 + `LocalPluginHost` + `PluginSupervisor`（poll） + `SourceEventSink` | 回放数据经插件入库，结果与 TD-1 S3 直接入库一致 | P1、TD-1 S3 |
| P3 | stream 模式：长驻、停止序列、重启退避、熔断、限流、健康 | 用假插件测试：崩溃重启、SIGTERM 不退时 SIGKILL、无效行、超限行 | P2 |
| P4 | `send`、`history`、回声标记、outbox 接入 | 假插件测试：退出码 0 / 3 / 1 / 超时四种分支；结果未知不重发 | P3 |
| P5 | `dingtalk` 插件移植与映射测试 | 第 11 节的测试通过 | P1 |
| P7 | 部署到 Mac mini（中心所在机器），本机实测钉钉：收、本人消息归属、history、断线续传能力（send 暂不实测） | 实测记录写入本文第 15 节，状态改为 `tested` | P4、P5 |
| P8 | 断档补拉（7.4） | 停插件 10 分钟期间发的消息被补回并进入分拣 | P4、P7 |
| P9 | `gmail`、`feishu-user` | 映射测试；各自实测 | P4 |
| P6（推后） | `NodePluginHost`：节点协议方法、`allowedPlugins`、事件缓冲补发 | 节点断线重连后事件不丢、不重复；未列入 `allowedPlugins` 的插件被拒绝 | P3；有跨机器渠道需求时再做 |

P1、P5 与 TD-1 的 S1 / S2 互不依赖，可以并行。

## 14. 待决

- [x] **中心部署在哪台机器**（2026-10-31 定）：中心跑在 Mac mini 上，`dws` 也在 Mac mini 上授权。钉钉插件用 `LocalPluginHost`，P6（节点宿主）不是钉钉上线的前置条件，推后到有第二台机器的渠道需求时再做；第 8 节的设计保留。开发在 Linux 机器上进行（这里 `dws` 不可用），钉钉相关的单测用录制样本，实测（P7）在 Mac mini 上进行。
- [ ] `dws event +listen-im` 断线后能否续传（决定钉钉的 `catch_up` 是 `cursor` 还是 `history`），P7 实测。
- [ ] `dws chat +chat-messages` 的时间参数与返回字段（朱雀 DESIGN 里标为待验证），P7 实测。
- [ ] 本地自定义插件是否第一版就开放，还是只允许官方插件。
- [ ] 审计落 `pi_action_events` 还是 settings 审计，实现时按现有代码定。

## 15. 实测记录

（P7 起填写）
