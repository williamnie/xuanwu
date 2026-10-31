# TD-9：记忆页面与导入

- 状态：Draft
- 日期：2026-10-31
- 上游：ADR-XW-0098 第 3 节"记忆"一行（页面、分层展示、导入筛选迁自朱雀）；TD-4（存储与权威等级）；TD-3 第 8 节（受管记忆）
- 参考：朱雀 `src/memory-import.ts`、`web/src/pages/Memory.tsx`、`ImportMemory.tsx`

## 1. 目标与范围

1. 以朱雀的记忆页为准改造玄武的 `PiMemoryPanel`：按事实 / 情景 / 程序分层浏览，看得清每条记忆的权威等级和来源，能确认推断记忆、撤销放权规则、导出 Markdown。
2. 迁入朱雀的"导入记忆"：从本机 Codex、Claude Code 的记忆目录扫描候选，用户逐条筛选后入库。

存储真值仍是玄武的 `pi_memory_items`（authority / scope / revision），本文只做读写入口和导入。视觉按 `docs/design-system/` 实现（TD-5 统一说明）。

## 2. 现状（已核）

| 能力 | 玄武现状 |
| --- | --- |
| 页面 | `frontend/src/pages/PiMemoryPanel.jsx`：列表、启用 / 停用计数、手动补充、保存、Pin、启用 / 停用；状态行显示 layer、scope、出现次数 |
| 接口 | `http/pi/piMemoryApi.ts`：列表、创建、批量、编辑、删除、启用、停用、Pin、遗忘、历史；按类型批量操作（`typed-memory/*`、`lifecycle-memory/*`、`history-memory/*`）；审核队列相关接口已退役（410） |
| 导入 | 无 |
| 导出 | 无 |

## 3. 记忆页

### 3.1 结构

```
记忆
├─ 顶部：搜索框；筛选：层（事实 / 情景 / 程序）、权威（我说的 / 推断的 / 经验 / 旧记录）、
│        范围（全局 / 项目 / 人 / 会话）、状态（生效 / 已停用 / 已过期）；"待确认 N"快捷筛选
├─ 列表：每条一张卡片
└─ 侧栏 / 抽屉：选中记忆的详情与历史
```

### 3.2 卡片内容

| 元素 | 内容 |
| --- | --- |
| 正文 | 可内联编辑（受管记忆除外） |
| 层 | 由 kind 推导（TD-4 4.2） |
| 权威 | `user_explicit` → "我说的"；`evidence_backed` → "经验"；`source_inferred` → "推断"；`advisory` → "旧记录" |
| 来源 | `source_inferred`：来源插件 · 会话名 · 日期，点开跳到 Inbox 会话的对应消息；`evidence_backed`：issue / run 链接；导入的：原文件路径；受管记忆：放权规则 |
| 范围 | 全局 / 项目名 / 人 / 会话名 |
| 其他 | 出现次数、最近出现时间、到期时间（有的话） |

### 3.3 操作

| 记忆类型 | 可用操作 |
| --- | --- |
| `source_inferred` | 确认（可先编辑）、否决、停用、Pin |
| `user_explicit` / `evidence_backed` / `advisory` | 编辑、停用 / 启用、Pin、遗忘 |
| 受管记忆（`managed_by = autonomy_rule`） | 只有"撤销"（调用 TD-3 规则接口），不能编辑、停用、遗忘 |
| 任意 | 查看历史（现有接口） |

批量：在筛选结果上"全部确认"（仅推断记忆，二次确认）和"全部停用"。

### 3.4 导出

- `GET /api/pi/memory/export?format=markdown&include_disabled=false`
- 按层分节，每条一行：正文 + 括号里的权威与来源。受管记忆单独一节"放权规则"。
- 不导出已遗忘的记忆。

## 4. 导入

### 4.1 来源与解析

| 来源 | 位置 | 解析（沿用朱雀解析器） | 映射到 kind |
| --- | --- | --- | --- |
| Codex 总结 | `$CODEX_HOME/memories/memory_summary.md` | 按 `## User Profile`、`User preferences`、`General Tips` 等小节切条目 | 偏好 → `user_preference`；建议 → `workflow` |
| Codex 手册 | `$CODEX_HOME/memories/MEMORY.md` | 按 `# Task Group` 分块，取 `User preferences`、`Reusable knowledge`、`Failures and how to do differently`；`applies_to: cwd=` 用来定项目；`## Task n` 丢弃 | 偏好 → `user_preference`；知识 → `workflow`；教训 → `workflow` |
| Codex 回顾 | `$CODEX_HOME/memories/rollout_summaries/*.md` | 每个文件一条 | `episode` |
| Claude Code | `~/.claude/projects/*/memory/*.md` | 一个文件一条，读 frontmatter 的 `type`；`MEMORY.md` 索引不导；项目路径从目录名还原 | `user` → `user_preference`；`feedback` → `workflow`；`project` → `decision`；`reference` → `project_fact` |

Codex 的 skills 目录不在这里导入，走 TD-8 的技能导入。

### 4.2 候选与状态

```sql
create table if not exists pi_memory_import_candidates (
  id integer primary key autoincrement,
  origin text not null,          -- codex | claude_code
  file text not null,
  section text not null default '',
  content_hash text not null,
  content text not null,
  suggested_kind text not null,
  project_hint text not null default '',
  status text not null default 'new',   -- new | imported | ignored | blocked
  block_reason text not null default '',
  memory_id text not null default '',
  scanned_at text not null,
  unique(origin, file, section, content_hash)
);
```

- 每次打开导入页时重新扫描源文件（只读，不写回）。源文件更新后，新内容的哈希不同，作为新候选出现；页面菜单显示待筛选数量。
- 已忽略的同一内容（同哈希）不再出现。
- 像秘密的内容（复用朱雀 `looksSecret` 与 `redactSensitiveText` 的规则）标 `blocked`，不能导入；用户改掉源文件后重新扫描才会变成 `new`。

### 4.3 导入入库

用户逐条（或多选）点"收进来"，可以先改正文和 kind：

- authority：`user_explicit`（用户逐条确认过），`authorized_by` = 用户，`source_type = import:<origin>`，`citation_*` = 原文件。
- scope：`project_hint` 能匹配玄武项目的工作目录时为 `project`，否则 `global`。
- `memory_key`：`import.<origin>.<内容哈希前 12 位>`。
- 经 `reusableMemoryRejection` 校验：新增来源 `user_import`，要求 `userAuthorized = true`，kind 必须在现有 7 种 + `person_fact` / `project_fact` / `episode` 范围内。
- 不经筛选直接批量入库的入口**不提供**（朱雀铁律：不能让别的 agent 的指令绕过用户进库）。

### 4.4 部署限制

扫描读取的是运行玄武那台机器的用户目录（Mac mini）。远程访问时接口仍可用，但页面提示"读取的是服务器上的目录"。

## 5. 接口

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/api/pi/memory?category=&authority=&scope=&status=&q=` | 现有列表接口增加筛选参数与返回 `category` |
| POST | `/api/pi/memory/:id/confirm`、`/reject` | TD-4 |
| GET | `/api/pi/memory/export` | 导出 |
| POST | `/api/pi/memory/import/scan` | 扫描，返回候选 |
| GET | `/api/pi/memory/import/candidates?status=new` | 候选列表 |
| POST | `/api/pi/memory/import/candidates/:id/accept` | 收进来（可带编辑） |
| POST | `/api/pi/memory/import/candidates/:id/ignore` | 忽略 |

## 6. 实施步骤

| 步 | 内容 | 验收 | 依赖 |
| --- | --- | --- | --- |
| I1 | 列表筛选参数、`category`、导出 | 接口测试 | TD-4 M1 |
| I2 | 导入解析器（移植朱雀并补测试样本） | 每种格式的解析单测 | — |
| I3 | 候选表、扫描、忽略、秘密拦截 | 源更新后出现新候选；已忽略不再出现 | I2 |
| I4 | 收进来入库 | authority、scope、key 的测试 | I3、TD-4 M1 |
| I5 | 前端记忆页与导入页（TD-5） | — | I1、I4 |

## 7. 待决

- [ ] 是否也支持导入 Pi（`~/.pi/agent`）的记忆：朱雀没做，先不做。
- [ ] Claude Code `project` 类型映射为 `decision` 是否合适：它常是"项目当前在做什么"的状态，可能更适合 `project_fact`。导入时让用户可改。
