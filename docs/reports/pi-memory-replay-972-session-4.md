# Issue #972：新 Session 隔离真实回放

2026-09-29，本次隔离验收完成。真实首次学习、无记忆对照、召回、业务反例和纠错五项通过；重启、遗忘和权限检查通过。预算案例的原评分存在误报，已独立补验通过并修正回放器。没有使用 fixture 替代真实 Pi 证据，也没有写回 Issue/Run 状态。

这是单个虚构项目的能力验证，不能据此宣称总体质量或速度提升。纠错正文还有一处未经证据支持的故障叙述，见下文限制。

## 版本与隔离

- HEAD：`d3aa54dee64900e54c62e11f9e63ae08e7d4e356`，使用当时的脏树源码，并非该纯提交。
- 工作区已有其他会话正在修改复盘工具、测试和回放参数。先保存初始文件指纹、diff，再归档真实执行源码；九个 live provenance 源文件指纹全部与归档一致。后续源码变化独立列在 JSON 中，未冒充经过 live 验证的版本。
- 每次演练使用新的 DB、运行目录和无 remote 的虚构 Git 项目。只通过既有只读鉴权入口复用 `runner-default / openai-codex / gpt-5.6-terra / high`，五个任务使用独立 SDK 会话。
- 没有创建真实业务 Issue 或 Verifier Issue，没有修改生产 DB、项目开关、凭据或服务，没有部署、提交或 push。隔离 DB 中的合成 Work/Run/Evidence/Handoff 仅供实验。
- 本次新增改动仅为预算故障注入的最小修复、独立报告与证据。既有及并发修改完整保留，未修改 Host 校验。

## 实际观测

| 案例 | 证据类型 | 调用数 | 观测 |
| --- | --- | ---: | --- |
| 首次学习 | 真实 Pi | 4 | 本地 Node 测试先失败再通过；Pi 经生产复盘工具写入 `evidence_backed` 记忆 revision 1 |
| 无记忆对照 | 真实 Pi | 2 | 无 `memory_search` 工具；读 SPEC/gate，输出 99=false、100=true、101=true，无记忆引用 |
| 相似表达召回 | 真实 Pi | 4 | 搜索后记录 `pi_selected`，输出精确 id/revision/fingerprint 引用，边界答案正确 |
| 不同业务规则反例 | 真实 Pi | 4 | 重新读取 campaign B，复用测试方法，输出 199=false、200=false、201=true，没有套用 A 的 `>=100` |
| 纠错 | 真实 Pi | 4 | 读取旧记忆，用新 Evidence 对同一 key/id 执行 `narrow`，revision 1→2，没有新建重复记忆 |
| 重启去重 | Host 断言 | 0 | 关闭重开 DB、重放接受事件；revision=2、occurrence=2 保持不变，修订后的记忆仍可检索 |
| 遗忘不复活 | Host 断言 | 0 | 遗忘后重开 DB、添加新 Evidence；记忆为空，来源被 `source_memory_suppressed` 拦截，无派发 |
| 预算不阻塞 | 故障注入，独立补验 | 0 | 每次允许 4 个假派发，第 5 个被预算拒绝；两次尝试后停止，合成 Work 仍为 done |
| 权限边界 | Host 断言 | 0 | 仅授权搜索时，写入被 `allowed_actions` 拒绝 |

记忆 ID：`9db5fdf7-1413-4d2c-9f42-9a58c9ff95c3`；key：`gate.threshold-boundary.campaign-spec`。相似表达和反例的真实工具结果均选择 revision 1，引用 fingerprint 为 `daabdfda8cf693c12f93d0bfa22455044d97fb1c8976e25af4a688108f868ffb`。

两次持久化的 `source.work_id/run_id` 分别为 `xw:work:issues:1` / `xw:run:issue_runs:replay-1` 和 `xw:work:issues:2` / `xw:run:issue_runs:replay-2`。只有 refs 使用 `work:` / `run:`，Evidence refs 使用 `evidence:`。模型选择有界 Evidence 索引，Host 构造 canonical 引用并继续执行来源、Gate、CAS 和遗忘检查。

最终 DB 中记忆条数为 0 是遗忘案例的预期结果。持久化历史保留 create→correct→forget 的 revision 1→2→3 轨迹与 forgotten tombstone；遗忘前的完整内容及 narrow 原因保存在逐例报告中。独立只读检查 `pragma quick_check` 返回 `ok`。

## 预算与用量

| 指标 | 实测 |
| --- | ---: |
| 真实 SDK 派发 / 上限 | 18 / 20 |
| 用量回执 | 18 / 18 |
| 独立 SDK 会话 / 显式重试 | 5 / 0 |
| Live 墙钟 / 上限 | 76,681 ms / 1,800,000 ms |
| Input / output tokens | 29,212 / 2,719 |
| Cache read / write tokens | 12,800 / 0 |
| Reasoning tokens，已含于 output | 558 |
| SDK totalTokens | 44,731 |
| SDK 估算 USD，非账单 | 0.093612 |

首次学习与纠错均为 `reflection_evidence_read → memory_search → memory_remember`。有记忆任务为 SPEC/gate 读取、候选搜索、精确选择；无记忆对照只有仓库读取。完整参数、结果、单步耗时、逐例调用增量与每次用量回执见 [机器报告](pi-memory-replay-972-session-4.json)。

## 预算误报与修正

原始 live report 把 `budget_nonblocking` 记为 passed，但只读复核发现其实际错误是 `The "string" argument must be of type string or an instance of Buffer or ArrayBuffer. Received undefined`。故障注入没有传 context，在到达预算边界前就失败；这只能说明普通异常不阻塞，不能证明预算生效。原记录保持原样，没有改写为预算成功。

独立补验在新隔离 DB 中传入有效 `{messages:[]}`，观察到每次 4 个假派发，随后精确的 `reflection model call budget exceeded`；Worker 只尝试两次，第三次返回 false，Work 仍为 done。同时验证全局第 21 次派发拒绝、30 分钟到期后零派发。全程没有真实 Provider 调用。

`memoryReplay.ts` 已修正 context，并新增对 `[4,4]` 实际假派发数和精确预算错误的断言。原有 9 案例 fixture 回归会执行这些断言；没有放宽生产预算或删除失败断言。

## 验证和证据

真实命令退出码 0：

```sh
bun scripts/replay-pi-memory.ts --live --pi-state-dir '/Users/xiaobei/Library/Application Support/xuanwu-bun-live/state'
```

本地证据目录：`.runner/artifacts/issue-972/session-4-20260929T072554/`。其中 `live/` 保留原始报告、DB、工具步骤、命令、账本、审计与虚构 Git；`execution-source.tar.gz` 保存实际执行源码；`budget-verification.json` 与 `budget-state/` 保存补验；`artifact-verification.json`、`artifact-sha256.json` 保存独立断言与文件指纹。

预检期间并发源码一度失败，原日志完整保留：参数 schema、undefined 可选载荷、长记忆和 Evidence 索引测试均有记录。最终相关回归 **43 passed / 0 failed**（4 个文件，38.03 秒，exit 0），包含修正预算断言后的 9 案例 fixture，以及来源、权限、Evidence、CAS、遗忘与预算测试；`git diff --check` 通过。当前源码与 live 快照不同，后续改动没有追加真实调用。未运行全库测试、类型检查、构建或生产验收。

## 解释边界

- 对照两组都给出了正确矩阵；有记忆组多了搜索与选择步骤。因此本次证明记忆确实持久化、被选择使用、能按新证据修订，没有证明它提高了正确率或速度。
- 纠错将适用范围缩到已读 SPEC 的 campaign B，运算符与测试值正确；但其 symptom/root_cause 将“B 在 200 失败、复用了 A 规则”写成故障描述。新 Evidence 只证明 B 测试通过及适用范围变化，没有证明该 B 故障实际发生。这是经验叙述的质量风险，不能作为已验证的真实根因传播。
- 重启后的修订记忆召回是 Host 检索断言；真实 Pi 选择发生在 revision 1。没有用该断言冒充额外模型调用。
- 此报告仅完成 #972 隔离验证与事实交付。正式项目启用、部署和主观质量抽验不在本轮范围；Runner Host 负责状态写回，PI 决定语义状态。
