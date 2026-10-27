# 远程 Agent 端（节点）设计方案 v1（测试版）

> 状态：v2 已实现（中心统一验收、无人值守） · 分支：`feat/remote-agent` · 2026-10-26 起草，2026-10-27 v1，v2 同日完成

## 1. 目标

当前玄武只能调度部署机本地的项目与 code agent。本方案增加 **Agent 端（下称"节点"）**：装在其他机器上，主动连回中心玄武，中心即可对节点上的项目派任务、看日志与结果。

已确认的产品决定：

| # | 决定 |
|---|------|
| 1 | 节点**主动连接**中心；节点只需配置「中心地址 + 密钥」即可接入任意中心 |
| 2 | 面向内网 / Tailscale；**不做公网加固**。检测到非内网连接时页面给出提醒 |
| 3 | 任务、运行、日志、状态全部存**中心数据库**；节点只负责执行，不持久化业务数据 |
| 4 | v1 只打通主链路：远程项目可派任务执行、可看日志和结果 |

## 2. 总体结构

```
┌──────────── 中心（现有玄武） ────────────┐          ┌──────── 节点（新） ────────┐
│ projectLoop ──► selectedProvider         │          │                            │
│                   ├─ 本地 ExecutorProvider│          │  NodeAgent                 │
│                   └─ RemoteExecutorProvider ◄─ WS ──┤   ├─ 本地 providers 注册表 │
│ nodes 表 / NodeHub（连接、心跳、RPC）     │  (节点主动) │   │  codex/claude/qoder/pi │
│ DB：issues / runs / events（不变）        │          │   └─ allowedRoots 白名单   │
└──────────────────────────────────────────┘          └────────────────────────────┘
```

核心思路：**复用 `ExecutorProvider` 接口作为切缝**（`backend-ts/src/providers/types.ts`）。
中心侧新增 `RemoteExecutorProvider`，实现 `run / interrupt / resolveApproval / runtimeStatus`，内部把调用转成 WS 请求发给节点；节点侧用现有的真实 provider 执行，并把 `ProviderEvent` 原样流回。这样 `runIssueWithProvider` 之后的事件持久化、日志、审批、结果判定逻辑**全部不用改**。

## 3. 节点端

- **形态**：同一个 `xuanwu` 二进制新增子命令，复用现有 providers 代码，不另起项目：
  ```
  xuanwu node --hub http://100.x.y.z:8787 --token xwn_xxx [--name my-laptop] [--root ~/code]
  ```
  配置也可写入 `~/.xuanwu/node.json`，命令行参数覆盖配置。
- **无数据库**：只保留一个本地小状态文件（节点 ID、未确认事件缓冲）。
- **上报能力**：连接成功后上报 `hello`：节点版本、OS、可用 provider 及其 `runtimeStatus()`、`allowedRoots`。
- **安全边界**：节点只接受"在 `allowedRoots` 内的 cwd 上运行 provider"这一类指令，**不提供任意命令执行通道**。默认 `allowedRoots` 为空 = 拒绝所有项目，必须显式配置。

## 4. 连接协议

- **传输**：正式部署是 web 网关（对外）+ core（仅内网监听）双进程，网关只做 HTTP/SSE 流式反代。为不改网关，传输采用 **SSE 下行 + HTTP POST 上行**，全部由节点主动发起，`Authorization: Bearer <节点密钥>`：
  - `POST /api/nodes/agent/hello`：上报版本、OS、provider、allowedRoots
  - `GET /api/nodes/agent/stream`：SSE 长连接，中心经此下发指令；连接存在即视为在线
  - `POST /api/nodes/agent/messages`：节点批量上报指令响应与运行事件
- **消息**：JSON，三类：
  - `req` / `res`：带 `id` 的请求-响应（如 `run.start`、`run.interrupt`、`approval.resolve`、`path.check`、`status.get`）
  - `event`：运行事件流，带 `runRef` 与单调递增 `seq`
  - 心跳：中心每 15s 在 SSE 上写注释帧；节点 45s 未收到任何数据即判断断线并重连
- **断线重连**：节点指数退避重连（1s → 30s）。节点上运行中的任务**不因断线中止**；事件写入本地缓冲，重连后中心回报 `ackSeq`，节点补发其后的事件。缓冲上限（如 8MB / 运行），超限丢弃旧的 progress 类事件并标记缺口。
- **中心重启**：中心启动后已有的 stale-session 对账逻辑（`staleSessionReconciler`）需扩展：远程运行在节点重连并报告"仍在运行"前不判失败，超时（如 10 分钟）未重连再按现有规则处理。

## 5. 中心端改造

### 5.1 数据（迁移 `092_remote_nodes`）

- 新表 `nodes`：`id, name, token_hash, status(online/offline), last_seen_at, last_remote_addr, info_json(版本/OS/providers/allowedRoots), created_at, updated_at, revoked_at`
- **不改 `projects` 表**：它被十余张表以 `on delete cascade` 外键引用，且迁移在事务内执行、无法临时关闭外键，重建表有级联删除风险。远程项目的 `cwd` 改存为 `node://<节点ID>:<节点上的绝对路径>`（`nodes/projectLocation.ts`）：
  - 沿用 `cwd` 的唯一约束，天然按「节点 + 路径」唯一；
  - 中心上直接读写目录的代码遇到该前缀只会找不到目录，不会误操作中心本机的同名目录；git 适配器与工作区观察处另有显式拦截；
  - 项目 API 对远程项目额外返回 `node_id` 与 `node_path`；创建/更新时传 `node_id` + 节点上的 `cwd`，由节点 `path.check` 校验后再转换。

### 5.2 密钥与配对

- 页面「添加节点」→ 中心生成 `xwn_` 前缀随机密钥，**只显示一次**，数据库只存哈希；同时给出可直接复制的启动命令。
- 支持吊销（`revoked_at`），吊销后立即断开该连接。

### 5.3 执行路径

- `projectLoop.selectedProvider`：若 `project.node_id` 非空，返回该节点对应的 `RemoteExecutorProvider`；节点离线时该项目的任务按现有 `provider_runtime` 原因排队等待，而不是失败。
- 每个节点每个 provider 一个 `RemoteExecutorProvider` 实例，由 `NodeHub` 在节点上线/下线时维护。
- 能力：v1 暴露 `issue_execution`、`interrupt`、`approvals`；`sessions / resume_session / model_list` 留到后续。

### 5.4 中心直接访问项目目录的地方（关键风险）

中心有不少逻辑直接在 `project.cwd` 上跑 git / 读文件，远程项目在中心机器上**不存在这个目录**。已初步定位：

- 运行前 git 基线：`domain/run/runPreparation.ts` → `gitWorkspaceObservation.ts`
- 验收/证据：`domain/acceptance/*`、`domain/evidence/*`
- 交付/评审：`domain/handoff/*`、`domain/review/humanReview.ts`、`workspaceWait.ts`
- 路径检查与同步：`http/projects/projectPathCheck.ts`、`projectSync.ts`
- Prompt 图片 / 托管 Skill / MCP 路径：`issuePromptImages`、`skills/managedStore.revisionPath`（都是中心本地路径）

**v1 策略**：对 `node_id` 非空的项目，这些功能**降级跳过**并在界面标注"远程项目暂不支持"，不尝试远程执行 git：
- 基线观察传空（现有代码已支持 `project_cwd` 为空的分支）
- Prompt 图片 v1 不发送；托管 Skill / MCP 注入 v1 跳过
- 路径检查改为向节点发 `path.check` RPC（这一项 v1 就做，否则无法创建远程项目）

后续版本再引入受限的 `workspace.*` RPC（只读 git 状态、diff）来恢复验收与交付能力。

### 5.5 里程碑 2 实现要点

- 节点握手上报每个 provider 的 `capabilities`（仅 `issue_execution / interrupt / approvals`）、`interrupt_scope`、就绪状态与版本。
- 中心的 `RemoteExecutorProvider` 使用内置 provider 的**静态** manifest 与策略适配器（`nodes/remoteProvider.ts`），所以执行策略照常在中心解析并记录元数据，即使中心本机没启用该 provider。
- 节点在执行前再次用 `allowedRoots` 校验 cwd（解析符号链接后判断）。
- `images` 不发往节点（是中心本地路径），v1 远程运行不带图片。
- 已知限制：中心进程重启会丢失在途远程运行的 Promise，节点上的运行继续但结果无人接收，由现有 stale 对账判失败；后续版本处理。

## 6. 内网提醒

中心在节点握手时检查对端地址：

- 属于 loopback、RFC1918（10/8、172.16/12、192.168/16）、Tailscale CGNAT（100.64/10）、IPv6 ULA（fc00::/7）→ 视为内网
- 否则在节点列表与节点详情显示提醒：「该节点通过非内网地址连接，当前版本未针对公网加固，建议使用 Tailscale 等内网组网」
- 中心监听在 `0.0.0.0` 且中心地址为公网 IP 时，在「添加节点」对话框同样提示

仅提醒，不阻断（测试版）。

## 7. 前端

遵循 `docs/design-system/`，复用既有组件：

- **设置 → 节点**：节点列表（名称、在线状态、最后在线、可用 provider、内网/提醒徽标）、添加节点（生成密钥 + 复制命令）、吊销
- **创建/编辑项目**：新增「所在节点」选择（默认本机）；选远程节点时路径输入走节点的 `path.check`
- **项目/任务**：显示所在节点；节点离线时任务显示"等待节点上线"

## 8. 不在 v1 范围

交互式会话（sessions）、会话恢复、模型列表、远程 git 验收与交付、Prompt 图片、托管 Skill/MCP 下发、节点自动升级、公网 TLS/mTLS 加固、多中心同时接入。

## 9. 里程碑

1. **协议与节点骨架**：`xuanwu node` 子命令、WS 握手认证、心跳、hello 上报；中心 `nodes` 表 + 迁移 + `NodeHub`
2. **远程执行主链路**：`RemoteExecutorProvider`、`run.start` / 事件流 / `interrupt` / `approval.resolve`、断线缓冲补发、`path.check`
3. **项目接入与降级**：`projects.node_id`、选择逻辑、5.4 中各处降级
4. **前端**：节点设置页、项目节点选择、状态与内网提醒
5. **联调**：本机起一个中心 + 一个节点（不同端口/目录）跑通端到端；再用 Tailscale 两台机器实测

## 9.1 实现与验证记录

| 里程碑 | 提交 | 验证 |
|---|---|---|
| 1 协议与节点骨架 | `0fcad241` | NodeHub 单测；真实 HTTP + NodeAgent 端到端；真实进程冒烟 |
| 2 远程执行主链路 | `98314444` | 远程 provider 端到端（事件、失败、越界、中断、审批、断线宽限）；节点识别本机 codex / claude / pi |
| 3 项目接入与降级 | `ad8f0ea0` | 经 API 建远程项目、项目循环在节点执行、取消即中断、节点离线任务等待 |
| 4 前端 | `65d1d6c6` | 前端测试、lint、build；浅/深色 × 980/760 截图检查，单主色强调 |
| 5 联调 | 见下 | 修复 run() 提前返回后事件被丢弃（Codex 模式，`53daed04`）；web 网关 + core + agentic 三进程形态下节点经网关连接、20s 后仍可往返、伪造对端地址头被网关覆盖 |

联调中发现并修复：Codex 的 `run()` 在一轮开始时即返回，后续消息与 `turn/completed` 经 `onEvent` 推送。远程链路最初在收到 `result` 时就退订，真实 Codex 任务会一直停在执行中；现两端都转发到终止事件为止，并有回归测试。

尚未做的验收：用真实编程工具在远程节点上完整跑一次任务（会消耗模型额度，留给使用者验收）；跨机器 Tailscale 实测。v2 的真实进程冒烟（不发模型请求）已验证：节点上报名额与能力、经节点读取真实 Codex 模型列表、远程项目创建、节点重启后重新上线。

## 9.2 v2：中心统一验收、无人值守

目标：一个中心控制 N 个节点，节点与中心运行同一个 `xuanwu`，所有远程工作由中心验收，全程无人值守。

| 能力 | 提交 | 做法 |
|---|---|---|
| 远程 Git 证据 | `27cacbc0` | 中心的 `runGit` / `withGitWorkspaceObservation` / 证据 git 适配器对 `node://` 项目改走节点 `git.run`；节点只执行只读子命令白名单，带与中心相同的安全参数并限定在 allowedRoots 内。基线、证据、验收卡、交付检查逻辑不变 |
| 会话与模型只读 | `f40e1d32` | 节点 `provider.read`（readSession / listSessions / listSessionTurns / listModels）；验收协调器经节点读会话摘要；`/api/providers/:id/models?node_id=` |
| 附件与托管 Skill | `03ac43c1` | 远程项目提示以占位符引用 Skill 版本；`run.start` 携带图片与 Skill 版本内容（上限 32 MiB）；节点按版本缓存 Skill、按运行存放附件 |
| 重启恢复 | `f14b401a` | `remote_runs` 台账（迁移 093）；节点握手上报在途运行；中心重启后经同一落库链路接回；节点丢失的运行立即失败；节点迟迟不回来时宽限期后收口 |
| 常驻服务与版本 | `8d999def` | `xuanwu node install/uninstall`（systemd 用户服务 / launchd，`systemd-analyze verify` 通过）；版本不一致提醒 |
| 验收后续动作 | `932e5f25` | 节点支持原会话续跑（`run.start` 的 recover 模式）；PI 重试、续跑、supervisor 恢复、自动化分派等全部按项目路由到节点 |
| 并发 | `c9260535` | 中心本机沿用 `maxParallelProjects`，每个节点用自己的 `--max-parallel`，互不占用 |
| 监督与会话视图 | `5ec1eb8d` | supervisor 经节点读回合状态；会话详情经节点读取 |

关键端到端测试（`backend-ts/src/nodes/`）：`remoteAcceptance`（节点执行 → 中心经节点取证据与会话 → 自动验收为完成；重试与续跑都回到原节点）、`remoteRecovery`（中心重启接回、节点重启立即失败、节点不归宽限期收口）、`multiNode`（中心 + 两个节点同时执行，各守名额）、`remoteGit`（验收卡看到节点上的改动）。

仍不支持：向进行中的会话追加消息（`sendSessionMessage`，用于人工审核后在原会话调整与 PI steer）——一轮结束后 Codex 的新事件不经原运行的转发链路，需要独立的会话事件通道；对话页在节点上新建会话同理。二者都不在无人值守主流程上。

## 10. 已确认的决定

1. 节点端复用同一个 `xuanwu` 二进制（`xuanwu node` 子命令）。
2. 节点 `allowedRoots` 默认拒绝、必须显式配置。
3. 远程项目 v1 不做 git 基线 / 验收 / 交付。

## 10.1 原待确认项（已确认）

1. 节点端复用同一个 `xuanwu` 二进制（`xuanwu node` 子命令）——推荐，安装和升级最简单
2. 节点 `allowedRoots` 默认拒绝、必须显式配置——推荐，避免中心能在节点任意目录上跑 agent
3. 5.4 的降级策略（远程项目 v1 不做 git 基线/验收/交付）是否可以接受
