# Qoder Q7 真实账号验收记录（2026-08-13）

## 结论

本轮在用户明确授权的 `local-cli`、最多 10 个 paid turns、最多 3 Credits 边界内执行。Qoder 的真实
read-only、同 Session resume、Runner 重启恢复、workspace-write、显式 allow/deny、两路并发与精确 interrupt
均取得真实证据，但 release 安装布局、Runs Provider transcript 和真实失败矩阵没有全部通过或执行。

因此 Qoder **保持 `preview`，不提升 support level**。本记录不能写成完整 release live-tested。

## 环境与边界

- checkout 基线：`c7061aacc7a16d01796ae4603ff5652ab45366e5`；source runtime，macOS arm64，Bun `1.3.10`；
- 冻结版本：SDK `1.0.20`、CLI `1.1.18`、protocol `1.2.0`；
- 认证：已登录 `local-cli`，只复用 `<home>/.qoder`，未复制、读取或归档 credential material；
- 隔离：独立临时 Runner DB、auth token、端口和 Git repository；未创建新的业务 Issue 或 Verifier Issue；
- support level 始终为 `preview`；未 deploy、push 或修改 live Runner 数据；
- paid turns：`10 / 10`；逐 Session 可观察 assistant usage Credits 合计
  `1.353245357142857 / 3`。

## 真实验收结果

| 范围 | 结果 | 证据摘要 |
| --- | --- | --- |
| local-cli readiness | PASS（source runtime） | 登录 status、模型列表与 Provider `ready=true`；SDK/CLI/protocol 为冻结版本 |
| read-only | PASS | 只读 README，隔离仓库保持 clean |
| 同 Session 两轮 resume | PASS | Session `8b1e…332c` 保持不变，三个 turn ref 各不相同 |
| Runner 重启后 resume | PASS | 重启前后 Session、history turn 数与 Credits 连续，随后仍在原 Session resume |
| workspace-write | PARTIAL | `acceptEdits` 诊断下目标文件写入成功且无其他写入；后续安全复核发现该模式会绕过 workspace path callback，最终 containment-safe 映射只有离线回归，预算内未再次付费复验 |
| allow approval | PASS | 并发 A 收到一次 approval request，显式 approve 后写入成功 |
| deny approval | PASS | 并发 B 收到一次 approval request，显式 deny，目标文件不存在 |
| 两路并发与精确 interrupt | PASS | 同时观察到 2 个不同 invocation lease；只中断 B，A 正常成功；最终 lease 为 0 |
| Session transcript | PASS | user/reasoning/assistant/tool/result history 可读，真实 tool result 与文件状态一致 |
| Credits | PARTIAL | 各 Session assistant usage 可累加且低于预算；直接 result 曾给出 `total_credits=0`，但 assistant usage 非零，未解释为免费 |
| 凭据与孤儿进程 | PASS | 脱敏扫描未命中 credential material；验收子进程与 lease 均归零，仅保留操作者原有 TUI |

逐 Session 的可观察 Credits：

| Session | turns | observed Credits | 说明 |
| --- | ---: | ---: | --- |
| `8e02…eb24` | 1 | 0.08379071428571429 | 直接 SDK 只读基线 |
| `8b1e…332c` | 3 | 0.1585460714285714 | Runner 创建、resume、重启后 resume |
| `25bd…c680` | 1 | 0.12401928571428572 | 修复前 workspace-write 被 `dontAsk` 拒绝 |
| `379e…e603` | 1 | 0.5688632142857143 | 长轮次在上限窗口内人工中断，无文件写入 |
| `a97f…aeb8` | 1 | 0.1598182142857143 | `allowedTools` 修复后仍被 `dontAsk` 拒绝 |
| `9386…0ce7` | 1 | 0.13651857142857143 | `acceptEdits` 诊断下 workspace-write 通过，但该映射随后因绕过 containment callback 被废弃 |
| `c6d1…0c47` | 1 | 0.06445357142857142 | 并发 allow，正常成功 |
| `8717…6728` | 1 | 0.05723571428571428 | 并发 deny，精确 interrupted |

## 本轮定位并修复的问题

1. Qoder SDK child 收到的显式 `env` 丢失 `HOME/PATH/TMPDIR/USER`，导致 local-cli control
   `initialize` 稳定在 120 秒超时。修复为只透传运行所需的宿主环境 allowlist，不透传 Claude、Codex 或
   其他 ambient secret。
2. `approval_policy=never + workspace-write` 被映射为 Qoder `dontAsk`，真实 tool result 明确表示所有需权限
   的工具会自动拒绝。`acceptEdits` 虽能完成功能样本，但会自动批准写工具并绕过 Runner 的 workspace
   path/symlink containment callback，因此最终修复为 `default + canUseTool`：`never` 仍不询问用户，但只对
   可证明位于 workspace 内的 `Edit/Write` 自动 allow，越界写入 deny；read-only 仍为 `dontAsk`，
   `always/danger-only` 仍通过 host callback。最终安全映射已通过离线回归，未在耗尽的本轮预算内追加真实调用。

## 未通过或未执行项

- **Release 安装布局失败**：现有 release archive 来自旧 revision，缺少 Qoder asset；当前单独复制到
  `dist/xuanwu.qodercli.mjs` 的文件又缺少 Qoder `bundle/policies` 等相邻 runtime assets，真实启动报
  `sandbox-default.toml` 不存在。真实调用最终使用 `node_modules` 中冻结的完整 CLI bundle，因此只能证明
  source integration，不能证明 release install/upgrade/rollback。
- **Runs Provider transcript 未执行**：本轮遵守“不创建新的业务 Issue 或 Verifier Issue”，通过 Session API
  和直接 Provider harness 验收；没有创建隔离 Issue/Run，不能声称 Runs API transcript 已通过。
- **真实 expired auth、quota、unsupported model、network failure 未执行**：paid turns 已达到 10；quota
  也没有可安全触发的测试账号条件。空白 config 的 local-cli readiness 能 fail closed，其他分类只有离线
  fixture 证据，不能替代真实失败样本。
- `result.total_credits` 与 assistant usage 的非零 Credits 不一致；Runner 正确保留 partial provenance，但在
  上游语义澄清前不能宣称 result/assistant/session 完整对账。
- 唯一验收 commit `bc3d171` 记录的是预算内真实证据，但其中的 `acceptEdits` 候选映射已被提交后的
  containment 安全复核否定；当前工作区的安全修正尚未纳入该 commit，因此该 commit 不可直接合并。

在修复 release 完整资产交付、补齐不创建业务 Issue 的 Runs transcript 验收入口，并以新的授权预算完成失败
矩阵前，不应评估 `preview → tested`。
