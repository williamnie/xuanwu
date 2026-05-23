# CLI-only Provider Adapter v1 调研

> 调研时间：2026-05-24  
> 范围：只设计 `codex-issue-runner` 如何以受控 subprocess 接入 CLI-only agent provider；不实现生产 adapter，不安装新依赖，不读取无关用户凭据或配置。

## 结论

- **CLI-only provider v1 只应作为 issue execution provider**：能启动一次 issue run、收集 stdout/stderr、把日志归一化写入 issue log，并继续要求 agent 显式执行 `codex-issue-runner issue update` 回写最终状态。
- **不能恢复 session 的 CLI-only provider 不应出现在全局 Sessions 页**：没有稳定 `provider_session_id`、`list/read/resume transcript`、`interrupt` 的 provider，只能在 issue 详情和 run history 中展示本次 raw log / normalized events。
- **opencode 适合作近期 issue-execution PoC，但本机未安装，不能直接判定当前机器可接入**：官方文档显示有 `opencode run` 的非交互、`--dir`、`--format json`、session/continue/fork，以及 server/session API；本机 `opencode --help` 无法验证。
- **Kimi Code / kimicode 不建议作为近期 production adapter 起点**：官方文档显示 `kimi --print` / `--prompt` / `--work-dir` / JSONL 与 experimental Wire，但本机未安装；`--print` 隐式 yolo、Wire experimental、错误/权限语义需要真机 spike 后再定。
- **v1 不支持 PTY-only / TUI scraping provider**：只有可通过 argv/stdin 传 prompt、可设置 cwd、可通过 pipe 读取 stdout/stderr 或 JSONL 的 CLI，才进入 v1。必须开交互 TUI、只能靠 ANSI 终端内容判断状态的 provider，暂不接入。

## 当前实现事实

当前 runner 的 decisive path 仍是 Codex 专用：

- `backend/internal/runner/run_issue.go` 的 `startCodexTurn` 每个 issue 都调用 `codex.ThreadStart` / `codex.TurnStart`，再消费 Codex structured events。
- `backend/internal/codex/types.go` 的 `Client` interface 暴露 `ThreadList` / `ThreadResume` / `InterruptTurn` / `ResolveApproval` 等 Codex app-server RPC 能力。
- `backend/internal/runner/sessions.go` 的 Sessions list/read/create/message/interrupt 全部先 `prepareCodex()`，再走 Codex thread。
- SQLite schema 仍是 `codex_thread_id` / `codex_turn_id`，没有 provider-neutral run/session identity。
- 完成态门禁已经是 provider-neutral：agent run completed 不等于 issue done，必须显式执行 `issue update`；否则 runner 会失败该 issue。

这意味着 CLI-only adapter 的第一版不应改 Sessions、schema 或公共 API；只需要定义 future adapter 的最小 contract。

## 本机命令探测

执行命令：

```bash
for cmd in opencode kimi kimicode; do
  command -v "$cmd" && "$cmd" --help
done
```

结果：

| 命令 | 本机 PATH 状态 | 本机 `--help` 结论 |
| --- | --- | --- |
| `opencode` | 未找到 | 未知；不能验证本机命令能力 |
| `kimi` | 未找到 | 未知；不能验证本机命令能力 |
| `kimicode` | 未找到 | 未知；不能验证是否存在该命令名 |

官方文档可作为设计参考，但不能替代本机 binary 验证：

- opencode：CLI 文档显示 `opencode run [message..]`、`--format json`、`--dir`、`--session`、`--continue`；server 文档显示 session/message/status/abort/permission API。
- Kimi Code：CLI 文档显示 `--prompt`、`--print`、`--work-dir`、`--session/--resume`、`--output-format stream-json`；Wire 文档显示 `cancel`、`event`、`ApprovalRequest`，但 `--wire` 标注 experimental。

## CLIProvider v1 最小 interface

建议先定义 issue-execution-only interface，不把 Sessions 能力放进必选项：

```go
type CLIProvider interface {
	ID() string
	DisplayName() string
	Probe(ctx context.Context, cfg CLIProviderConfig) (CLIProbeResult, error)
	StartIssueRun(ctx context.Context, input CLIIssueRunInput) (CLIRunHandle, error)
	Interrupt(ctx context.Context, runID string) error
}
```

### 输入协议

`CLIIssueRunInput` 至少包含：

- `IssueID` / `ProjectID`
- `CWD`：必须显式传入；为空直接 hard block。
- `Prompt`：runner 渲染后的完整 issue prompt，包含显式 `issue update` 契约。
- `Model` / `PermissionMode`：只做 provider-specific 映射；不宣称等价于 Codex `approvalPolicy` / `sandbox`。
- `Command` / `Args`：固定 argv 模板，不用 shell 拼接不可信输入。
- `PromptMode`：`argv`、`stdin` 或 `file`；优先 argv/stdin，不默认落盘。
- `EnvAllowlist`：最小环境变量白名单。
- `RunnerCallbackEnv`：`CODEX_RUNNER_ADDR`、`CODEX_RUNNER_AUTH_TOKEN` 或 `CODEX_RUNNER_AUTH_TOKEN_FILE`、可执行文件 PATH。
- `Timeout` / `MaxLogBytes` / `RawLogDir`。

### 输出协议

`CLIRunHandle` / run result 至少包含：

- `ProviderRunID`：runner 生成的稳定 ID，例如 `cli:<provider>:<issue_id>:<attempt>`。
- `ProviderSessionID`：可选；只有 provider 明确输出稳定 session id 时才填。
- `PID` / `StartedAt` / `EndedAt`
- `RawStdoutPath` / `RawStderrPath`
- `Events <-chan events.AgentEventPayload`：最小归一化事件。
- `ExitCode` / `Signal` / `ExitReason`
- `FailureClass`：见下方失败分类。
- `IssueTerminalObserved`：run 结束时 issue 是否已被显式回写成 `done` / `failed` / `cancelled`。

## 事件归一化

v1 只归一化能稳定从 pipe 获得的信息：

| normalized event | 来源 |
| --- | --- |
| `agent.turn.started` | 子进程成功 start 后生成 |
| `agent.message.delta` | stdout 文本行或 JSONL content |
| `agent.command.started` / `agent.command.output_delta` / `agent.command.completed` | 仅当 provider JSONL 明确表达 tool/command lifecycle 时生成；纯文本不猜 |
| `agent.file.patch` | 仅当 provider 输出结构化 diff/file patch 时生成 |
| `agent.approval.requested` | v1 默认不接 UI approval；只有 provider 有稳定 request protocol 才透传 |
| `agent.turn.completed` | 子进程退出且未被取消 |
| `agent.error` | 启动失败、非 0 退出、超时、取消、日志超限或分类后的 provider error |

保留 raw payload/path；不要为了 UI 好看而丢掉 provider 原始日志。

## 失败分类

CLI-only v1 只能做“可解释但保守”的分类：

| 分类 | 判定来源 | 降级策略 |
| --- | --- | --- |
| `startup_failed` | executable 不存在、启动失败、cwd 不存在 | issue failed；提示安装/配置 provider |
| `auth_failed` | provider 明确输出 auth/login/API key 错误 | issue hold 或 failed；不读取用户凭据 |
| `network_failed` | 明确 timeout / DNS / 连接失败 / provider 429/5xx | 可沿用 runner transient retry 策略 |
| `permission_denied` | provider 明确拒绝 tool/shell/file 权限 | issue failed；提示调整 provider permission |
| `user_cancelled` | runner cancel/interrupt 触发或进程被 SIGINT/SIGTERM | issue cancelled 或 failed，按现有 runner 语义决定 |
| `model_failed` | provider 明确返回 model/provider error | issue failed 或 transient retry |
| `test_failed` | agent 显式 `issue update --status failed --error ...`，或日志中有明确测试失败但未回写 | 优先相信显式 failed；未回写则按 missing explicit status failed |
| `missing_explicit_status` | 子进程 0 退出，但 issue 仍非 terminal | issue failed；沿用当前完成门禁 |
| `unknown_failed` | 非 0 退出但无可分类错误 | issue failed；保留 stdout/stderr 路径 |

不要仅凭自然语言“完成了”或 exit code 0 标记 `done`。

## PTY 策略

- v1 默认使用 `exec.CommandContext` + pipe，不启动 PTY。
- 如果 CLI 只有交互 Shell/TUI，没有 non-interactive prompt 或 JSON/text pipe 输出，判定为 **不支持 v1**。
- 若 provider 文档要求 PTY 但同时提供机器可读 JSONL，需单独 spike；adapter 只能解析结构化 JSONL，不解析 ANSI 光标控制、屏幕区域或终端颜色。
- kill/interrupt 必须由 runner 控制进程组；不能依赖发送模拟按键后 scraping UI 状态。

## 权限与环境限制

第一版 subprocess 必须采用 allowlist：

- `Cmd.Dir = CWD`；`CWD` 必须来自已注册 project，不允许 provider 自行选择工作区。
- 不通过 shell 拼接命令；所有动态值作为 argv 或 stdin。
- 环境变量只传：
  - 基础运行所需：`PATH`、`HOME`、`TMPDIR`、`LANG`、`LC_ALL`
  - runner 回写所需：`CODEX_RUNNER_ADDR`、`CODEX_RUNNER_AUTH_TOKEN` 或 `CODEX_RUNNER_AUTH_TOKEN_FILE`
  - provider 明确要求且用户配置的变量
- 不枚举、不打印、不复制用户 credential store；auth readiness 只检查 provider 命令是否可运行或 provider 自身给出的状态。
- raw log 需要限制大小并避免记录 token；若 provider 输出疑似 token，只做本地 redaction 后进 issue event。
- 默认不传 `--dangerously-skip-permissions` / `--yolo`；只有 sandbox/比赛隔离环境和用户显式配置时允许。

## Sessions 页策略

CLI-only provider 是否进入 Sessions 页，按能力分级：

1. **Issue execution only**：没有稳定 session id 或不能 list/read/resume transcript。只显示在 issue detail / issue runs，不进入 Sessions。
2. **Session-aware but not resumable**：能输出 session id 或 raw transcript，但不能稳定 resume/interrupt。可在 issue detail 链接 raw transcript，不进入全局 Sessions。
3. **Sessions-ready**：同时支持 provider-qualified `session_key`、list/read/resume transcript、message/continue、interrupt、状态与事件刷新。只有这一档才接入 Sessions 页。

opencode / Kimi Code 即使官方文档显示有 session 能力，也必须等本机 binary + adapter spike 验证后才能从 1 升到 3。

## opencode / Kimi Code 近期接入判断

### opencode

- **近期建议**：可作为 CLI-only issue execution PoC 候选，但不是 production provider。
- **优先路径**：`opencode run --format json --dir <cwd> --model <provider/model> <prompt>`，由 adapter 读 JSON events；不要先接 `opencode serve` 常驻生命周期。
- **必须验证**：本机 binary 版本、`run` 是否稳定输出 JSONL/JSON、exit code 语义、session id 输出位置、认证失败文本、cancel 后进程/会话状态、是否需要权限 auto-approve。
- **Sessions**：v1 不进 Sessions；后续若改用 server API 并完成 transcript normalization，再评估。

### Kimi Code / kimicode

- **近期建议**：不作为首个生产 adapter；可做独立 Wire feasibility spike。
- **优先路径**：先验证 `kimi --print --output-format stream-json --work-dir <cwd> --prompt <prompt>` 的真实 stdout/stderr 与 exit code；再评估 `--wire`。
- **主要阻塞**：本机无 binary；`--print` 文档显示隐式 yolo，不适合默认安全策略；`--wire` experimental，需要验证版本兼容、approval、cancel、auth error、并发 session。
- **Sessions**：v1 不进 Sessions；只有 Wire/replay/session file 能稳定 list/read/resume 后再进入 Sessions-ready 档。

## 降级策略

| 缺失能力 | v1 行为 |
| --- | --- |
| 不能非交互传 prompt | 不支持该 provider |
| 不能指定 cwd | 使用 `Cmd.Dir` 兜底；若 CLI 无视 cwd，判定不支持 |
| 不能流式输出 | 允许 run 结束后一次性收集 stdout/stderr，但 UI 只显示 buffered log |
| 没有 session id | 使用 `ProviderRunID`；不进 Sessions |
| 不支持 interrupt | runner cancel 时 kill 进程组；标记 cancelled/failed |
| 错误不可分类 | `unknown_failed` + raw log path |
| 需要 approval UI | v1 关闭或固定 deny/allow 策略；不接交互 approval |
| 需要 PTY/TUI scraping | 不支持 v1 |

## 参考资料

- 本仓库：`backend/internal/runner/run_issue.go`、`backend/internal/runner/sessions.go`、`backend/internal/codex/types.go`、`backend/internal/store/schema.go`、`docs/agent-execution-contract.md`、`docs/provider-sessions.md`
- opencode CLI: <https://opencode.ai/docs/cli/>
- opencode Server: <https://opencode.ai/docs/server/>
- Kimi Code `kimi` command: <https://www.kimi.com/code/docs/en/kimi-code-cli/reference/kimi-command.html>
- Kimi Code Wire Protocol: <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/wire-protocol.html>
