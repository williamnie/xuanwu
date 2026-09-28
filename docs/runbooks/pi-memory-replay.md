# 隔离记忆回放（#972）

```sh
bun scripts/replay-pi-memory.ts
bun scripts/replay-pi-memory.ts --live --pi-state-dir '/path/to/existing/state'
```

第一条只执行 fixture，不调用模型。第二条通过 SDK `readStoredCredential`、`ModelRuntime` 和既有 SecretService 复用已配置 Pi 身份，使用当前源码；不请求线上 Xuanwu HTTP 服务。鉴权存储适配器只读，无法刷新时报告 `needs_user`，不复制或导出凭据。模型目录禁用网络刷新，缓存、项目和 DB 均放在本次新临时目录。无 Shell、外部消息、任务调度、部署或 GitHub 工具。

每次命令输出 `report.json` 路径。目录同时保留新 `state/runner.db`、无 remote 的虚构 Git 项目、`commands.json`、`tool-steps.json`、`audit.json`、调用预算账本。报告含 HEAD、分支、起始脏文件清单、tracked diff 指纹及回放、生产复盘提示和工具源码指纹；脏树不能冒充某个纯提交版本。每个案例保存调用前后计数，派发和回执关联独立会话 ID。用量回执到达后立即刷新账本。每个案例在执行后保存事实，首个失败后其余标为 `not_run`；不填充期望观察。临时目录由调用者在证据归档后清理。

真实演练全局预算：30 分钟、最多 20 次顶层 SDK `agent.streamFunction` 派发；工具循环后的继续调用也计入，失败调用也计入。SDK/Provider 隐式重试、自动压缩关闭，复盘继续受生产的 4 调用、3,000 输出 token、45 秒/6 工具上限约束。Provider 用量回执逐次保存 input/output/cache/reasoning token 和 SDK 估算美元成本；缺失回执表示未知，不能当作免费调用。

一次失败后，最多显式重试一次；沿用原始开始时间及已消耗调用，不重置预算：

```sh
bun scripts/replay-pi-memory.ts --live --pi-state-dir '/path/to/existing/state' --retry-from '/previous/report.json'
```

原目录以独占创建的 `retry-claimed.json` 防止重复领取重试。模型调用前同步记录 `budget-ledger.json`；失败或中断的派发不能从下一轮预算中消失。到调用/时间上限即停止。fixture、单元测试中的 faux transport 不计入真实 Provider 账单，也不能代替 live 验收。

## 案例和评分

| 案例 | 实测来源 |
| --- | --- |
| 首次学习 | 真实 `node --test` 先失败再通过，记录 Work→Run→Evidence→Handoff；复盘 Worker、生产 Prompt、记忆工具、Action Gate 持久化 |
| 无记忆对照 | 全新 SDK 会话，同一任务与仓库，仅去掉 memory_search 工具 |
| 相似表达 | 新会话读取当前规范，检索并提交精确 id/revision/fingerprint 的 Pi selection；评分检查真实工具结果中的引用 |
| 业务反例 | 从 A 的 `>=100` 改为 B 的 `>200`；要求重新读取规范，199/200/201 的判断必须吻合，旧业务值不能复用 |
| 纠错 | 新可信 Evidence，原 key 的 CAS 修订和 narrow 原因；历史保留、当前只有一个 memory |
| 重启去重 | 关闭重开 DB、重放验收事件，检查派发增量为零、revision/occurrence 不变；纠正后的记忆仍可召回 |
| 遗忘不复活 | 既有遗忘入口、重开 DB、新 Evidence 指纹，零模型派发且来源受抑制 |
| 预算不阻塞 | 明确标为 fault injection：调用真实预算 guard，最多两次 worker 尝试，Work 仍为 done |
| 权限边界 | 只授予搜索权限，记忆写入必须被 Action Gate 拒绝 |

`kind=live` 不表示每一条都调用模型。重启/遗忘/权限为 Host 断言，预算是故障注入；`evidence_mode` 明确区分。fixture 的语义输出是预先定义的策略，评分只说明 Host 链路可重放。真实模型不接收 fixture 预制的记忆正文或答案，观察完全来自 SDK 与工具回执。

此对照仅测试边界测试建议与记忆工具链，不是 Coding Provider 自动修改项目、正式服务启用或总体质量/速度的因果试验。复盘专用 `memory_remember` 接收结构化 `content` 对象，模型只选择 `reflection_evidence_read` 给出的可用 `evidence_index`。Host 绑定项目、Work、Run、schema version、失败诊断标记和完整 Evidence 引用，不让模型拼装这些字段。持久化结构和普通聊天的工具合同保持兼容，来源仍经公共校验与 Action Gate。回放暴露的 live 失败必须保留。#973 仍负责正式项目启用和主观质量抽验。

纠错先通过 `memory_search` 读取旧经验；模型提供原 `memory_key`、`correction.disposition/reason`，Host 使用本次工具实际返回的记录与版本补齐 `expected_revision`。并发修改、过期/不可信证据、跨项目和遗忘保护仍会阻止写入。复盘搜索使用 4,000 token 的候选预算，再受 8 KB 返回限制与整个复盘的输入预算约束。纠错案例的证据摘要只引用旧记忆的身份与版本，全文从搜索工具读取，避免截断掉新证据与收窄范围。

复盘搜索需要在 `query` 中包含证据提供的版本和适用条件；任务对照使用相同任务和真实 SPEC 摘要作为 `task_description`。模型自行生成经验和选择候选，不从 fixture 复制正文或答案。状态规则匹配实际任务状态、队列与数量，不把“当前业务规格”等时间词单独当作状态快照。候选召回保留项目、版本、显式排除/限定及否定条件检查，但普通适用条件不要求逐词相等；候选不代表已适用，Pi 仍须根据实际规格选择。经验措辞指导和离线回归不能代替真实写入、召回与反例验收。

## 集成验证

`memoryReplay.test.ts` 已接入 Golden Journey GJ-06。按文件对应 runner 运行，自动回归不访问真实模型：

```sh
bun test backend-ts/src/xuanwu/memoryReplay.test.ts backend-ts/src/pi/memoryReflectionRuntime.test.ts --timeout 60000
bun scripts/run-golden-journeys.ts
```

本次实测结果见 [验收报告](../reports/pi-memory-replay-972.md)。
