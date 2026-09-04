<div align="center">
  <img src="frontend/public/brand-turtles/turtle-guarding.png" width="128" alt="玄武守护龟" />

# 玄武 Xuanwu

**让 Coding Agent 24 小时持续工作。**

玄武是一个面向 Coding Agent 的常驻 AI 工程控制面，负责跨项目、跨 Provider、
跨 Session 调度和管理工程工作。

你只需要给出工程目标和权限边界。玄武会把目标变成可追踪的工作，在无人值守时持续推进，
恢复中断的执行，检查真实结果，并形成可审查的交付；只有确实需要人类判断时才把你叫回来。

[English](README.md) · [路线图](#路线图) · [首次交付](docs/first-delivery.md) · [架构文档](docs/architecture/README.md) · [最新版本](https://github.com/williamnie/xuanwu/releases/latest)

[![Release](https://img.shields.io/github/v/release/williamnie/xuanwu?display_name=tag)](https://github.com/williamnie/xuanwu/releases/latest)
[![Release workflow](https://github.com/williamnie/xuanwu/actions/workflows/release.yml/badge.svg)](https://github.com/williamnie/xuanwu/actions/workflows/release.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)
[![Platforms](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-0b7285)](#安装-release)
</div>

> [!IMPORTANT]
> 玄武是采用 Apache License 2.0 的开源软件。遵守许可证条款即可进行商业使用、修改和分发，
> 详见[许可证](#许可证)。

## 当你离开电脑以后

Coding Agent 会写代码，玄武负责在人离开终端以后继续推进工程工作：

- **持续推进工作**：跨多个仓库运行队列和依赖感知的工程任务。
- **监督长时间运行的 Agent**：跟踪每个 Run 与 Attempt，不依赖某个终端窗口一直打开。
- **恢复中断**：在有界恢复预算内 resume 或 retry 失败的 Session。
- **知道什么时候该问人**：安全范围内自主继续；缺少需求、凭据、审批或业务判断时进入 Attention。
- **交回可审查结果**：保留 changed files、revision、检查、Evidence 与 Handoff，不接受 Agent
  一句“完成”作为结果。

整个控制循环保持明确：

<p align="center">
  <img src="docs/assets/xuanwu-control-plane.png" alt="玄武控制面线路图：Web UI、CLI 和 IM Channel 经 Runner Core 与 Xuanwu Supervisor 调度 Codex、Claude、Pi、Qoder，并回到权威状态。" />
</p>

## 不用盯着，也能信任结果

Agent 说“完成”不等于完成。Supervisor 会检查真实 Session 与 workspace 事实，让可恢复的工作
继续推进，并记录 Work 是已经完成、执行失败还是确实需要人。Evidence 与 Handoff 让结果可审查，
而不要求你盯着每一个 Turn。

## 核心能力

- **Work 与 Run 控制**：把目标变成绑定项目的 Work，跟踪每个 Run/Attempt，明确项目、
  工作目录、Provider、权限和依赖，不让模型猜测作用域。
- **无人值守编排**：支持周期任务、Standing Order、Heartbeat 和依赖感知队列，不打开终端也能持续推进。
- **监督与恢复**：在有界预算内 resume/retry，避免重放已知副作用；需要人时进入 Attention。
- **真实结果审查**：保留测试、lint、build、Git、HTTP、浏览器、Approval 与 Handoff 事实，
  但不把模型文案当成证明。
- **Provider-neutral 执行**：所有 Provider 进入统一的 Run/Attempt 生命周期，不让项目状态绑定某个 Agent。
- **可审计交付**：changed files、revision、Evidence、Approval、通知和 release/PR 动作最终汇入
  Handoff，而不是停留在模型生成的成功文案。
- **受控部署**：控制面与 SQLite authority 运行在你掌控的机器上；Release 安装将 Web Gateway、
  Runner Core 与 Agentic Worker 隔离为三个系统进程。

## Provider 支持状态

当前 Release 注册了四个 Coding Agent Provider。只有已经启用且运行时就绪的 Provider 才会在
catalog 中允许提交新 Work；这里的状态表示真实验收程度，不以“仓库里已经有 adapter 代码”冒充可用。

| Provider | 状态 | 说明 |
| --- | --- | --- |
| Codex | **已测试** | 默认完整 Provider；真实执行、Session、恢复、中断和交付链路已经过测试。 |
| Claude / Claude Code | **预览，尚未真实测试** | 可复用本机 Claude Code 登录、配置与 Session，也支持显式 SDK 认证；已有自动化测试覆盖，但真实账号端到端链路尚未完成 live acceptance。 |
| Pi Coding Agent | **预览** | 通过 RPC 执行，支持 Session 读取/恢复、中断、模型发现及 Session 内模型切换；Release 已包含 Xuanwu policy extension，但在更广泛的真实使用评估完成前保持预览。 |
| Qoder | **预览** | 使用 SDK 1.0.32 与配套 CLI 1.1.40，支持 Session 创建/列表/读取/恢复、中断、审批和模型发现；已有真实账号验收，但集成与再分发边界仍保持预览。 |

未指定标题的 Codex 会话可复用 Supervisor 的模型配置，通过一次 LLM 调用自动命名。
格式为 `MMDD｜类型｜主题`，Prompt、类型和主题跟随应用的中英文语言设置；日期按后端动态检测的系统时区转换，不依赖浏览器。
保留用户标题，语言切换不批量改名历史会话，命名失败不阻塞执行。
命名规则与 API 参数见 [Codex 对接说明](docs/codex-integration.md)。

## 路线图

玄武正在向一个 Provider-neutral、可远程操作、能够长期无人值守运行的 AI 工程控制面演进。

| 阶段 | 重点 | 带来的能力 |
| --- | --- | --- |
| 已支持 | 经过测试的 Codex 执行，以及持久化 Work/Run、监督恢复、Attention、Evidence 与 Handoff | 从一个控制面跨项目运行长期工程任务 |
| 已支持 | Telegram IM | Adapter、long polling、严格来源 allowlist、Conversation、通知、项目选择和 inline action 已通过真实 Bot 验收并部署到本地运行态 |
| 预览 | Claude、Pi Coding Agent 与 Qoder 执行 Provider | 在继续完成真实验收的同时，通过同一套 Work/Run 生命周期评估不同 Coding Agent |
| 计划 | 继续接入 Kimi Code、zcode、OpenCode 等 Coding Agent Provider | 在不改变 Work/Run 生命周期的情况下接入更广泛的 Agent 生态 |
| 后续 | 更多 IM Channel 与更完整的 Provider 路由 | 按能力、健康状态和策略调度 Agent，并从更多入口管理工程工作 |

路线图表达产品方向，不代表具体版本或交付日期。只有真实执行、恢复和交付链路通过所需的
集成验收后，相关能力才会标记为“已支持”。

## 当前状态

玄武仍在快速演进。`v0.2.x` 面向在自有可信机器上运行的个人开发者和小型团队。“常驻”描述的是
daemon、scheduler 与恢复模型，不是可用性 SLA；宿主机与配置的 Provider 仍需保持在线。玄武不是
经过加固的多租户隔离边界，Web UI 不应直接暴露到公网。

GitHub 仓库、Release 资产、二进制、CLI、Skill、环境变量、服务标识和默认数据目录统一使用
**Xuanwu**：命令为 `xuanwu`，环境变量前缀为 `XUANWU_*`。

## 让你的 Agent 安装玄武（推荐）

玄武自带 Issue 管理 Skill。安装后，Codex 或 Claude Code 可以替你注册项目、创建与启动 Issue、
查看执行状态，以及处理重试和取消；真正执行 Issue 的 Coding Agent 由玄武统一调度。

把下面这段话直接发送给你的 Codex 或 Claude Code：

```text
请帮我安装 Xuanwu：https://github.com/williamnie/xuanwu

请先阅读仓库 README 和安装脚本，再安装适合当前系统的最新 Release；然后识别你当前是
Codex 还是 Claude Code，把仓库中的 xuanwu Skill 安装到对应的个人 Skills 目录。
安装后运行 xuanwu-daemon doctor，确认玄武服务健康，并告诉我 Skill 的安装路径。全新交互式安装时，
把只显示一次的 Remote access token 和保存路径告诉我，方便浏览器首次连接；不要把 token 写入其他
位置，也不要修改与本次安装无关的配置。
```

如果已经克隆仓库，也可以手动安装 Skill：

```bash
./scripts/install-agent-skill.sh codex   # 安装到 Codex
./scripts/install-agent-skill.sh claude  # 安装到 Claude Code
```

把 Xuanwu Skill 安装到 Claude Code，与在玄武中选择 Claude 作为执行 Provider 是两件事；
安装 Skill 不会改变上面 Claude Provider **尚未真实测试**的状态。

安装后可以直接告诉 Agent：`请用 Xuanwu 为当前仓库创建一个 triage Issue：修复登录页错误提示。`

## 安装 Release

### 前置条件

- ARM64 或 x86_64 的 macOS / Linux；
- `curl`、`tar`，以及用户级 `launchd` 或 `systemd` 会话；
- 已安装并登录 [Codex CLI](https://developers.openai.com/codex/cli/)。

安装器会下载匹配平台的产物、校验 SHA-256 checksum，并注册 Web Gateway、Runner Core 和
Agentic Worker 用户服务。仓库公开后的 Release 还会发布 GitHub provenance attestations，
安装器在可用时会一并验证：

```bash
export XUANWU_ADDR=127.0.0.1:3008
curl -fsSL https://raw.githubusercontent.com/williamnie/xuanwu/main/scripts/install-release.sh | bash
```

然后打开 <http://127.0.0.1:3008/>，按产品内“首次交付”向导完成配置。

```bash
xuanwu-daemon status
xuanwu-daemon doctor
```

默认安装路径：

```text
二进制  ~/.local/bin/xuanwu
状态    ~/.local/state/xuanwu
数据库  ~/.local/state/xuanwu/runner.db
Token   ~/.local/state/xuanwu/auth_token（权限 0600）
```

全新交互式安装会在终端打印一次自动生成的 Remote access token；重启和升级不会再次打印。之后可在
服务器上读取：

```bash
cat ~/.local/state/xuanwu/auth_token
```

如果是在 macOS 上从源码执行 `./deploy.sh` 部署到 launchd，默认路径不同：

```bash
cat "$HOME/Library/Application Support/xuanwu-bun-live/state/auth_token"
```

自定义部署请以 `XUANWU_AUTH_TOKEN_FILE` 或 `XUANWU_STATE_DIR` 为准。

浏览器首次打开时会进入连接页，将这个 token 保存到当前浏览器。登录后可在
**设置 → 高级 → 运行环境 → Remote access token** 中轮换；旧 token 会立即失效，新 token 只显示一次。
如果通过 `XUANWU_AUTH_TOKEN` 管理凭据，UI 会禁用轮换，需要在部署环境中修改。

如需修改监听地址、状态目录、Codex 可执行文件或 Claude Provider，请查看
[`scripts/install-release.sh --help`](scripts/install-release.sh) 和
[Provider 设置说明](docs/provider-settings.md)。局域网或远程访问必须保留 bearer token，
并在服务前使用 TLS 反向代理或 SSH tunnel。

重要状态投入使用前，请先阅读[发布、升级与回滚](docs/runbooks/release-upgrade-rollback.md)和
[备份与恢复](docs/backup-restore.md)。

## 从源码运行

前置条件：[Bun](https://bun.sh/)、Node.js/npm、Git，以及已登录的 Codex CLI。

```bash
git clone https://github.com/williamnie/xuanwu.git
cd xuanwu
./dev.sh
```

`dev.sh` 会安装缺失的前后端依赖，在 `127.0.0.1:3569` 启动 Bun API，并在
<http://127.0.0.1:3568/> 启动 Vite。它是前台开发命令，终端退出后两个进程都会停止。

macOS 从源码安装后台服务：

```bash
./deploy.sh
```

完整开发和运维命令以[架构索引](docs/architecture/README.md)与
[runbooks](docs/runbooks/)为准。

## 验证代码

```bash
cd backend-ts && bun test --timeout 60000
cd ../frontend && npm run lint && npm run build
cd .. && node scripts/repository-hygiene-audit.mjs --json
```

六条确定性、隔离的 Golden Journey fixture 可统一重放：

```bash
bun scripts/run-golden-journeys.ts
```

Fixture 通过不代表真实 Provider 账号、外部 Connector、浏览器会话或生产部署健康；需要凭据
和外部环境的 live acceptance 必须单独执行并保留证据。

## 安全

玄武可以在宿主机执行工具并修改代码仓库。Provider、Connector、Skill、MCP Server 与项目指令
都应被视为可信计算边界的一部分。必要时使用独立系统账号，审查 Permission/Approval 策略，
不要把 token 写入 Issue、日志或截图，也不要在无鉴权条件下暴露服务。

安全漏洞请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可证

玄武是采用 [Apache License 2.0](LICENSE) 的开源软件。遵守许可证条款即可进行使用、修改和
分发，包括商业用途。分发本项目或衍生版本时，必须按许可证要求保留相关许可与署名声明，
包括适用时的 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。
