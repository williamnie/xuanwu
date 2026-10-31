# TD-3：Inbox 授权与逐步放权

- 状态：Draft
- 日期：2026-10-31
- 上游：ADR-XW-0098 第 2.5 节；TD-0 第 1 节 D6、第 5.3 节、第 6 节；TD-1 第 7.3 节
- 下游：TD-4（放权规则在记忆页的呈现）、TD-5（授权页面）、TD-6（值守模式对授权的影响）

## 1. 目标与范围

**目标**：Inbox 来源产生的每个动作，由一张**只能由用户写入的放权规则表**决定是问用户、自动执行还是禁止；用户批过几次后可以把同类放开，做错了能一键收回；放开的规则在记忆页里看得到、撤得掉。

**本文负责**：动作类别的定义、规则表、判定顺序、规则的写入途径、兜底（敏感、额度、总开关）、在记忆页的呈现、与现有 Action Gate 和来源授权的关系。

**第一版范围**：

| 动作 | 第一版可否放开 | 说明 |
| --- | --- | --- |
| `reminder.create` | 可以 | 只影响用户自己 |
| `issue.create`（triage 状态） | 可以 | 只建 triage，不入队 |
| `message.reply_send` | **不可以，固定为问用户** | TD-0 D6：先用影子评测积累证据 |
| `issue.enqueue` | 不适用 | 分拣不产生这个动作 |
| 日历写入 | 不可以，固定为问用户 | ADR 2.6 |
| `memory.create`（Inbox 推断） | 不走规则表 | 按 TD-4 的写入上限直接写，authority 为推断，不参与授权 |
| 个人待办 | 不走规则表 | 不是外部动作，直接进 Attention |

## 2. 现状（已核）

| 位置 | 现状 | 对本文的影响 |
| --- | --- | --- |
| `pi/actions/actionGate.ts`、`actionEngine.ts` | 风险分级 `safe / confirm / high`，待批动作经 `resolvePiActionDecision` 处理：`approve`、`approve_always`、`reject`、`request_changes`、`snooze` | 复用，作为最终闸门 |
| `http/pi/piActionDecision.approveAlwaysMcpAction.ts` | `approve_always` 只支持 `mcp.tool.call`：按能力指纹和项目范围持久授权 | **先例**：本文把它推广到 Inbox 动作类别 |
| `pi/actions/sourcePermissionPolicy.ts` `decideSourcePermission` | 只管 `message.reply_send`、`issue.create`、`issue.enqueue`、`issue.schedule_enqueue`；其他动作低风险就可以自动执行 | 其他动作（如 `reminder.create`）从外部来源来也会自动执行，与第 1 节冲突 |
| `http/pi/piActionProposalExecution.ts` `sourcePermission` | 来源策略、回复策略、`auto_reply_enabled` **从动作 payload 里读** | 现在不出问题，因为生成提案的 `pi-domain-proposal` 是确定性代码，不写这些字段。TD-1 的分拣由模型参与，必须保证授权不来自 payload |
| `http/pi/piSourcePoliciesApi.ts` | 只读接口，返回来源类型的默认值和"项目是否托管"；没有可配置的存储 | ADR 2.5 说"现有来源授权已经满足要求，不改"不准确：allowlist 没有地方配置 |
| `eventRouter.PROFILE_DEFAULTS` | `personal_chat`、`private_dm` 默认 `auto_low_risk` | TD-1 已定：Inbox 来源强制 `draft_only` |

## 3. 动作类别

### 3.1 定义

```
类别 = 动作类型 + 来源 + 范围 + 起因
```

| 维度 | 取值 |
| --- | --- |
| 动作类型 | 第 1 节表里可放开的动作 |
| 来源 | 插件 id（`dingtalk`、`gmail`……） |
| 范围 | `chat:<inbox_chat_id>`（某个会话）/ `person:<person_key>`（某个人，跨会话）/ `source`（整个来源） |
| 起因 | 第一版只有 `external`（Inbox 消息引起的）。用户在对话里交代的事走现有路径，不进这张表 |

例：`reminder.create @ dingtalk / chat:42 / external` 表示"钉钉某个会话里的消息引起的建提醒"。

### 3.2 一个动作匹配哪些规则

一个 Inbox 动作有确定的来源、会话、发送方，因此最多匹配三条规则：会话级、人级、来源级。

## 4. 规则表

```sql
create table if not exists pi_autonomy_rules (
  id integer primary key autoincrement,
  action_type text not null,
  source text not null,
  scope_kind text not null,          -- chat | person | source
  scope_key text not null,           -- inbox_chat_id / person_key / ''
  origin text not null default 'external',
  mode text not null default 'ask',  -- ask | auto | deny
  label text not null default '',    -- 给人看的对象名
  streak integer not null default 0, -- 连续批准次数，驳回或标记做错清零
  approved_count integer not null default 0,
  rejected_count integer not null default 0,
  auto_runs integer not null default 0,
  suggested_at text not null default '',   -- 最近一次提示"以后自动"的时间
  memory_item_id text not null default '', -- 在记忆页的呈现（第 8 节）
  updated_by text not null default '',     -- 必须是用户；见第 6 节
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  unique(action_type, source, scope_kind, scope_key, origin)
);
```

`mode='ask'` 的行用来累计计数；第一次遇到某类别时自动建一行 `ask`。计数更新属于系统行为，不改变 `mode`。

## 5. 判定

新模块 `pi/actions/inboxAutonomy.ts`，函数 `decideInboxAutonomy(action, context)`，在 Inbox 来源的提案执行时调用（替代 `sourcePermission` 对这类提案的判定）。

### 5.1 顺序

从上到下，命中即停：

| # | 条件 | 结果 | 原因码 |
| --- | --- | --- | --- |
| 1 | 总开关关闭 | ask | `autonomy_disabled` |
| 2 | 动作类型不在可放开列表（`message.reply_send`、日历写入等） | ask | `action_locked_to_ask` |
| 3 | 风险为 high，或内容命中敏感词（钱、密码、验证码、删除、强推……，沿用朱雀 `SENSITIVE` 正则并补充） | ask | `sensitive_or_high_risk` |
| 4 | 值守模式（下班）且动作在"下班改为问"的列表里（TD-6） | ask | `off_duty` |
| 5 | 今日自动执行数已达上限（默认 30） | ask | `daily_cap_reached` |
| 6 | 任一匹配规则为 `deny` | deny | `rule_deny` |
| 7 | 最具体的、有显式 `mode` 的规则为 `auto`（会话 > 人 > 来源） | auto | `rule_auto` |
| 8 | 其余 | ask | `rule_ask` |

`deny` 在任何一级都生效。放开只看最具体的一级，这样可以"整个来源放开、某个会话收回"。

### 5.2 与 Action Gate 的关系

`decideInboxAutonomy` 的结果作为 `riskOverride.requiresConfirmation` 传给 `createPendingPiAction`，Action Gate 照常分级。**两者取更严格的**：Gate 判为需要确认或高风险时，即使规则放开也要问用户。

### 5.3 授权不来自 payload

- Inbox 来源的提案（`pi_action_proposals` 上标 `origin=inbox`），执行时**忽略** payload 里的 `source_policy`、`reply_policy`、`issue_policy`、`auto_reply_enabled`、`project_confirmed`。
- `triageApply`（TD-1 7.3）按白名单字段构造 payload，模型输出的其他字段不进 payload。
- 测试：构造一个 payload 带 `auto_reply_enabled: true` 的 Inbox 提案，必须仍然问用户。
- 其他来源也存在"授权从 payload 读"的结构风险，另立 issue 处理，不在本文范围。

## 6. 规则的写入途径

**只有用户的操作能改 `mode`**。所有写入记审计，`updated_by` 必须是已认证的用户。

| 途径 | 效果 |
| --- | --- |
| 审批时点"批准，以后同类自动" | 本次批准；按用户选择的范围（默认会话级）写 `auto`。扩展 `resolvePiActionDecision` 的 `approve_always`：动作带 `origin=inbox` 时走本文的逻辑，MCP 的逻辑不变 |
| 连续批准达到阈值后的提示 | `streak ≥ 5`（可配）时在 Attention 里提示一次"以后同类自动？"，同一规则 7 天内不重复提示。用户点了才写 `auto`。**不提供"够次数自动放开"的设置**（朱雀有，第一版不做） |
| 授权页面或记忆页上手动改 | 可以改成 ask / auto / deny |
| 驳回一次 | `streak` 清零；`auto` 改回 `ask` |
| 对自动执行的动作标"做错了" | `streak` 清零；`auto` 改回 `ask`；记原因 |
| "全部改回问我" | 所有 `auto` 改为 `ask`，计数保留 |

Pi、分拣、记忆写入、插件都**不能**写这张表。代码上，写 `mode` 的仓库函数只从 HTTP 用户操作的处理器调用，加一个测试扫描调用方。

## 7. 计数

- 每次用户批准一个 Inbox 动作：匹配的会话级规则 `streak+1`、`approved_count+1`（只累计到会话级，避免一次批准同时推高三级）。
- 驳回：会话级 `streak=0`、`rejected_count+1`；若人级或来源级为 `auto`，也改回 `ask`（因为是它们放行的那一类出错）。
- 自动执行：放行它的那条规则 `auto_runs+1`。
- `message.reply_send` 也计数，但不提示放开（第 1 节）；它的数据和 TD-1 10.4 的影子评测一起展示，供以后决策。

## 8. 在记忆页的呈现（D6）

用户希望在记忆系统里看到并管理放权。做法：规则表是真值，记忆只是它的一个视图。

- 某条规则变成 `auto` 或 `deny` 时，写一条记忆：authority `user_explicit`，kind `procedure`，scope 为全局，正文由模板生成，例如"钉钉里『张三（单聊）』引起的建提醒，可以直接建，不用问我"。记忆的 `source_ref` 指向规则 id，规则的 `memory_item_id` 指回记忆。
- 规则回到 `ask` 时，对应记忆标为停用（不删，保留历史）。
- 在记忆页对这类记忆点"撤销"，调用规则接口把 `mode` 改回 `ask`，再由规则同步记忆。**方向是单向的：规则 → 记忆；记忆页只是发起修改的入口。**
- 这类记忆带只读标记：Pi 的记忆工具不能修改或停用它，记忆整理（反思队列）不能合并它。
- 分拣时，"本会话已放开哪些动作"**直接从规则表读**并放进上下文（TD-1 6.1），不经过记忆检索，避免检索漏掉或被同名记忆干扰。

TD-4 需要在记忆模型上支持：外部引用（`source_ref`）、只读标记、停用状态。

## 9. 兜底

| 兜底 | 默认 | 位置 |
| --- | --- | --- |
| 总开关 | 开（但第一版可放开的动作很少） | 设置 `inbox.autonomy.enabled` |
| 每日自动上限 | 30 次，按用户时区自然日 | 设置 |
| 敏感词 | 沿用朱雀正则，加上"合同、报价、发票、离职、薪资" | `inboxAutonomy.ts` |
| 锁定为问的动作 | `message.reply_send`、日历写入、`issue.enqueue` | 常量，改动需要修改代码和本文 |

## 10. 审计

全部写 `pi_action_events`：

- 每次判定：类别、命中的规则 id、结果、原因码。
- 规则的每次变更：前后 `mode`、途径（第 6 节）、操作者。
- 放开提示的展示与用户的回应。

## 11. 接口（供 TD-5）

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/pi/autonomy/rules` | 规则列表，带计数、最近一次自动执行 |
| PATCH | `/api/pi/autonomy/rules/:id` | 改 `mode` |
| POST | `/api/pi/autonomy/reset` | 全部改回问我 |
| POST | `/api/pi/actions/:id/flag` | 标"做错了" |
| POST | `/api/pi/actions/:id/decision` | 现有接口，`approve_always` 扩展支持 Inbox，带 `scope_kind` |
| GET/PUT | `/api/pi/autonomy/settings` | 总开关、每日上限、提示阈值 |

## 12. 实施步骤

| 步 | 内容 | 验收 | 依赖 |
| --- | --- | --- | --- |
| A1 | 规则表、`decideInboxAutonomy`、判定顺序单测 | 第 5.1 节每一行有测试 | TD-1 S5 |
| A2 | 提案执行接入：Inbox 提案忽略 payload 授权字段 | 5.3 的测试通过 | A1 |
| A3 | `approve_always` 扩展、驳回 / 做错回退、计数 | 第 6、7 节的测试 | A1 |
| A4 | 放开提示进 Attention | 阈值、7 天不重复 | A3 |
| A5 | 规则 → 记忆同步与撤销 | 第 8 节的测试；Pi 的记忆工具改不了这类记忆 | A3、TD-4 |
| A6 | 接口 | 接口测试 | A3 |

## 13. 待决

- [ ] 提示阈值默认 5 是否合适：上线后按实际审批频次调整。
- [ ] `message.reply_send` 何时可以放开、需要哪些附加保护（延迟发送与撤回窗口），等影子评测有数据后另写设计。
- [ ] 其他来源"授权从 payload 读"的结构风险，另立 issue。
