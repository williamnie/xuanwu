# Code Agent Provider 兼容性调研与优先级矩阵

> 调研时间：2026-05-24
> 范围：只判断 Codex / Claude Code / opencode / Kimi Code 作为 `codex-issue-runner` 底层 code agent provider 的接入优先级；不做实现、不设计插件市场。
>
> CLI-only subprocess 细化设计见 `docs/cli-provider-adapter.md`。Provider settings / secrets v1 见 `docs/provider-settings.md`。

## 明确结论

- **不建议今晚/近期立即开大工程做多 provider 抽象。** 现有 Codex baseline 已覆盖 issue 执行、持久 thread、structured event、approval、interrupt、Sessions 页面和显式 `issue update` 回写；多 provider 现在应停留在 PoC 与接口边界验证。
- **最小 MVP 应先做 “issue execution only”。** 不要第一版就接 Sessions 页面；Sessions 需要 list/read/resume/transcript/interrupt/approval/status 全链路一致，跨 provider 会立刻放大 UI 和数据模型差异。
- **CLI-only provider 的第一版应更窄：只支持受控 subprocess 执行 issue。** 若不能稳定恢复 session/transcript，就只出现在 issue execution/run history，不进入 Sessions 页。
- **first provider PoC 推荐：Claude Code。** SDK 是目标集成面；本机当前已先用 CLI stream-json 完成最小 PoC，足以支撑 issue-execution-only 的下一步验证。
- **接入难度排序（从低到高）：Claude Code < opencode < Kimi Code。** opencode 的 HTTP server/SDK 能力强，但运行模型更像“独立 backend”；Kimi Code 的 Wire 能力完整但标注为 experimental，需要先验证真实版本稳定性。

## 当前 Codex baseline

本仓库当前不是简单包 CLI，而是对接 `codex app-server --listen stdio://`：

- `backend/internal/codex.Client` 已暴露 `ThreadStart` / `ThreadList` / `ThreadRead` / `ThreadResume` / `TurnStart` / `InterruptTurn` / `ResolveApproval` / `Events`。
- `docs/codex-integration.md` 记录现有 RPC：`thread/start`、`thread/list`、`thread/resume`、`turn/start`、`turn/interrupt`、`model/list`。
- Issue runner 会为每个 issue 创建独立 thread，保存 `codex_thread_id` / `codex_turn_id`，消费 structured notifications 写入 issue log。
- 完成态不由模型自然语言决定，必须执行：

```bash
codex-issue-runner issue update --id <issue-id> --status done --json
# 或
codex-issue-runner issue update --id <issue-id> --status failed --error "<失败原因>" --json
```

这意味着新的 provider 不应从“统一所有 agent UI”开始，而应先证明能稳定完成：启动、执行、流式日志、失败/中断、显式回写。

## 能力矩阵

| 能力 | Codex baseline | Claude Code | opencode | Kimi Code |
| --- | --- | --- | --- | --- |
| 稳定 SDK/API | 已有 app-server JSON-RPC，由本仓库 adapter 使用 | **强**：官方 Agent SDK（Python/TS）+ CLI `-p`；适合生产自动化 | **强**：`opencode serve` 暴露 HTTP/OpenAPI；JS/TS SDK 由 OpenAPI 生成 | **中**：CLI 为主；`--wire` JSON-RPC 低层协议可嵌入，但文档标注更适合自定义 UI/测试且仍需版本验证 |
| CLI 包装 | 已包 app-server 子进程，不走 PTY | 可用 `claude -p --output-format stream-json`；可 resume/continue/session-id | 可用 `opencode run --format json --dir --model --session` | 可用 `kimi --print --output-format stream-json --work-dir --model --resume` |
| 可恢复 session/thread | **是**：`thread/resume`，Sessions source of truth | **是**：SDK/CLI 支持 resume/continue/fork，session 写本地 JSONL | **是**：CLI `--session/--continue/--fork`，server 有 `/session`、fork、children | **是**：CLI `--continue/--resume`；session 存在 `~/.kimi/sessions/...`，Wire 支持 replay |
| structured event stream | **是**：Codex notifications 归一化为 `codex.Event` | **是**：SDK async messages；CLI `stream-json` 可脚本化 | **是**：CLI raw JSON events；server SSE `/event`、`/global/event` | **是**：print JSONL；Wire `event` notification 明确区分 turn/tool/content 等 |
| tool/command approval | **是**：server request 映射到 `approval/requested`，UI resolve | **强**：permission modes、allow/deny、`canUseTool` callback；CLI 有 `--permission-prompt-tool` | **中强**：`permission` config 支持 allow/ask/deny；server 有 `/session/:id/permissions/:permissionID` | **中强**：Shell UI 有确认；Wire `ApprovalRequest` 可 approve / approve_for_session / reject |
| cwd / model / sandbox / approval policy | **是**：`cwd/model/approvalPolicy/sandbox` 进 `thread/start` | `cwd` 可用进程工作目录控制；model/permission mode/allowed tools 支持；sandbox 不是 Codex 同名抽象 | `--dir`、`--model`、provider/model、permissions 支持；没有 Codex 同名 sandbox，但有工作目录和 external_directory 权限 | `--work-dir`、`--model`、`--config`/`--config-file`、`--yolo`/plan 支持；没有 Codex 同名 sandbox |
| 中断 turn/session | **是**：`turn/interrupt` | **部分是**：SDK/CLI 可由宿主取消当前进程/请求；是否有稳定 turn-level interrupt API 需 PoC 验证 | **是**：server `/session/:id/abort`，SDK options 有 `AbortSignal` | **是**：Wire `cancel`；CLI Ctrl-C/退出后可 resume |
| 读取历史 transcript | **是**：`thread/read/resume` + `~/.codex/sessions` watcher | **部分是**：SDK 可 resume/fork 并通过消息流读取当前响应；历史 transcript 在本地/SessionStore，列表/详情 UI 需另做适配 | **是**：server `/session/:id/message`；CLI `opencode export` | **是**：`context.jsonl`、`wire.jsonl`；Wire `replay`；CLI `/export` |
| 显式回写 issue 状态 | 已实现，默认 prompt 要求执行 CLI | 可通过 prompt + PATH/ENV 注入；建议 SDK Stop hook 或 result 检查兜底 | 可通过 prompt + CLI 环境注入；server/permission 需允许执行 `codex-issue-runner` | 可通过 prompt + Shell 工具执行；需确认 yolo/approval 或 Wire approval 能让 CLI 命令通过 |
| Sessions 页面接入成熟度 | **已接** | 可行，但要重建 session list/read 到现有 UI 的 adapter | 可行性高，server API 覆盖 session/message/status/abort/diff | 可行但风险较高：需要自维护 Wire/session 文件解析或 ACP client |


## Claude Code provider PoC 结果（issue 47）

> 验证时间：2026-05-24  
> 隔离脚本：`scripts/experiments/claude-provider-poc.mjs`  
> 本机版本：`claude 2.1.114 (Claude Code)`；Node SDK package `@anthropic-ai/claude-agent-sdk` 本仓库未安装。

### 最小验证

已在临时目录运行只读任务：脚本创建临时 `README.md`，用 Claude Code 读取 marker，并把 `stream-json` 原始输出转成紧凑事件摘要。最新验证命令：

```bash
node --check scripts/experiments/claude-provider-poc.mjs
node scripts/experiments/claude-provider-poc.mjs --timeout-ms 60000
```

验证输出包含稳定 `session_id`（例如本次为 `f1a43266-d3a9-485a-9f64-8c0d592d4c98`）、`agent.turn.started`、`agent.tool.started`、`agent.tool.output`、`agent.message.delta`、`agent.turn.completed`，且 `result` 命中 `codex-issue-runner-claude-provider-poc`。

### PoC 问题结论

1. **cwd / model / permission**：可以。PoC 用子进程 `cwd` 指定工作目录，`--model sonnet` 映射到实际 `claude-sonnet-4-6`，`--permission-mode dontAsk` 生效；`--tools` / `--allowedTools` 可限制只读工具。SDK 文档和包形态也支持这些 option，但本仓库未安装 SDK，未做 SDK live run。
2. **streaming assistant/tool/command events**：可以。CLI `-p --verbose --output-format stream-json` 输出 JSONL；PoC 已捕获 assistant 文本、Read tool use、tool result 和最终 result。若需要更细粒度 token delta，可加 `--include-partial-messages`，但会显著增加日志量。
3. **中断**：部分可行。PoC 脚本支持 `--interrupt-after-ms` 通过宿主进程 SIGINT/SIGTERM 验证取消路径；尚未证明 Claude Code 有等价 Codex `turn/interrupt` 的稳定 API。生产第一版应按 subprocess kill/cancel 兜底。
4. **恢复/读取历史 session**：部分可行。CLI help 暴露 `--resume` / `--continue` / `--session-id` / `--fork-session`，result 也返回 `session_id`；但本 PoC 没实现 session list/read/transcript adapter，因此不应接入 Sessions 页。
5. **session id / turn id**：能拿到 `session_id` 和 result `uuid`。没有观察到 Codex 式独立 `turn_id`；可把 result `uuid` 作为 run/result event id，而不是假装为 turn id。
6. **注入 issue update**：可通过 prompt + 环境/PATH + allowed Bash pattern 注入。PoC 额外验证过允许 `Bash(codex-issue-runner issue update:*)` 时 Claude 会执行 `codex-issue-runner issue update --id ... --status done --json`；真实 runner 仍需传 `CODEX_RUNNER_ADDR` / token 或 token file，且保持“未显式 terminal => failed”兜底。
7. **错误/退出状态映射**：建议按 CLI 启动失败/认证失败/权限拒绝/中断/超时/模型错误/缺失显式回写分类。Claude CLI exit 0 只能表示 provider run completed，不能表示 issue done；必须复用现有 explicit status gate。

### 是否适合作为 first non-Codex provider

**适合做第一个非 Codex provider PoC，但不适合直接重构生产主链路。** CLI 当前已经足够证明：可指定 cwd/model/permission，可拿结构化 stream-json，可得到 session id，可让 agent 执行回写命令。下一步若要进入生产，应先实现 issue-execution-only subprocess adapter，并把 SDK 作为后续优化；Sessions/list/read/resume、approval UI 和 turn-level interrupt 等能力必须等单独 spike 通过后再接。

## 推荐接入顺序

### P0：保持 Codex 为唯一生产 provider

原因：现有功能面最完整，且 Sessions 页已经直接依赖 Codex threads。近期重点应是稳定 runner、issue、Sessions 当前链路，而不是抽象所有 provider。

### P1：Claude Code PoC（issue execution only）

推荐目标：新增一个实验性 provider PoC，能执行单个 issue 并回写 `issue update`，不进入 Sessions 页面。

推荐原因：

- 官方 Agent SDK 面向生产自动化，支持内置读写/命令工具、sessions、permissions、hooks、streaming；本机未安装 SDK 时，CLI `stream-json` 也可作为先行 adapter 试验面。
- session resume/fork 能力明确；CLI 也支持 `--resume`、`--continue`、`--session-id`、`--output-format stream-json`。
- permission model 足够细：可先用 `dontAsk + allowed_tools` 做保守模式，或隔离环境里用更宽松模式。中断语义先按宿主进程取消兜底，不假设等价于 Codex `turn/interrupt`。

主要风险：

- 认证与商业/订阅限制需要用户侧配置；不应把 Claude login/token 管理塞进 runner 第一版。
- SDK 是 Python/TS；Go 后端若直接集成，可能需要 helper 进程。当前本机 Node SDK package 未安装，所以生产化前仍需单独 SDK live run。
- Claude 的 permission/sandbox 语义不等于 Codex `approvalPolicy/sandbox`，只能做能力映射，不能假装完全等价。

### P2：opencode PoC（先 issue execution，再评估 Sessions）

推荐原因：

- 有 headless server、OpenAPI、JS/TS SDK、SSE events、session/message/status/abort/permission endpoints。
- CLI `opencode run` 已提供 `--dir`、`--model`、`--session`、`--format json`、`--dangerously-skip-permissions` 等自动化入口。
- 如果未来目标是多客户端/移动端/独立 Web 控制 agent，opencode 的 server 形态很值得二期调研。

主要风险：

- 它更像另一个完整 backend，直接并入现有 Go runner 可能引入生命周期、端口、鉴权和状态同步复杂度。
- opencode permission/sandbox 需要从 `permission` config 映射，不要把 Codex approval policy 原样套过去。
- Sessions 接入虽有 API，但 transcript part schema 与现有 Codex renderer 不同。

### P3：Kimi Code PoC（Wire feasibility spike）

推荐原因：

- Kimi Code Wire 是 JSON-RPC over stdin/stdout，形态和当前 Codex app-server 接近。
- Wire 覆盖 `prompt`、`event`、`request`、approval、question、cancel、replay，理论上可以做较干净 adapter。
- CLI 也支持 `--print --output-format stream-json`、`--work-dir`、`--resume`、`--model`、`--yolo`。

主要风险：

- `--wire` 是更底层/实验性集成面；版本稳定性、错误语义、并发 session 行为需要真机验证。
- 认证强依赖 Kimi 登录或配置；`kimi acp` 文档明确未登录会返回 `AUTH_REQUIRED`。
- 第一版不建议为了 Kimi 把 runner 改成通用 ACP/Wire host。

## 第一版 `AgentProvider` interface 建议

### Must-have（第一版只为 issue execution）

1. **能力声明**
   - `ID` / `DisplayName` / `Version` / `Capabilities`
   - 明确标记是否支持 approval、resume、transcript、session list、interrupt、model list。

2. **配置解析与验证**
   - provider command/path、env、auth readiness 检查。
   - `cwd` 必须是显式输入；缺失直接 hard block。
   - `model`、approval/sandbox 只做 provider-specific 映射，不做伪等价。

3. **启动单个 issue run**
   - 输入：`IssueID`、`ProjectID`、`cwd`、`model`、权限策略、渲染后的 prompt、runner CLI env。
   - 输出：provider run id、可选 session id、可选 turn id、raw log path。

4. **normalized event stream**
   - 最少统一：`run.started`、`text.delta`、`tool.started`、`tool.output`、`file.diff`、`approval.requested`、`run.completed`、`run.failed`。
   - 保留 raw payload，避免早期丢失 provider 专有信息。

5. **中断能力**
   - 如果 provider 支持原生 interrupt/abort/cancel，用原生能力。
   - 如果不支持，必须能 kill 当前 provider 子进程，并把 issue 标记为 cancelled/failed。

6. **显式 status 回写门禁**
   - provider turn/run completed 不等于 issue done。
   - runner 继续要求 agent 执行 `codex-issue-runner issue update`；turn 完成但 issue 未 terminal 时仍失败。

7. **失败语义**
   - 区分 provider 启动失败、认证失败、权限被拒、用户中断、模型/网络失败、agent 未显式回写。

### Optional（二期/三期再做）

- `ListModels()`：可先使用静态/用户配置，不阻塞 issue execution。
- `ListSessions()` / `ReadSession()` / `ResumeSession()`：接 Sessions 页面前再要求。
- `ResolveApproval()`：PoC 可先用 deny/auto 模式；需要 UI 审批时再接。
- `ReadTranscript()`：用于 run 结束后的审计与 UI 展示。
- `ForkSession()` / `RenameSession()` / `Diff()` / `Revert()` / cost usage：明显不是第一版必需。
- 多 provider 并发调度、provider marketplace、用户级 token 管理。

## 如何让 agent 显式回写 `issue update`

沿用当前设计，不为每个 provider 发明新完成协议：

1. runner 渲染 prompt 时注入同一段完成规则。
2. 启动 provider 子进程时注入：
   - `CODEX_RUNNER_ADDR`
   - `CODEX_RUNNER_AUTH_TOKEN` 或 token file 读取说明
   - 确保 `codex-issue-runner` 在 `PATH`，必要时使用本仓库 `./dist/codex-issue-runner`
3. provider 权限策略必须允许执行最终 CLI，或在 approval UI 中能批准该命令。
4. runner 端保持现有兜底：agent run completed 但 issue 未 terminal => failed。

## 不建议现在做

- 不做 provider marketplace / 插件市场。
- 不做跨 provider Sessions 页面统一改造。
- 不迁移现有 `codex_thread_id` 语义到泛化 schema；最多后续新增 provider run metadata。
- 不做“完美统一”的 sandbox/approval 抽象；先承认 provider-specific capability。
- 不把第三方账号登录、token 获取、订阅/计费管理纳入 runner。
- 不默认扫描或接管用户机器上所有 code agent CLI。
- 不为了多 provider 改 issue/template/runner 完成门禁。

## 风险与未知项

- **Claude Code**：Go 后端直接用 SDK 需要跨语言 helper；CLI stream-json 足够做日志 PoC，但 approval/user-input、turn-level interrupt 与 transcript 列表是否要走 SDK 仍需小样本验证。认证与 Agent SDK credit/订阅限制需要用户侧准备。
- **opencode**：server 生命周期与本仓库 API server 重叠；如果每次 run 启动 server，成本和端口管理复杂；如果常驻 server，需处理 auth/password、健康检查、状态同步。
- **Kimi Code**：Wire 协议虽完整，但 `--wire` 的实际版本兼容、错误码、并发、多 session 与登录状态需要 live binary 验证。
- **通用风险**：各 provider transcript schema 差异大；如果过早接 Sessions，会把 renderer、filter、origin、approval、interrupt 都拖进重构。

## 参考资料

- 本仓库：`docs/codex-integration.md`、`backend/internal/codex/types.go`、`backend/internal/runner/run_issue.go`、`backend/internal/runner/sessions.go`
- Claude Code：
  - [Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview)
  - [CLI reference](https://code.claude.com/docs/en/cli-reference)
  - [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
  - [Streaming Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
  - [Configure permissions](https://code.claude.com/docs/en/agent-sdk/permissions)
- opencode：
  - [CLI](https://opencode.ai/docs/cli/)
  - [Server](https://opencode.ai/docs/server/)
  - [SDK](https://opencode.ai/docs/sdk/)
  - [Permissions](https://opencode.ai/docs/permissions/)
- Kimi Code：
  - [`kimi` Command](https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html)
  - [Core Operations](https://www.kimi.com/code/docs/en/kimi-code-cli/core-operations.html)
  - [Wire Protocol](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/wire-protocol.html)
  - [Config Files](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/configuration-files.html)
  - [Data Locations](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/data-locations.html)
