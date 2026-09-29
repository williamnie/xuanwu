# Issue #973：记忆质量抽验与启用建议

2026-09-29。由 Codex 在当前会话执行验收；真实语义步骤调用既有 Pi 身份，没有把 #973 加入 Runner 队列。结论：本轮发现的两个问题已修复并完成对应验证，建议暂缓正式项目启用，先完成发布整合。#973 保持 triage，不将本报告当作上线授权或 canonical Run。

## 版本与前序证据

- 分支 `codex/pi-memory-phase1`，起始 HEAD `419b33a7382979f82e7d1e931ae32b64b1a81af9`。执行来源是当前工作区源码，包含起始未提交修改，不能冒充该纯提交版本。
- 只读保存 #966–#972 的 Issue、Run、Work、Evidence 和 Handoff。#966–#971 为 done，但 Handoff 均为 draft，Git Evidence 标记工作区归属/完整性缺口，并保留历史失败命令。不能将其概括为全部证据通过。
- #967 的 Run 为 needs_user，Issue 是基于人工风险接受关闭；这不代表该 Run 自动成功。#972 当前有 ready Handoff 和 6 条 passed Evidence。
- 对应实现提交包括 `03c0fdb1`、`0ac18a5d`、`9cd5ab91`、`f07098d2`、`91a5ba25`、`bb9c79fd`。保留原报告中的失败历史。
- 起始 16 个未提交文件已保存副本、diff 和 SHA-256；收尾比较全部未变。本轮没有 commit、push、merge、部署、修改生产 DB 或启用正式项目。

## 发现与修复

1. **把预防建议写成已发生故障。** #972 保存的真实工具记录仅证明 campaign B 的 199/200/201 测试通过，记忆却写成 B 在 200 失败、误用 A 规则。先归档该失败证据，再补充生产复盘提示：症状、根因和失败尝试必须由同场景证据支持；只验证成功行为时明确没有观察到故障，不将旧场景故障移植到新场景。
2. **排除 B 时误排除 A。** 本轮真实 Pi 的修订明确“不适用于 campaign B”。原检索把单字母 B 丢掉，只按 campaign 排除，导致 A 也无法召回。新增失败回归后修复标识整体匹配；A/C 与 protocol 1/3 可召回，B 与 protocol 2 仍拒绝。未放宽项目、版本、来源、权限或遗忘检查。
3. 回放的重启检查改为使用固定的 A/B 业务规格比较重启前后身份，确认至少一个已验证场景可召回；不会从模型正文拼造匹配条件，也不会删除反例断言。

## 真实 Pi 与补验结果

命令：

```sh
bun scripts/replay-pi-memory.ts --live --pi-state-dir '/Users/xiaobei/Library/Application Support/xuanwu-bun-live/state'
```

复用 `runner-default / openai-codex / gpt-5.6-terra / high`，使用新隔离 DB 和无 remote 的虚构 Git 项目；鉴权只读。18 次真实派发、18 份用量回执，91,758 ms；input 28,494、output 3,139、cache read 13,824 tokens，SDK 估算 USD 0.0974208，不是账单。没有追加真实调用或重置预算。

| 案例 | 本轮证据与结果 |
|---|---|
| 首次学习 | 真实 Pi 保存 revision 1，来源绑定成功 |
| 无记忆对照 | 真实 Pi 读取规格并给出正确边界矩阵 |
| 相似任务 | 真实 Pi 搜索、选择并引用实际记忆 |
| 不同业务规则 | 真实 Pi 按 B 的严格 >200 判断，未套用 A 的 >=100 |
| 纠错 | 真实 Pi 对同一 key 修订到 revision 2；明确写出 B“未观察到失败”“未观察到根因” |
| 重启 | 原 live 命令在此 exit 1，记录 `corrected experience cannot be retrieved`；修复后在原真实 DB 的副本上补验，A 命中、B 排除，重启前后 id/revision/fingerprint 与 occurrence 不变，零模型派发 |
| 遗忘 | 原 live 后续未运行；副本补验删除后重开 DB，并加入新 Evidence，来源受抑制、零模型派发、不复活 |
| 用户偏好 | 副本中显式偏好作为首个 policy 项保留；相关权限/不可覆盖边界另有自动回归 |
| 预算、权限 | 原 live 后续未运行；本次自动回放的 Host/故障注入检查通过，不能记成额外真实模型观察 |

原 live report 保持 failed；补验写入独立文件，没有改写失败历史。修订后的语义内容是一条 A 场景经验及 B 排除说明；没有证明总体正确率、速度或收益，也未测试正式项目的长期效果。

## 自动验证

```sh
bun test backend-ts/src/xuanwu/memoryReplay.test.ts backend-ts/src/pi/memoryReflectionRuntime.test.ts backend-ts/src/agentic/memoryReflectionWorker.test.ts backend-ts/src/pi/memoryPolicy.test.ts backend-ts/src/pi/memoryContext.test.ts backend-ts/src/pi/memoryTools.test.ts backend-ts/src/pi/memoryExperience.test.ts --timeout 60000
bunx --no-install tsc --noEmit -p backend-ts/tsconfig.json
git diff --check
```

- 定向回归实际执行 6 个文件：58 passed / 0 failed，exit 0。重启排除回归先失败、修复后通过。命令中的 `memoryExperience.test.ts` 不存在，Bun 没有执行它，不将其计入覆盖。
- 类型检查基线和当前各 153 个相同诊断，按行号归一化新增 0；均 exit 1。基线为 HEAD 的普通临时源码副本加起始 16 个修改，不是额外 worktree。
- `git diff --check` 通过；未运行全库测试、CI、生产验收。

## 启用建议与剩余事项

建议先整合主线 `8bf4d07c`（SSE）及 `36053d7f`（恢复误判）并完成发布回归，再明确部署窗口，只在 `xuanwu-playground` 小范围启用。新问题的确定性检索修复已补验，但最终全部源码没有再跑一遍完整真实模型会话；正式项目及主观质量接受仍需明确决定。当前反思默认关闭，未批量启用。

## 本机证据

`.runner/artifacts/issues-973-980/20260929T031720Z/`：前序 API 快照、`evidence-review.json`、`quality-failure-before.json`、`live/`、`host-supplement.json`、失败/成功测试日志、`type-comparison.json`、`workspace-preservation.json`。补验脚本 `host-supplement.ts` 只操作归档真实 DB 的独立副本。
