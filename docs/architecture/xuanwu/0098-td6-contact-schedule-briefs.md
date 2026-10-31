# TD-6：联系我、用户作息、值守与早晚报

- 状态：Draft
- 日期：2026-10-31
- 上游：ADR-XW-0098 第 2.3、2.6 节；TD-0 第 1 节 D3、D4，第 5.4、5.5 节；TD-3 第 5.1 节第 4 行
- 参考：朱雀 `src/contact.ts`、`src/schedule.ts`、`src/brief.ts`

## 1. 目标与范围

**目标**：

1. **联系我**：玄武有一个固定的、用户指定的渠道主动找用户：汇总等用户决定的事、转达 Pi 要用户拍板的话、发简报；用户在这个渠道里能用一句话批准或驳回，也能直接跟 Pi 说话。
2. **用户作息**：上班 / 下班是用户级的设置，切换整个 Inbox 与通知的行为。
3. **值守**：下班后照常收消息、分拣，但不打扰用户（紧急除外），攒到早报。
4. **早晚报**：引擎取事实、Pi 只负责写成几段话；没有模型时直接发事实清单。

**不在本文**：通知管线本身（沿用 `unifiedNotificationPipeline`）；项目生命周期通知的路由（不变）；提醒到期触达（沿用 `reminder.create` → automation，本文只规定它在值守时的行为）。

## 2. 现状（已核）

| 能力 | 玄武现状 | 差距 |
| --- | --- | --- |
| 用户在 IM 里跟 Pi 说话 | 飞书机器人、Telegram 是原生 channel（对话入口），`feishuAgentBridge` / `telegramAgentBridge` 把用户消息交给 Pi 会话 | 已有，复用 |
| IM 里审批 | 飞书卡片按钮（`feishuPiActionCards`）、Telegram 回调按钮（`telegramCallbackCodec`），经 `imApprovalResolve` 校验回调令牌 | 没有文本指令（"批准 12"）；按钮在钉钉等渠道不可用 |
| 主动发消息 | 一切外发都是 notification intent → `routeNotification` → 通知 Agent（LLM 决定发不发、改写措辞）→ outbox | 没有固定的"联系我"目标：目标靠 issue / 会话 / 项目的外部链接反推，找不到时退回渠道的 `defaultChatId` |
| 汇总 | intent 的 `aggregate` 决策 + `flush_after_at`；`digestFlushScheduler` | 机制可复用 |
| 作息 | `project_pi_policies.working_hours_json` / `quiet_hours_json`，按项目 | 没有用户级作息 |
| 日报 | `notifications/dailyDigest.ts`（按项目汇总通知，默认 09:00）；`guardianOperationsDailyReport.ts`（运维日报） | 没有面向用户的、含 Inbox 的简报 |
| 每日外发上限 | 未找到 | 需要新增（仅联系我渠道） |
| Pi 主动找你 | 只有 issue 级的 `piNeedsUserAction` 升级 | 没有通用的"找你"动作 |

## 3. 联系我

### 3.1 渠道

联系我渠道由用户在设置里指定一个，两种形态：

| 形态 | 例子 | 往外 | 往里（用户的话） |
| --- | --- | --- | --- |
| **A. 原生 channel**（推荐） | 飞书机器人单聊、Telegram | 走现有 channel 投递 | 已经是对话入口：文本交给 Pi，按钮走现有回调，**新增文本指令**（3.4） |
| **B. 来源插件的一个指定会话** | 钉钉里一个只有用户本人的群 | 经插件 `send` | 只认该会话里 `is_self=true` 的消息为指令；其他会话里用户说的话一律不算 |

形态 B 让一个来源插件的某个会话变成对话入口，与 ADR 2.3"对话入口与 Inbox 分离"有张力。约束：

- 必须由用户在设置里显式指定该会话（`contact.plugin_chat_key`），且该会话的 Inbox 档位强制为 `excluded`（不入 Inbox，不分拣）。
- 只接受 `is_self=true` 且宿主校验过本人 ID 的消息；对方（如果有）的消息丢弃。
- 外发消息带前缀 `【玄武】`，并用 `send` 回执的 `provider_message_ref` 标记回声，回声不当指令。
- 这条路径的指令能力与形态 A 完全相同，不多不少。

选哪种由用户决定（第 10 节待决）。两种都实现，形态 A 先做。

### 3.2 发什么

| 类型 | 触发 | 内容 | 值守时 |
| --- | --- | --- | --- |
| 待决汇总 | 有新的待用户决定的动作（含 Inbox 提案、回复草稿）后防抖 30 秒 | 编号列表 + 指令提示 | 攒着，进早报 |
| Pi 找你 | Pi 调用新工具 `notify_user`（3.3） | Pi 的原话 | 非紧急攒着；紧急照发 |
| 早报 / 晚报 | 第 5 节 | 简报正文 | 早报本身就是值守结束的出口 |
| 提醒到期 | `reminder.create` 的 automation | 提醒内容 | 照发（用户自己设的时间） |
| 现有生命周期通知 | 不变 | 不变 | 按现有项目静默时段 |

### 3.3 `notify_user` 工具

- 对话会话、分拣之外的 Pi 会话（如 supervisor）可用；**分拣不可用**（分拣只产生结论，不直接找人）。
- 参数：`text`（≤ 1000 字）、`urgent`（布尔）、`related`（可选：issue id、action id）。
- 生成一个 notification intent，`kind = pi_user_notice`，`requires_user = 1`，路由固定到联系我渠道。
- 不需要授权（与朱雀一致：找用户本身不是外部写操作）；受每日上限约束。
- `urgent` 由 Pi 判断，但同一会话每天最多 3 次紧急，超出降为非紧急。

### 3.4 文本指令

只在联系我渠道、只对已认证的用户本人生效：

```
批准 12 | 同意 12 | 通过 12 | 可以 12 | ok 12
驳回 12 | 拒绝 12 | 不行 12 | 不要 12
批准 12 以后自动 | 批准 12 以后同类自动
```

- 解析沿用朱雀 `parseCommand` 的正则，**整条消息必须完全匹配**，否则当普通对话交给 Pi。
- 编号是短号，不是动作 id：新表 `pi_contact_refs` 把短号映射到动作，短号 7 天有效，过期或已处理时回复"#12 已失效 / 已处理"。
- "以后自动"走 TD-3 的 `approve_always`，范围默认会话级；动作类型被锁定为"问"（如 `message.reply_send`）时回复"这类动作暂不支持自动"，只做本次批准。
- 指令执行结果用一句话回执（"已批准 #12：……"）。
- 每条指令记审计，`actor = contact:<渠道>`。

### 3.5 外发规则

- 待决汇总、简报、Pi 找你这三类**不经过通知 Agent 改写**：内容里的编号和指令格式必须原样送达。实现上给 intent 加 `delivery_mode = verbatim`，`agentCommunicationGateway` 对这类 intent 直接放行（等同现有的"显式订阅投递不能被压掉"，再加"不改写"）。
- 每日上限：联系我渠道每天 100 条（按用户时区自然日），超出后攒到下一份简报，并在第 100 条时附一句"今天先不发了"。
- 内容经 `redactSensitiveText`。

## 4. 用户作息与值守

### 4.1 设置

```jsonc
{
  "timezone": "Asia/Shanghai",
  "workdays": [1, 2, 3, 4, 5],
  "work_start": "09:00",
  "work_end": "19:00",
  "morning_brief": "08:45",      // null 表示不发
  "evening_brief": "19:15",
  "off_duty": {
    "hold_notices": true,         // 下班攒着，紧急除外
    "hold_pending_digest": true
  }
}
```

存设置表（`pi_settings` 或现有用户级设置，实现时以现有存储为准），在设置页编辑。

### 4.2 与项目静默时段的关系

- 用户作息只作用于**联系我渠道**的投递。
- 项目生命周期通知仍按项目的 `quiet_hours_json`；若这些通知也被路由到联系我渠道，两者取并集（任一处于安静时段就聚合）。
- 实现：`quietResumeAt` 增加用户作息作为一个来源，返回两者中更晚的恢复时间。

### 4.3 值守时的行为

| 行为 | 上班 | 下班（值守） |
| --- | --- | --- |
| 插件收消息、分拣 | 照常 | 照常 |
| 待决汇总 | 发 | 攒着（intent 决策为 `aggregate`，`flush_after_at` = 下一个上班开始时间） |
| Pi 找你 | 发 | 非紧急攒着，紧急照发 |
| 自动执行（TD-3 已放开的类别） | 照常 | 照常；TD-3 判定第 4 行的"下班改为问"列表第一版为空（代回复本来就锁定为问） |
| 提醒到期 | 发 | 发 |
| 卡住的工程任务巡查 | 现有 guardian / supervisor | 不变，不新增巡查 |

下班转上班时：如果当天早报已经发出，攒着的内容视为已告知，不再补发；否则发一条"下班期间攒下的"汇总。

## 5. 早晚报

### 5.1 事实

由新模块 `pi/briefs/briefFacts.ts` 从数据库确定性地取，时间窗为上一份简报到现在（首份为过去 24 小时）：

| 块 | 来源 |
| --- | --- |
| 等你决定 | 待处理的 `pi_actions`（含 Inbox 提案），带短号 |
| Pi 找过你 | 攒着的 `pi_user_notice` intent |
| 自动做了 | TD-3 放行的动作（`decision_reason = rule_auto`） |
| 没做成 | 失败的动作、结果未知的发送 |
| Inbox | 新消息数、各结论数量、今天到期的待办与提醒、失败的会话 |
| 工程 | 完成的 issue、卡住的 issue（复用 `reportIssueSummary`、guardian 的数据） |
| 健康 | 不健康的插件、断档 |
| 记忆 | 待确认的推断记忆数（TD-4） |

### 5.2 生成

- Pi 写正文：独立的无工具会话，`promptProfile = brief`，输入是事实清单（包在数据块里，外部来的标题和内容中和标签），要求几段人话、适合手机阅读、不编造事实清单里没有的内容。
- 没有模型或生成失败：直接发事实清单（`formatFacts`）。
- 存 `pi_briefs`：`kind`（morning / evening / manual）、事实 JSON、正文、生成方式（model / facts_only）、投递结果。
- 仪表盘展示最近一份，可手动生成（`manual`，不改变"已告知"状态以外的任何东西）。

### 5.3 排期

- 只在工作日发；到点后 3 小时内没发出就不补发（关机一夜后不应收到昨晚的晚报）。
- 调度复用现有 cron 层（`schedule/cronSchedule.ts`），每分钟检查一次。
- 早报发出后：攒着的 Pi 找你和待决事项标为已告知。

### 5.4 与现有日报的关系

- `dailyDigest`（项目通知日报）和 guardian 运维日报继续存在。
- 设置项 `briefs.replace_daily_digest`（默认开）：简报启用时，项目通知日报不再发到联系我渠道，避免一早收到两份。
- 合并或删除现有日报另立 issue，按 ADR-XW-0001 第 6.2 节处理。

## 6. 数据模型

```sql
create table if not exists pi_contact_refs (
  short_no integer not null,
  action_id text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at text not null,
  primary key (short_no)
);

create table if not exists pi_briefs (
  id integer primary key autoincrement,
  kind text not null,              -- morning | evening | manual
  window_start text not null,
  window_end text not null,
  facts_json text not null,
  body text not null,
  generated_by text not null,      -- model | facts_only
  delivery_status text not null default '',
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

短号循环使用 1~999，分配时跳过 7 天内仍有效的号。

`pi_notification_intents` 新增：`kind = pi_user_notice`、`pending_digest`、`brief`；payload 新增 `delivery_mode`、`urgent`。不加列。

## 7. 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET/PUT | `/api/pi/contact/settings` | 联系我渠道、每日上限 |
| POST | `/api/pi/contact/test` | 发一条测试消息 |
| GET/PUT | `/api/pi/schedule` | 用户作息 |
| GET | `/api/pi/briefs` | 简报列表 |
| POST | `/api/pi/briefs` | 手动生成 |

## 8. 安全不变量

1. 文本指令只在联系我渠道、只对已认证的用户本人生效；其他会话里的同样文字只是数据。
2. 形态 B 的指定会话不进 Inbox。
3. 回声不当指令。
4. 简报的事实由引擎取，Pi 不能调用工具，不能声称事实清单之外的事。
5. `notify_user` 不能被分拣调用，因此第三方消息不能直接触发"找你"。

## 9. 实施步骤

| 步 | 内容 | 验收 | 依赖 |
| --- | --- | --- | --- |
| C1 | 用户作息设置与 `quietResumeAt` 扩展 | 作息边界的单测（跨午夜、非工作日） | — |
| C2 | 联系我设置（形态 A）、`delivery_mode=verbatim`、每日上限 | 汇总原样送达；超限进简报 | C1 |
| C3 | 待决汇总与短号、文本指令 | 指令解析与失效分支的测试；"以后自动"接 TD-3 | C2、TD-3 A3 |
| C4 | `notify_user` 工具 | 分拣不可用的测试；紧急降级 | C2 |
| C5 | 早晚报：事实、生成、无模型降级、排期、仪表盘 | 3 小时不补发；无模型时发事实清单 | C1、TD-1 S5 |
| C6 | 形态 B（钉钉指定会话） | 只认本人消息；回声过滤；该会话不进 Inbox | C3、TD-2 P4 |

## 10. 待决

- [x] **联系我用哪个渠道**（2026-10-31 定）：用玄武已配置的飞书机器人或 Telegram（形态 A），在设置里选其一。形态 B（钉钉指定会话）第一版不做，C6 推后。
- [ ] 作息默认值沿用朱雀（周一到周五 9:00–19:00，早报 8:45，晚报 19:15）是否合适。
- [ ] 每日 100 条上限、紧急每天 3 次的默认值。
