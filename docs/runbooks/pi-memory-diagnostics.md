# 记忆诊断与额外开销（#971）

只读入口：`GET /api/projects/:id/pi/memory-diagnostics`，合同 `xw.memory-diagnostics.v1`。沿用 HTTP Bearer 认证，不新增权限、模型调用、任务状态表或页面。所有事实来自现有 `pi_memory_reflections`、`issue_events` 和 memory Action 审计；不扫描 Provider 转录。正式启用、真实模型效果及最终体验验收仍属于 #973。

## 查询

| 参数 | 含义与边界 |
| --- | --- |
| `source` | `reflections`（默认）、`events`、`actions`；各自独立分页 |
| `issue_id` | 可选的精确 Issue；`events` 必填，避免项目全历史事件查询 |
| `run_id` | 可选的原始 `issue_runs.id`（不带 `xw:run:issue_runs:`）；必须同时传 `issue_id` |
| `from`、`to` | UTC ISO 时间，例如 `2026-09-28T00:00:00.000Z`；包含边界，最大 31 天，默认最近 7 天 |
| `limit` | 默认 50，范围 1–100；不静默截断非法上限 |
| `after` | 默认 0；使用返回的 `next_after` 继续，按本来源持久化 id/rowid 升序 |

例如 `/api/projects/demo/pi/memory-diagnostics?source=events&issue_id=42&run_id=run-42&limit=20`。翻页时固定首次返回的 `range.from/to`、来源、项目及 Issue/Run 过滤；`has_more=false` 时 `next_after=null`。范围按记录创建时间筛选，复盘行的 status 是请求当前事实，不承诺历史时点状态快照。时间比较兼容仓库已有的秒和毫秒精度。

未知/重复参数、无效枚举、上限、时间范围或缺失依赖返回 400；项目不存在、Issue 不属于项目、Run 不属于 Issue 返回 404；未通过 HTTP 认证返回 401。不存在诊断记录返回 200 和空页，表示未知，不证明从未触发。查询无持久化副作用。

每页至多读取 `limit+1` 条相关元数据；单条 JSON 最大 65,536 字节、每项至多 24 个 memory 引用、文本字段至多 256 字符。超长和损坏 JSON 分别标为 `unknown_oversized`、`unknown_invalid`，不回退扫描转录。输出白名单排除记忆正文、Evidence 摘录、搜索词、Prompt、原始错误、工具输入、租约 token 和凭据；自由文本来源仍经过脱敏。

## 事实边界

- `reflections`：触发请求的持久化 id、Work/Run、创建/更新时间、排队/运行/完成/失败/跳过、尝试次数及写入 memory id。精确 revision 和创建/更新/幂等结果在对应 Action 中；不以当前记忆修订冒充历史写入版本。
- `events`：`reflection_trigger` 保存验收事件引用与排队/跳过原因；`reflection_attempt` 保存每次尝试及额外开销；`retrieval_snapshot` 保存召回身份和排除/预算信息；`injection` 仅证明 Provider 输入已构造；`executor_reference` 仅为通过身份校验的执行器自报引用。
- `actions`：只投影 `memory.search`、`memory.remember` 的现有审计阶段，保留 gate 的 execute/ask/deny 和 `/api/pi/actions/:id/events` 引用。写入结果区分 `created`、`updated`、`unchanged`、`rejected`；老记录没有这些数据则为 unknown。复盘通过精确内部会话关联原始 Run，包括旧版未保存 issue_id 的两次尝试。没有可证明 Run 绑定的普通聊天 Action 不会出现在指定 Run 的结果中。
- 手工编辑/停用/遗忘的既有版本历史继续使用 `/api/pi/memory/:id/history`；诊断不复制这套生命周期数据。写入、搜索、注入、引用均不增加“成功采纳”次数。
- `evidence_supported_reuse.status=unknown`：目前没有因果归因 Evidence，不能把执行成功、历史验证、写入、注入或引用推断为复用有效。

`no_memory_in_window` 表示有界窗口内没有记录；`no_matching_candidate` 配合 `excluded` 区分不合格、版本不匹配、条件不匹配和文本无关；`pi_selected_none` 表示 Pi 没选技术经验。窗口之外的候选未知，`scan_limited` 会显示限制。`token_budget_exhausted`、`retrieval_budget_disabled` 和 item/candidate/technical/selection 排除数量单独显示。旧快照没有新增字段时保留 null/unknown，不重跑当前召回来改写历史。

复盘区分无可信 Evidence、摘要不完整、来源停用/遗忘、Pi 报告无新经验、调用失败、超时、租约失效、崩溃重试耗尽，以及输入字节、输出、模型调用、模型 token、工具调用/输入预算耗尽。Pi 自由文本跳过理由归为 `pi_reported_no_experience`，不输出其原文。旧版 input/call 合并预算错误保留合并分类。

## 成本与开关

`elapsed_ms` 是实际测得的 Host 墙钟耗时（复盘尝试或本地召回/写入），不把排队时长冒充模型时长。模型输入字节累计重复上下文；`model_calls` 只计通过预算检查后发起的调用。输入/输出/cache token 及 `cost_usd` 取 SDK 用量回执，美元值是 SDK 报告的估算，不是账单。`completeness=partial` 表示有发起调用没有结束回执；仅保留已知部分，不外推总额。未获得任何回执时 token/价格为 null，不当作零。旧数据或自定义执行器未提供用量时为 unknown。

召回条目和完整注入段的 `token_estimate` 是字符估算，注入段另有 `prompt_bytes`；这些不是执行器账单。搜索/写入 Action 的耗时范围仅为本地记忆操作，外层 Pi 会话的模型成本未知。并发或尾部失败可能导致复盘写入已完成而尝试事件记录失败，分别保留这两个事实。

`automatic_reflection.enabled` 只表示当前开关，不追溯断言历史配置。关闭会停止新复盘并撤销 pending/running 写权限，保留已有记忆和检索能力；重新启用只覆盖后续验收，不回填旧任务、不复活已跳过请求。新触发的关闭/启用窗口外跳过可在 trigger 中查看；升级前没有记录的触发保持未知。任何记忆都不授予额外执行权限。

## 本地验证

```sh
bun test backend-ts/src/http/piMemoryApi.test.ts backend-ts/src/http/readApiContract.test.ts backend-ts/src/xuanwu/capabilityDispositionInventory.test.ts
bun test backend-ts/src/pi/memoryReflectionRuntime.test.ts backend-ts/src/agentic/memoryReflectionWorker.test.ts backend-ts/src/pi/memoryContext.test.ts backend-ts/src/pi/memoryTools.test.ts backend-ts/src/pi/runMemoryContext.test.ts
git diff --check
```

使用临时数据库和本地 faux Provider 验证，不调用真实模型或修改正式项目配置。
