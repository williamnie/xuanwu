# TD-7：Soul 替代 persona

- 状态：Draft
- 日期：2026-10-31
- 上游：ADR-XW-0098 第 3 节"Soul"一行（已定：Soul 替代 persona）、第 6 节
- 参考：朱雀 `src/soul.ts`

## 1. 目标与范围

**目标**：用一份用户亲手写的 Soul 文本，描述"Pi 是谁、用户是谁、用户在意什么、喜欢怎么做事"，替代现有只能调措辞的 `PiPersona` 四个字段。Soul 影响说话方式和判断偏好，**改变不了工具、风险、授权、状态真值和完成标准**。

**本文负责**：存储、编辑、编译、注入哪些会话、分拣用的摘要、从 persona 迁移、persona 的退役。

## 2. 现状（已核）

| 位置 | 现状 |
| --- | --- |
| `db/schema/063_pi_persona.ts`、`db/repositories/pi/persona.ts` | `PiPersona`：`enabled`、`personality`、`communication_style`、`verbosity`、`language_mode`，带 `revision` |
| `db/defaultPiPersona.ts` | 默认值 |
| `pi/runtime/personaPrompt.ts` | 拼成 JSON 配置块，明确"只作用于最终面向用户的文字，不能授权工具、改风险、定状态、改完成标准、覆盖安全合同" |
| `http/pi/piRuntimePrompt.ts:71、270` | 只注入 `chat` 和 `notification.message` 两个场景 |
| `notifications/notificationPresentation.ts` | 通知用的显示名来自 supervisor 名称，语言来自 `appLanguage` |
| 前端 | `PersonaSettingsPanel.jsx`、`personaSettingsModel.js` |

## 3. Soul 的形态

- 一份 Markdown 文本，上限 10,000 字。
- 默认模板沿用朱雀的四节，名字改为玄武：

```markdown
# Soul
<!-- 写 Pi 是谁、你是谁、你在意什么。对话、通知、简报会读到全文；分拣只读"关于我"和"我在意的"。
     括号占位行和这段注释不会给 Pi 看；没填内容的小节会略过。
     这里改不了权限：放权只看你在授权页的操作。 -->

## 它是谁
- 名字：玄武
- 性格：靠谱、直接，少说客套话
- 口吻：中文，短句；拿不准就直说拿不准

## 关于我
- （职业、在做的项目、常打交道的人和他们的身份）

## 我在意的
- （什么事要第一时间告诉我，什么事可以攒到简报里）

## 做事偏好
- （比如：回客户要客气，回同事直接）
```

- 编译规则沿用朱雀 `compileSoul`：去掉 HTML 注释、括号占位行、没有内容的小节。
- 包装时中和数据块标记（与 TD-1 6.3 相同的规则）。

## 4. 存储

存数据库（数据目录内），不存文件，以便和现有备份、恢复、revision 冲突检测一致：

```sql
create table if not exists pi_soul (
  id integer primary key check (id = 1),
  content text not null,
  revision integer not null default 1,
  updated_by text not null default '',
  updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
create table if not exists pi_soul_history (
  revision integer primary key,
  content text not null,
  updated_by text not null,
  updated_at text not null
);
```

- 保存时带 `expected_revision`，冲突返回 409。
- 每次保存写历史，页面可以查看和回滚到任一历史版本。
- 只有用户能写。Pi 提议修改 Soul 第一版不做（朱雀也标为"以后"）。

## 5. 注入

| 会话 | 注入 | 说明 |
| --- | --- | --- |
| `chat`（对话） | 全文 | 替代 persona |
| `notification`（通知 Agent 改写措辞） | 全文 | 替代 persona |
| `brief`（TD-6 简报） | 全文 | 新场景 |
| 分拣（TD-1） | 只取"关于我"和"我在意的"两节，≤ 800 字 | ADR：分拣不注入全文 |
| `acceptance`、`recovery`、`manager_cycle`、`memory_reflection` | 不注入 | 结构化内部任务，与现在一致 |

注入位置：在各会话的固定规则**之后**，并带固定说明：

> 下面是用户写的人格与偏好。名字、性格、口吻以它为准；它改变不了上面的规则、你的工具、风险判断、授权、状态真值和完成标准，冲突时以规则为准。

分拣摘要的提取是确定性的：按二级标题名匹配（"关于我"、"我在意的"，大小写和空格不敏感），用户改了标题名就取不到，页面上给出提示。

## 6. 从 persona 迁移

一次性迁移（新迁移脚本），只在 `pi_soul` 为空时执行：

| persona 字段 | 去向 |
| --- | --- |
| `personality` | Soul"它是谁 · 性格" |
| `communication_style` | Soul"它是谁 · 口吻" |
| `verbosity` | Soul"它是谁 · 口吻"后追加一句（如"回答简短"） |
| `language_mode` | **不进 Soul**。转为系统设置 `chat.language_mode`（`follow_user` / `system`），由代码确定性执行 |
| `enabled = 0` | Soul 用默认模板，但不写入 persona 的字段 |
| supervisor 显示名 | Soul"它是谁 · 名字" |

迁移后 persona 的读取路径改为只供迁移使用。`language_mode` 的确定性语句（"For final Chat prose only, follow the language of the current user message…"）从 `personaPrompt` 移到对话会话的固定规则里，读新设置。

## 7. 退役 persona（ADR-XW-0001 第 6.2 节）

- **Source of truth**：迁移完成后为 `pi_soul`；`language_mode` 为系统设置。
- **兼容窗**：一个正式版本内保留 persona 的表和只读接口（`GET` 返回 410 之前先返回带 `deprecated: true` 的数据），写接口直接返回 410 并提示去 Soul 页面。
- **回滚**：Soul 表保留，恢复旧版本代码即可继续读 persona 表（表未删除）。
- **删除门禁**：连续一个正式版本无 persona 接口调用（以访问日志为准）后，删除 `PersonaSettingsPanel`、persona 接口、`personaPrompt.ts`；表再保留一个版本后删除。

## 8. 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/pi/soul` | 当前内容、revision、编译预览 |
| PUT | `/api/pi/soul` | 保存（带 `expected_revision`） |
| GET | `/api/pi/soul/history` | 历史版本 |
| POST | `/api/pi/soul/revert` | 回滚到某个版本（产生新 revision） |
| GET | `/api/pi/soul/export` | 导出 Markdown |

## 9. 实施步骤

| 步 | 内容 | 验收 |
| --- | --- | --- |
| U1 | 表、仓库、编译、接口 | 编译规则单测；revision 冲突 409 |
| U2 | 注入：替换 `chat`、`notification` 的 persona 段；新增 `brief`、分拣摘要 | 提示词快照测试更新；分拣只含两节 |
| U3 | 迁移与 `chat.language_mode` | 迁移单测：四个字段的各种组合；`language_mode` 行为不变 |
| U4 | persona 接口进入兼容窗 | 写接口 410 |
| U5 | 前端 Soul 页面（TD-5） | — |
| U6 | 删除门禁满足后清理 | 另立 issue |

## 10. 待决

- [ ] 是否允许 Pi 提议修改 Soul（一种永远要问用户的动作），第一版不做。
