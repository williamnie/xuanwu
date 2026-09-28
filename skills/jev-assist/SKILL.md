---
name: jev-assist
description: Use when a short issue report or message would benefit from an optional second opinion on intent, information completeness, or message type. Requires the available jev_classify_report tool; continue normally without it when unavailable.
---

# Jev 辅助判断

仅在结构化分类有助于当前任务时，按需调用 `jev_classify_report`。已有充分上下文、简单回复、审批、验收或复杂规划不需要先调用此技能。

- 输入为当前任务相关的短报告：`title`、`body`，可选 `latest_message`。只传需要分类的片段，不发送完整历史、代码、日志或凭据。
- 工具只判断报告意图、信息完整性、消息类型；分类不证明 Bug，也不代表用户授权。
- `observed` 且 `reason=advisory` 时，可结合原始内容参考 `advice`；仍由当前 Agent 决定下一步。
- `shadow_only` 只表示完成观察，不提供决策建议。不要根据它改变流程。
- 工具缺失、关闭、未授权、超时、返回 `unavailable` 或低置信度时，使用已有原始上下文继续任务；不要反复重试、要求用户必须配置 Jev，或把辅助失败升级为任务失败。
- 权限、审批、Evidence 和 Handoff 继续通过玄武既有流程；不得用分类结果跳过检查。

技能配置位于玄武「Skills → Jev」；Key 由宿主在实际调用时注入，不读取用户凭据文件或通过 shell 自行请求服务。
