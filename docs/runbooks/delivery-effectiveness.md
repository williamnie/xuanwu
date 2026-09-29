# 按项目查看交付效果与记忆开销（#979）

复用 `deliveryEffectiveness`，数据来自现有 Issue / Work、Run / Attempt、Handoff / Evidence、审批 / 通知 / 恢复与记忆审计。不新增统计表、生命周期写入、模型调用或外部发送。默认 observability 快照继续使用既有缓存与隔离 reader；筛选页使用只读 `GET /api/system/delivery-effectiveness`，沿用 HTTP Bearer 认证。

## 查询与比较

合同 `xw.delivery-effectiveness.v2`：

| 参数 | 边界 |
| --- | --- |
| `project_id` | 可选精确项目；不存在返回 404 |
| `task_type` | 可选既有 `engineering_task` / `objective`；类型来自 `works.type`，没有 Work 行时沿用 Issue adapter 的 `engineering_task` 合同，不按标题猜测类型 |
| `from` / `to` | UTC ISO 毫秒字符串；默认近 30 天，范围有序且不超过 90 天，包含边界 |
| `limit` | 1–100，API 默认 100，页面使用 25 |
| `before_issue_id` | 正整数游标；取返回的 `next_before_issue_id` |

未知、重复、空值和非法参数返回 400。每页按 Issue id 降序扫描最多 500 个候选；日期按终态任务最新 Run 的结束时间筛选。`aggregation_scope=page`：总览、项目/类型分组与 UTC 日趋势均仅统计返回的 `samples`，不是整个范围的全集。翻页必须固定首次返回的 `since/until` 和过滤条件；`has_more=true` 的空页仍需继续。只有遍历全部页后才能比较完整范围。排序不是结束时间排序。

每个样本保留 canonical Work / Run、Handoff / Evidence 和 `audit_refs`，分组包含 `work_ids`。历史审计仍可通过既有 Work / Run / Evidence / Handoff API 和 #971 的 memory-diagnostics 分页查看。范围选择任务队列，事实读取当前持久化状态，包含这些任务后续的验收与复盘；不承诺历史时点快照或跨页事务快照。

## 事实口径

- 交付：任务 done；最新 Handoff ready/delivered，关联最新 Run；Evidence 全部 passed 且属于同一 Work；必需交付操作成功。缺失、无效或超预算证据不能成为通过证明。
- 求助：审批请求或 `requires_user` 通知的记录。`no_help_record_works` 只计可确认无求助记录的样本，读取受限另记 unknown；`unattended_works=null`，不推断无人干预。审批不一定由人工处理。
- 等待：Run 间非负时间间隔与有完整时间的审批记录分别汇总。未解决审批不计零；重叠、不完整或截断 Run 时间为未知。审批记录可能互相重叠或与 Run 间隔重叠，不能直接相加为总等待。`total_wait_ms=null`，没有节省时长估算。
- 重复执行与恢复：Run 次数、已结束恢复尝试、无进展次数分开。被截断的恢复数量为 null，并显示覆盖限制。
- 执行金额：每个任务所有 Run / Attempt 均有合法金额才为已知。缺失、无效、截断或同任务币种冲突均为未知；已报告的零保留为零，币种不换算或合并。兼容字段 `cost` 保持完成任务的平均成本；`execution_cost` 汇总全部结束任务（包括失败/取消）的确认金额，页面分组展示该小计及已知任务数。
- 记忆：注入表示 Provider 输入已构造，引用表示执行器自报；`evidence_supported_reuse=null`。记录数为零只说明没有读到相应审计，不证明未触发。单次成功不能证明记忆的因果收益。
- Supervisor：逐步覆盖已持久化 `issue.memory_reflection_attempt.v1` 的耗时、token 和 SDK 美元估算。`known_cost_usd` 是已知小计，`partial_attempts` 表示部分回执，已知数量以 `cost_known_attempts / recorded_attempts` 展示。无金额回执为 null，不外推；本地召回耗时和注入字符 token 估算单列，既不是模型账单也不是节省。Supervisor 其他调用及总成本仍未知，不与执行金额合并。

## 预算与隔离

每个来源最多 64 条记录，每个任务最多 64 个 Run、累计 64 个 Attempt；JSON 在 SQL 层超过 16,384 字节时不读取正文。事件查询只按 `(issue_id,type)` 索引读取白名单类型，不扫描 Provider 转录或 `issue.log`。样本 `limited_sources` 明示记录截断、超长/损坏内容；覆盖率不隐藏缺失。

每页时间预算 200ms，在候选任务之间检查，单个任务读取有界但不能中途打断，因此此数不是硬实时 SLA。HTTP 每约 4ms 在候选间让出事件循环，同一数据库只允许一个统计请求执行，重叠请求返回 429。现有 SSE 文件与保护逻辑不变。

## 本地验证

```sh
bun test backend-ts/src/observability backend-ts/src/http/deliveryEffectivenessApi.test.ts backend-ts/src/http/readApiContract.test.ts backend-ts/src/http/piMemoryApi.test.ts backend-ts/src/domain/handoff/firstDelivery.test.ts backend-ts/src/domain/handoff/acceptedDelivery.test.ts
node --test frontend/src/pages/command-center/*test.js
cd frontend && npm run lint && npm run build
cd ../backend-ts && bunx --no-install tsc --noEmit
```

定向回归先记录旧实现缺少筛选/样本/覆盖字段的 3 个失败用例，再验证相同用例与相邻路径。TypeScript 全仓当前和保留已有修改的起始基线均有 153 条相同诊断（归一化行号后无新增），本 Issue 文件无新增类型错误；不把该旧失败说成全仓检查通过。

UI 使用临时数据库与仅绑定 loopback 的独立 fixture API / Vite 服务验证浅色/深色和 1280、980、760、680、375px，检查页面不横向溢出、表格独立滚动、筛选重置、分页和空结果。真实页面、主观视觉验收、真实 GitHub 接管保存与 IM 发送均交 #980。本轮不 push、发布、部署或修改生产 DB / 配置。

本次自动验证：后端 67 项、前端相关 25 项通过；隔离页面 2 个主题 × 5 个宽度通过，30 个总样本及项目过滤后的 15 个样本逐页无重复或遗漏，筛选重置与空结果通过，最终页面无 JavaScript 异常。
