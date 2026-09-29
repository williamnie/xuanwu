# needs_user 工作目录释放合同（Issue #975）

本策略仅改变等待人类回答时的目录占用。`needs_user` 仍然是 PI 决定的语义状态，释放目录不结束 Issue、不替代人类授权、不改变依赖就绪性，也不释放尚未结束的 Run 的执行容量。Host 负责检查与持久化。

## 类型与安全条件

| 等待类型/事实 | 目录策略 |
| --- | --- |
| 有明确 `HumanReviewRequest` 的 `decision`、`risk_acceptance`、`acceptance` | 满足下列全部条件时可释放 |
| 只有 `needs_user` 状态或错误文字，没有开放的结构化问题 | 继续持锁 |
| Provider 原生提问、审批或其他仍在执行的 Session/Run/Attempt | 继续持锁 |
| dirty、状态未知、Git 观察失败、缺少历史 Run | 继续持锁 |

可释放必须同时满足：

1. Issue 为 `needs_user`，最新 Run 已结束，审批请求仍为同一 ID/revision。
2. 同一规范化 CWD 下没有未结束的 Run/Attempt、`in_progress` 同行 Issue 或活跃的 Agent Session。Session 必须明确为终止状态或 Provider 报告的 `idle`；`idle` 不能覆盖尚未结束的 Run/Attempt。未知 Session/Attempt 状态也阻止释放。
3. CWD 是可解析的 Git 仓库根目录，HEAD 有有效提交；连续两次完整 status 均无索引、跟踪文件或非忽略的未跟踪文件改动；HEAD 与分支在观察前后相同。
4. 没有 Git 锁、merge/rebase/cherry-pick/revert/bisect/sequencer 操作。含子模块、skip-worktree 或 assume-unchanged 索引的仓库保守保留锁。
5. Git 观察结束后，在 SQLite `IMMEDIATE` 事务中重新检查执行版本、问题版本、输入指纹和上述数据库事实。

不尝试认领 dirty 文件；即使看似属于当前任务，也不自动 stash/reset/commit。Git 忽略文件遵循仓库的 Git 约定；本合同不提供对任意外部进程、被忽略构建产物或绕过 Host 的直接文件写入的操作系统互斥。

## 释放与恢复

`issue.workspace_wait.v1` 是 Host 的持久化凭据，包含状态 `released / acquired / consumed`、原 Run、审批 ID/revision、规范化 CWD、HEAD、分支及输入指纹。输入覆盖 Issue 内容/来源/工作流、人类输入版本、项目执行配置和所选 Agent Profile。使用既有事件账本，不新增 schema 或另外一套 Issue 状态。

`issueQueue` 只对具有匹配释放凭据的等待 Issue 豁免目录占用；开放 Run 永远优先。CWD 符号链接别名共用同一个锁。`projectLoopManager` 在开始下一项工作前尝试验证等待任务，PI 进入 `needs_user` 后也会唤醒该检查。检查失败不忙循环、不降级放行。

人工回答先在事务外重新读取 Git，再于同一个 `IMMEDIATE` 事务内核对观察期间的执行版本、问题绑定和输入版本，记录回答并取得 `in_progress` 目录占用。另一任务已占用或工作区 dirty 时拒绝本次回答，保留原请求和文件。

HEAD、分支或输入版本与释放凭据不同时，旧回答不落库，生成新的审批 ID/revision 并返回冲突，要求人类刷新后再次确认。新请求保留问题、范围和证据引用，并标明版本变化。不得把用户对旧版本的回答隐式绑定到新版本。

恢复调用 Provider 前，`runPreparation` 再做一次干净工作区与输入验证。成功后将凭据记为 `consumed`，交回正常 Run 目录保护；失败则关闭尚未开始执行的准备 Run，恢复人工确认并记录原因。此时不处理工作区文件。

Run 物化、Run Attempt resume/recovery、通用 `session.steer` 和 Supervisor followup 都受检查。未经回答的 released wait 不能通过 enqueue/retry 或旧 Session 控制绕开。原有 Action Gate 和运行修订校验仍然执行。

## 并发与崩溃检查点

| 中断/竞争点 | 可恢复事实与结果 |
| --- | --- |
| Git 观察期间退出，释放事务尚未提交 | 无释放凭据，旧锁仍在 |
| Git 观察期间有任务启动又结束、请求被替换、输入变化或取消 | 版本复查失败，不提交释放或回答 |
| 释放事务完成后进程退出 | 新进程从事件账本恢复释放事实，队列仍以数据库事务独占 claim |
| 两个连接同时 claim；回答与 claim 竞争 | `IMMEDIATE` 事务下只允许一个目录占用者；失败方不调用 Provider |
| 两个人同时回答同一请求 | 后提交者在请求、执行版本或凭据检查中失败，仅有一个新 Run/Turn |
| 回答提交后、Provider 调用前重启 | 已取得的目录占用仍有效；启动恢复恢复新的人工确认，不自动把此 Run 放回 todo |
| 回答后到执行准备期间 Git/输入变化 | 准备失效，未调用 Provider，生成新的人工确认 |
| 取消后到达旧回答 | 请求状态/执行版本检查拒绝回答，不复活已取消的 Issue |

所有 Git 子进程复用既有观察并发上限与截止时间。事件账本缺失、损坏或无法验证时保持保护；没有强制解锁入口。

## 自动验证

`backend-ts/src/runner/workspaceWait.test.ts` 使用临时真实 Git 仓库、真实 SQLite 与假 Provider，通过队列、PI 语义落库和人类审批服务建立状态；不修改真实任务状态、不强制解锁。

覆盖：干净等待释放、dirty 的四种形式、未知等待、活动 Run/Session、数据库重开、双连接 claim、CWD 别名、HEAD/分支/输入过期、观察期间输入与取消竞争、重复回答、原 Session 恢复、执行前再验证、启动恢复、retry/steer/followup/Run Attempt 绕行拒绝。

相关回归范围为 issueQueue/projectLoop、humanReview、runPreparation、PI acceptance、Run command service、Session 控制入口和 startup recovery。假 Provider 只证明本地调度与持久化合同，不代表真实 Provider 或部署验收。

## 本次验证记录（2026-09-29）

实际工作区基线为 `codex/pi-memory-phase1` / `774fb181`。实现前定向基线 44 pass；先新增“干净终止等待不阻塞独立任务”用例，得到 1 fail / 1 pass（exit 1），再实现。没有对真实 Issue/Run 执行生命周期操作。

组合回归命令如下，结果 157 pass / 0 fail，exit 0：

```sh
bun test --timeout 30000 \
  backend-ts/src/runner/workspaceWait.test.ts \
  backend-ts/src/runner/projectLoop.test.ts \
  backend-ts/src/db/repositories/issueQueueDependencies.test.ts \
  backend-ts/src/domain/review/humanReview.test.ts \
  backend-ts/src/domain/run/runPreparation.test.ts \
  backend-ts/src/domain/run/runPreparationArchitecture.test.ts \
  backend-ts/src/runner/piAcceptanceCoordinator.test.ts \
  backend-ts/src/runner/piAcceptanceApplication.test.ts \
  backend-ts/src/db/repositories/issueActions.test.ts \
  backend-ts/src/domain/run/service.test.ts \
  backend-ts/src/http/piActionDispatch.test.ts \
  backend-ts/src/http/runApi.test.ts \
  backend-ts/src/runner/recovery.test.ts
```

边界复核后，重新运行 `bun test --timeout 30000 backend-ts/src/db/repositories/issueActions.test.ts backend-ts/src/runner/workspaceWait.test.ts`：31 pass / 0 fail，exit 0，包含额外输入变化和独立新进程恢复用例。随后新增的 Provider `idle` 用例通过 `bun test backend-ts/src/runner/workspaceWait.test.ts --test-name-pattern 'Provider idle'` 验证：1 pass，exit 0。最终新增矩阵共 28 项；每项都有通过记录。

其他检查：

- `bun scripts/run-golden-journeys.ts --scenario GJ-01 --scenario GJ-02 --scenario GJ-03 --artifacts /tmp/issue-975-golden`：3 个隔离场景全部通过，exit 0；包括 fixture、backend、frontend、router/API 检查及清理，不是实际浏览器或真实 Provider 验收。
- `node scripts/repository-hygiene-audit.mjs --json`：无 findings，exit 0。
- `git diff --check`：exit 0。
- `bunx tsc -p backend-ts/tsconfig.json --noEmit`：exit 1；与改动前的 153 条既有 TypeScript 错误逐行一致，没有新增诊断。

未执行部署、提交或推送；SSE 相关受保护路径、Qoder 及依赖版本未修改。
