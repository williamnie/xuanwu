# PI Guardian 通知路由边界

本页固化 Guardian 告警的用户通知策略，避免把系统级告警误接回普通 digest pipeline。

## 三条通知路径

1. **普通 lifecycle/digest pipeline**
   - 用于 issue 生命周期、run group 摘要、recovery digest 等普通用户通知。
   - 主链路是 `pi_notification_intents -> digest/coordinator -> sync_outbox/Feishu draft`。
   - 当 digest/coordinator/outbox 本身不可用时，不允许再通过 digest pipeline 通知“digest 不可用”。

2. **Guardian direct Feishu fallback**
   - 用于 watchdog / Guardian 发现的系统级或需要用户介入的告警。
   - 先写 `pi_guardian_alerts(status=open, ui_visible=1)`，再 best-effort 直达飞书文本。
   - 不写 `pi_notification_intents`，不写 `im_reply_drafts`，不依赖 `sync_outbox`。

3. **UI-only fallback**
   - 当 direct Feishu 没有可用目标、飞书发送失败或超过重试上限时，保持 UI banner 可见。
   - UI 文案必须是中文、人能理解、可行动，不直接暴露内部 enum。

## Direct Feishu 目标优先级

Guardian direct fallback 的目标选择固定为：

```text
issue / conversation target
→ project-specific Feishu mapping
→ global/default Feishu target
→ UI-only fallback
```

具体含义：

- `issue` 告警优先回复该 issue 关联的飞书会话。
- 无 issue 时，run group / conversation 告警优先用 `origin_conversation_id`。
- 再退到 `feishuProjectMappings` 的项目专属 chat/user。
- 再退到 `feishuDefaultChatId` / `feishuDefaultUserId`。
- 仍无目标时，只保留 UI banner，并记录 `missing direct Feishu target`，不创建 digest intent。

## 展示规则

- `project_id=''` 或 `project_id='-'` 表示系统级，UI 显示 `系统级`，不要显示 `project -`。
- `missed_digest_pending` 显示为“飞书摘要通知暂时不可用”，并提示恢复后会自动补发。
- 系统级告警如果确实需要用户介入，走 direct Feishu fallback 到默认目标；不要让 digest pipeline 自己通知自己不可用。

## 回归测试锚点

- `backend-ts/src/integrations/feishuGuardianAlerts.test.ts`
  - default target fallback
  - project mapping override
  - issue target priority
  - run group / conversation target priority
  - missing target UI-only fallback
- `frontend/src/components/GuardianAlertBanner.test.js`
  - `missed_digest_pending` 中文可行动文案
  - `project_id=''` / `'-'` 显示为 `系统级`
  - 不暴露内部告警 enum
