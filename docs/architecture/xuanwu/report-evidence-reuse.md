# 报告补全的跨 Run 执行证据

Issue #974：补报告字段时，PI 可以读取同一 Work 前序 Run 的有效观察。原始命令及失败结果仍在事件账本；不把历史命令加入当前 Run 的 `commands`，也不把它们写成长期记忆中的当前测试事实。

## 读取与验收链

1. Run preparation 与终态 Git 观察分别追加 `issue.execution_evidence_context.v1` 的 start/terminal 记录。记录 Work、项目、仓库真实路径、任务输入指纹、Host 环境及执行配置指纹。环境使用进程内随机密钥 HMAC，只保存摘要；Host 重启后旧环境不能被自动认定相同。
2. Completion card 的可选 `prior_evidence` 从前序卡片读取原始命令，不递归继承旧卡片的复用结论。每项保留 `source_run_id`、`source_card_fingerprint`、`source_event_ref`、`context_refs`、命令原始出口码和观察时间。
3. Host 检查同项目/Work、canonical Run 顺序、原始命令 Run 绑定、完整 Git revision 和工作区内容指纹、任务输入与环境记录。还读取当前工作区，防止终态记录之后的修改被遗漏。来源 Run 和当前 Run 的开始/结束快照必须一致；缺少命令级快照时，Run 内改过代码的历史命令不能直接复用，需要一次明确的补验。
4. `reusable` 表示记录范围内的机械条件匹配。PI 仍负责判断命令是否覆盖验收目标，以及输入/环境是否落在 `repository_and_host` 观察范围内。远端服务、仓库外输入、ignored 依赖、Provider 私有 shell 或工具链均未被此摘要验证；相关条件无法确认时必须补验，不能靠模型声明相同。失败的复现命令可以作为失败观察引用，不能作为成功回归。
5. `revalidation_required` 携带具体 `reasons` 和 `revalidation_commands`。命令列表是需要审查的来源索引，PI 选择相关验证，不自动重放修改或外部副作用。`issue.execution_evidence_revoked.v1` 可用 `source_run_id` 或 `source_card_fingerprint` 指向撤回的来源，并在账本保留 reason；卡片给出撤回事件引用。后续同命令的不同结果、缺失的中间 Run、未知条件均不能被旧绿灯覆盖。
6. PI 收到完整来源链；GitHub investigation/repair 报告读取同一投影。Application 在接受前重新读取工作区和条件，在提交验收事务内再次检查账本。报告格式缺口只补报告；失效来源按记录补验。历史来源不得计入当前 `progress.evidence_refs`。

原始账本 → 前序 completion card → 当前 `prior_evidence` → PI 决策 → 接受事务中保存的 completion card → Handoff 的卡片引用，使来源与补验要求可追溯。Handoff 不把前序命令重新标为当前 Run 的命令 Evidence。

## 保守边界

- 旧 Run 缺少 start/terminal 条件、明确命令绑定或 Git 快照时，不能自动升级成当前验证。
- 最多读取 24 条历史卡片，投影至多 72 条原始命令；省略数量与损坏来源显式保留。超过窗口且无法确认的来源须补验。
- 不修改 DB/schema、依赖版本、SSE 或记忆持久化，不放宽完成门禁。这里只增加已有账本上的观察与验收上下文；生命周期仍由 Host/PI 处理。
- 自动测试使用隔离临时仓库/DB 和合成命令观察，不代表真实 Provider、GitHub Actions 或正式服务验收。
