# ADR-XW-0095：Supervisor 通知表达层与自然语言边界

- 状态：Accepted
- 日期：2026-09-04
- 关联：`backend-ts/src/notifications/notificationPresentation.ts`、`agentCommunicationGateway.ts`

## 问题

Supervisor Chat 已有可编辑 Persona，但自动通知使用严格的 `notification` Prompt Profile，明确禁止 Chat Persona。通知模型只能读取模板化 `content_seed` 并返回 `send/suppress/message/rationale`，因此即使配置了自然表达风格，最终消息仍容易重复“Provider、诊断、摘要、下一步”或在普通完成通知里机械追问用户。

部分 IM 消息还会绕过通知模型：订阅强制发送兜底、通知模型失败兜底、Guardian 告警、Release 更新，以及 Feishu/Telegram bridge 的即时确定性回复。它们必须继续可用，不能为了语气统一而依赖 LLM。

## 决策

### 1. 决策与表达分离

`notification` 继续使用内部结构化 Prompt，不继承 Chat 历史、Memory、工具或完整 Persona。新增经过认证和 JSON 转义的通知表达数据，只包含：

- Supervisor 显示名；
- `communication_style`；
- `verbosity`；
- 明确的 `zh-CN` / `en-US` 输出语言。

这些字段只允许约束 JSON `message` 的措辞，不得影响 `decision`、`rationale`、Schema、事实、权限、Action Gate、发送目标或发送时机。

### 2. 只有真正需要用户时才提问

只有 `requires_user=1` 或待审批通知可以提出一个直接问题和简短选项。普通 done、watch、digest、progress 通知只报告结论、验证边界和已知下一步，不得把系统自己的例行核查变成“要不要我继续”的用户决策。

非 actionable 消息出现疑问句时追加 `notification.presentation.non_actionable_question` 审计事件，但首期不拦截发送，避免误伤包含引用证据的合法文本。

### 3. 事实优先于语气

自然表达不得隐藏失败、缺少验证、待人工处理或未知状态。“任务已结束，但这次通知里没有可核对的验证结果”是允许的；暗示“已经验证通过”或删除该边界是不允许的。

### 4. 确定性旁路继续确定性

订阅、fallback、Guardian、Release 和 IM bridge 即时回复继续使用确定性模板，但统一使用 Supervisor 显示名、明确语言和自然短句。不把这些安全兜底改为强依赖 LLM。

### 5. 语言权威

通知默认使用 `app.language`。Chat Runtime 可接收显式 turn language；启用 Persona `follow_user` 时，可从当前用户消息在 `zh-CN` / `en-US` 中确定本轮语言。语言覆盖只改变自然语言输出，不改变 Schema key、enum、日志或逐字证据。

### 6. 默认 Instructions 去重

核心角色、权限和完成合同继续由 System Prompt 提供。默认 `pi_agents.instructions` 只保留“先回答重点、说人话、减少无关流程播报”的表达偏好。迁移仅替换完全匹配的旧内置默认值，不覆盖用户自定义文本。

## 验证

- notification presentation 经过 JSON 转义，且仅进入 `message` 表达合同；
- actionable 与 non-actionable Prompt 分支均有测试；
- 非必要提问生成审计事件但不改变发送结果；
- live Persona 名称能够替换 IM 模板中的旧 `玄武 Supervisor` 前缀；
- notification、Guardian、Release、Feishu、Telegram 确定性路径保留无 LLM fallback；
- 旧默认 Instructions 迁移幂等并保留用户自定义值；
- `app.language` 与 Chat turn language override 有独立回归。

## 回滚

回滚表达层只恢复旧模板和通知 Prompt，不需要回写 Issue、Run、Approval、Intent 或 Outbox 状态。已经发送的历史消息保持原样。迁移后的自然默认 Instructions 可通过 Supervisor 设置显式修改；用户自定义 Instructions 从未被迁移覆盖。
