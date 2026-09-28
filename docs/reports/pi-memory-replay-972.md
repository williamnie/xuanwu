# #972 隔离记忆验收报告

本次 **fixture 通过，真实 Pi 失败**。真实 Pi 已调用并尝试记忆写入，但没有持久化成功，不能宣称已验证真实记忆复用或纠错。已用完允许的一次重试，停止真实调用；不以 fixture 代替 live。后续需要修正模型输出与来源字段合同的衔接，并在新授权下重跑；#973 的正式项目启用及主观质量抽验仍未执行。

## 来源与隔离

- 分支 `codex/pi-memory-phase1`，起始 HEAD `91a5ba25bbd5b8427e2663e6ce3264d1013c6a85`。原有 15 个 tracked 修改及 1 个 untracked 文件保留，不包含在本 Issue 的提交中。
- #966–#971 的 Run、Evidence、Handoff、Pi acceptance 已通过只读连接读回。均有 accept；#967 Run 本身仍为 needs_user，不能把 Issue acceptance 改写为 Run 成功。前序 Handoff 是 draft，并有历史 failed/blocked Evidence。
- 通过 Bun 直接加载当时工作区的新源码。两轮实际源码指纹、tracked diff 指纹和脏文件清单见 [机器报告](pi-memory-replay-972.json)。线上 `36053d7f` 不是本次新功能的执行来源；未重启服务、修改正式 DB 或项目开关。
- 每轮使用新 DB、运行目录及无 remote 的虚构 Git 项目。仅通过既有 SDK/资源加载器/鉴权入口读取 `runner-default / openai-codex / gpt-5.6-terra / high`。不复制凭据，鉴权适配器拒绝写入/刷新。
- `playground`、受保护 SSE 文件和既有 `fixtures/` 未修改。未发送消息、触发 Actions、push、tag、PR、发布、部署或调用宿主 Issue/Run 生命周期接口。

## 逐例结果

| 案例 | fixture | 真实 Pi |
| --- | --- | --- |
| 首次学习 | passed；真实本地 Node 失败/通过证据，经 Worker/Gate 保存 | failed；第 1 轮工具未启用，唯一重试因 source 字段不合法被拒绝 |
| 无记忆对照 | passed；新会话语义替身，当前规范边界矩阵正确 | not_run |
| 相似表达 | passed；有工具返回的精确选择/引用身份 | not_run；正确召回未知 |
| 不同业务规则反例 | passed；A `>=100` 改为 B `>200`，重读规范，199/200/201 均正确 | not_run；误用率未知 |
| 纠错 | passed；相同 memory id 修订增加，保留 narrow 原因及历史 | not_run |
| 重启去重 | passed；重开 DB 和重复验收，派发增量 0，revision/occurrence 不变 | not_run |
| 遗忘不复活 | passed；重开 DB、新 Evidence 指纹仍受抑制，派发增量 0 | not_run |
| 预算失败不阻塞 | passed；生产 guard 故障注入，两次尝试后停止，Work 仍 done | not_run |
| 权限边界 | passed；只授权搜索时，Gate 拒绝记忆写入 | not_run |

fixture 是控制策略，不是模型效果观察。重启/遗忘/权限是 Host 断言，预算是明确的故障注入。没有预填 live expected observation，也不以记忆条数或一次耗时推断总体效果。

## 真实调用、步骤与开销

首轮模型调用 1 次。适配器给 SDK 传了空的 active tool 名单，模型返回无可读证据并 skipped。已修正为精确工具名列表，并新增实际 SDK + faux transport 回归验证工具可见性。

唯一重试调用 4 次。实际工具顺序为：

1. `reflection_evidence_read`：返回虚构项目真实本地测试产生的可信摘要。
2. `memory_search`：返回空候选。
3. `memory_remember`：模型尝试保存有证据来源的门槛经验，但 `content.source.work_id` 写成 `work:xw:work:issues:1`，`source.run_id` 写成 `run:xw:run:issue_runs:replay-1`。这两处应是 canonical id，前缀只属于 refs。
4. Host 返回 `rejected: true, reason: "memory is outside reflection evidence authority"`，模型随后报告 skipped。没有 memory 行，不能视为成功写入。

此错误没有削弱 Gate，也没有为通过测试而规范化或预填模型输出。生产 Prompt、来源校验的行为保持不变。本 Issue 只抽取同一复盘会话执行函数供隔离驱动复用。实测后新增的预算账本与报告修正只经本地/faux 回归，没有第三轮真实调用。

| 口径 | 累计实测 |
| --- | ---: |
| 顶层 SDK/Provider 派发，含工具循环继续调用 | 5 / 20 |
| 失败重试 | 1 / 1 |
| 实验墙钟，含两轮之间修正/准备 | 185,381 ms / 1,800,000 ms |
| 两轮首次学习阶段耗时 | 4,110 ms + 15,842 ms |
| 输入 tokens（不含 cache read） | 6,058 |
| 输出 tokens | 638 |
| cache read / write tokens | 4,608 / 0 |
| reasoning tokens（输出中的单独回执字段，不再叠加） | 183 |
| SDK totalTokens | 11,304 |
| SDK 估算 cost USD | 0.0206936 |

所有 5 次都有用量回执；费用是 SDK 估算，不是账单。fixture 无真实 Provider 调用，不能据此称运行环境零成本。

## 命令与证据

```sh
bun scripts/replay-pi-memory.ts
bun scripts/replay-pi-memory.ts --live --pi-state-dir '/Users/xiaobei/Library/Application Support/xuanwu-bun-live/state'
bun scripts/replay-pi-memory.ts --live --pi-state-dir '/Users/xiaobei/Library/Application Support/xuanwu-bun-live/state' --retry-from '/var/folders/d5/p8s9_bt93jqgdgy9pd0_vg940000gn/T/xuanwu-memory-replay-BRfl24/report.json'
```

已执行的旧 live report 重试额度已消耗，不要再次使用。新的演练需新的授权。复用方法与限制见 [回放入口说明](../runbooks/pi-memory-replay.md)。

完整逐步数据和源码指纹保存在 [JSON 报告](pi-memory-replay-972.json)。本机原始副本位于 `.runner/artifacts/issue-972/{fixture,live_first,live_retry}/`，各文件 SHA-256 已写入 JSON；新 DB 与项目路径在对应 report 的 `root` 中。自动验证日志位于 `.runner/artifacts/issue-972/`。

## 自动验证

| 检查 | 实测结果 |
| --- | --- |
| `cd backend-ts && bun test --timeout 60000` | 2568 passed / 7 failed；全部 7 项都已在起始基线失败，新增 0 |
| `node --test scripts/*.test.mjs` | 28 passed / 4 failed；起始源码副本同为 28/4，均受 Runner deployment guard 阻止 |
| `npm --prefix frontend run lint && npm --prefix frontend run build` | exit 0 |
| `bun scripts/run-golden-journeys.ts` | 6/6 passed；最后变更后 GJ-06 再跑 passed |
| `node scripts/dependency-security-audit.mjs` | passed；保留基线已批准的 2 条 Qoder 上游残留，未变更依赖 |
| 新增 `bun scripts/replay-pi-memory.ts` | 9/9 fixture passed，0 次真实调用 |
| 记忆回放与复盘预算定向测试 | 9 passed / 0 failed，包括 SDK 工具可见性、伪造引用、错误业务值和虚假 saved 响应 |
| `bunx --no-install tsc --noEmit -p backend-ts/tsconfig.json` | 153 项诊断，与起始源码副本逐条一致；新增 0 |
| `git diff --check` / `git diff --cached --check` | passed；暂存范围已核对为本 Issue 的 9 个文件 |

前端未修改；Golden Journey 的相关前端用例由 Node runner 执行，Bun/SDK 回放用例由 Bun 执行，没有将 JSX/Bun 用例混交给 Node。

后端起始基线 `2561 passed / 8 failed`，日志 `backend-baseline.log`。固定旧失败包括 Persona prompt summary、prompt token snapshot、skill run 列表，以及数据库表集合和两处 migration count（旧期望 87，实际 89）。另有 CLI connector 超时与 timeline 性能门槛失败。脚本和类型基线使用 `git archive HEAD` 加起始脏文件的普通临时源码副本；不是 Git worktree，未切换或改写当前分支。完整日志与对照见本机 artifact 目录。

最终全量后端用时 1,024.18 秒；新增 6 个回放测试全部通过。7 项失败均已在基线出现，CLI connector 超时本次未复现；timeline 性能门槛仍未通过。没有为通过全库门禁修正范围外快照、schema 期望或性能阈值。

本地实现和报告可独立提交保存；这不表示满足真实记忆成功写入/复用的验收条件。
