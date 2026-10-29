# Claude herdr 原生终端模式（preview）

此模式在项目目录启动真实交互式 `claude`，由 herdr 托管终端。玄武通过本地 socket
输入提示词，通过临时 hooks 接收事件和处理执行策略。不调用 SDK `query()`、不使用
`claude -p`；仅复用 SDK 的原生历史读取功能。默认 SDK 模式不变。

## 用户自行安装

**玄武不会自动安装 herdr，也不会安装全局 Claude hooks。** 请在实际执行节点
（远程项目为远程节点）、与玄武服务相同的系统用户下完成：

1. 按 [herdr 安装说明](https://herdr.dev/docs/install/) 安装 **0.9.5 或更新版本**。
2. 安装 Claude Code，运行 `claude auth login`；在项目目录手动运行一次 `claude`，完成
   登录、目录信任等确认。
3. 确认 `herdr`、`claude`、`curl` 在玄武服务的 PATH 中。交互 shell 可找到命令，
   不代表 launchd/systemd 服务也能找到。
4. 运行 `herdr` 并保持服务运行，确认 `herdr api snapshot` 成功。
5. 配置以下环境变量，重启使用这些配置的玄武服务；安装或启动依赖后可重新探测 Code Agent。

```sh
export XUANWU_CLAUDE_MODE=herdr
export XUANWU_CLAUDE_AUTH_MODE=local-cli
export XUANWU_CLAUDE_CMD=/absolute/path/to/claude
```

不需要 Ikaga。首版仅支持 macOS/Linux，不支持 Windows。
可用服务环境变量 `HERDR_SOCKET_PATH` 指定 socket，或 `HERDR_SESSION` 选择具名服务。
默认路径为 `$XDG_CONFIG_HOME/herdr/herdr.sock`，未设置 XDG 时为 `~/.config/herdr/herdr.sock`。
其他目录请显式配置 `HERDR_SOCKET_PATH`。

本模式仅复用本地 CLI 登录，不支持 API key / platform-profile 认证切换。
HOME、CLAUDE_CONFIG_DIR 必须与玄武服务一致，避免执行和历史查询使用不同目录。

## 检测与使用

Code Agent 状态会检查可执行文件、herdr 版本、socket、API 响应和 Claude 登录。
缺失、未启动、版本过旧或未登录会显示不可用及安装/启动指引，不静默回退到 SDK。
模式选项也注明“需自行安装并启动 herdr”。

每个会话创建一个“玄武 Claude” workspace，在指定项目目录启动 Claude。
用户可以打开对应 pane 操作同一个终端，原生问题、登录、信任和特殊菜单仍在那里处理。
会话详情包含 `native_terminal.pane_id`。玄武输入 API 接收普通文本，斜杠命令在原生终端输入。

后续轮次复用进程，回复结束不关闭 pane。中断会先发送 Esc，再关闭属于该会话的 pane；
下次通过 `--resume <id>` 恢复。停止 provider 同样只清理自己拥有的 pane。
无法核实归属或关闭失败时留下 pane 并提示人工检查，不关闭用户后来替换进去的进程。
**不要在会话仍运行时另起进程 resume 同一个 ID。** 已在 herdr 中运行的会话会拒绝重复恢复；
其他终端中的外部进程不属于本 adapter 的控制范围。

## hooks 与边界

- hooks 写入独立临时私有文件，通过 `--settings` 注入，不修改用户/项目 settings.json。
  回调只监听 localhost，使用随机凭据并校验 session ID；正常关闭后清理文件。
- `PreToolUse` 复用玄武执行策略和审批 broker。回调不可用时命令 hook 返回退出码 2，拒绝工具执行。
  `AskUserQuestion` 保留终端交互，不伪装为已回答。
- 收到 `SessionStart` 且终端可交互后才发送任务；启动确认需用户在 herdr 处理。
- 本轮 `Stop` 与 herdr idle/done 同时成立才发出轮次完成。子代理停止、仅空闲、输入入队或进程退出
  都不算成功。轮次完成不等于 Issue 完成，Runner 原有终态门禁保持不变。
- 回复通过完成文本及原生历史展示，不宣称逐 token 输出。工具输出有大小上限。
- 当前不声明 API live steer，忙碌时拒绝额外消息，不把排队输入冒充即时转向。
  用户仍可在真实终端按原生方式操作。API 图片输入暂不支持。
- 结果未知的终端写入不会自动重试，避免重复执行。
- 模式继承原生设置和扩展，属于本机用户权限内的工具策略，不是 OS 沙箱。
  不要在受管任务中手动禁用 hooks 或切换会话。服务异常退出后，残留终端可能因回调不可达而拒绝工具；
  应先检查并退出原 pane，再恢复历史，避免双写。

## 验证状态

自动化覆盖模拟 herdr 的原生启动、多轮复用、并发拒绝、审批、超时、中断和归属校验，
以及实际 Unix socket 分帧、curl hook 失败拒绝。**尚未完成真实 herdr + Claude 账号验收**，
仍需验证 hook 版本兼容、目录信任、原生提问、回复展示及人工接手。

参考：[herdr API](https://herdr.dev/docs/socket-api/)、[Claude hooks](https://code.claude.com/docs/en/hooks)。
