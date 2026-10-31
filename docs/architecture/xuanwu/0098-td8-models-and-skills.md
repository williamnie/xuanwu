# TD-8：模型与登录；知识型与可执行技能并存

- 状态：Draft
- 日期：2026-10-31
- 上游：ADR-XW-0098 第 3 节"模型与登录""技能"两行、第 6 节（技能：两类并存已定）
- 参考：朱雀 `src/models.ts`、`src/skills.ts`；ADR-XW-0058（可执行 Skill Runtime）

本文合并两块，因为它们彼此独立、与 Inbox 主线也独立，体量都不大。

---

## A. 模型与登录

### A1. 目标

1. 网页上用 Pi SDK 各家 provider 的 OAuth（订阅）或 API Key 登录，不再只支持 OpenAI Codex 的 OAuth。
2. 可以从本机 Pi（`~/.pi/agent/auth.json`）一次性导入凭据，已有的不覆盖。
3. 按用途分模型：对话、分拣、记忆整理、简报、通知改写，各自可选，未设置时回落到对话模型。

### A2. 现状（已核）

| 能力 | 玄武现状 |
| --- | --- |
| 凭据存储 | `pi/runtime/piModelRuntime.ts` `piCredentialPaths`：`<数据目录>/pi-runtime/agent/auth.json` 与 `models.json`，玄武自己保管，不读用户的 `~/.pi/agent`（与朱雀相同） |
| API Key provider | `http/pi/piProviderSettingsApi*`：provider 目录（catalog / presets）、自定义 base URL、模型列表、测试连接、审计 |
| OAuth | 只有 `openai-codex`（`/api/pi/oauth/openai-codex/login|logout|status`） |
| 复用登录 | `credential_source = codex_login`：复用本机 Codex 登录 |
| 前端 | `PiProviderConnectionFlow.jsx`：API Key / OAuth / 复用 Codex 三个选项 |
| 按用途分模型 | `llmIntake.ts` 里有 `AssistantModelPolicy` 类型（`intake_model`、`memory_model` 等），**没有持久化**，调用方传参 |

### A3. 设计

**通用 OAuth 流程**：

- 新路由 `/api/pi/oauth/:provider/login|status|logout|respond`，`:provider` 必须在 Pi SDK 报告"支持 OAuth"的列表里。
- 流程沿用朱雀 `models.ts` 的做法：SDK 要展示链接或设备码时记入登录会话的事件；要用户输入（授权码、粘贴回调 URL）时挂起，等网页经 `respond` 提交。用户输入只经过内存交给 SDK，不进日志、不回显。
- 登录会话 10 分钟过期；同一 provider 同时只有一个进行中的登录。
- 旧的 `/api/pi/oauth/openai-codex/*` 保留为别名，转发到新路由（兼容窗一个正式版本，之后按 ADR-XW-0001 第 6.2 节删除）。
- `codex_login` 复用方式保留不变。

**从本机 Pi 导入**：

- `POST /api/pi/credentials/import-local-pi`：读 `~/.pi/agent/auth.json`（只读），逐个 provider 复制到玄武的 `auth.json`；玄武已有的 provider 不覆盖；返回导入了哪些、跳过了哪些。
- 只在本机部署（Mac mini）上可用；远程访问时返回 403。
- 记审计，不记凭据内容。

**按用途分模型**：

- 新设置 `pi.model_policy`：

```jsonc
{
  "chat": { "provider": "anthropic", "model": "…" },  // 必填，其余回落到它
  "triage": null,
  "memory": null,
  "brief": null,
  "notification": null
}
```

- 读取函数 `resolveModelFor(purpose)`；TD-1 分拣、TD-4 记忆整理、TD-6 简报与通知改写都经它取模型。
- 换模型只改玄武的设置，不写回任何 Pi 配置文件。

### A4. 步骤

| 步 | 内容 | 验收 |
| --- | --- | --- |
| L1 | `pi.model_policy` 与 `resolveModelFor` | 回落规则单测 |
| L2 | 通用 OAuth 路由与登录会话；旧路由别名 | 用 SDK 的假 provider 跑通链接、设备码、输入三种交互 |
| L3 | 本机 Pi 导入 | 不覆盖已有；远程 403 |
| L4 | 前端"模型与登录"页（TD-5） | — |

---

## B. 技能：知识型与可执行两类并存

### B1. 目标

1. 技能库里明确区分两类：**知识型**（只是一份说明书，Pi 只能读）和**可执行**（ADR-0058 的 runtime，带 handler 与 capability 门禁）。分开命名、分开展示。
2. 迁入朱雀的知识型技能导入：从本机 Claude Code、Codex、Pi 的 skills 目录选择导入，只拷文字。
3. 不把技能列表全量塞进提示词：对话只注入当前相关的少数几个，分拣不注入。

### B2. 现状（已核 / 待核）

| 能力 | 玄武现状 |
| --- | --- |
| 技能库 | `skills/managedStore.ts`：`<数据目录>/skill-library`，来源 `local` / `git` / `inline`，带 revision 与 digest，范围 `instance` / `project`，可启停 [已核] |
| 可执行 | `skills/runtime*`、`runtimeManifest.ts`：有 runtime manifest 的技能走 0058 的 handler 与 capability gateway [已核] |
| 读取 | `pi/tools/skillLibraryTools.ts`：`skill_list`、`skill_read`（经 `readLibrarySkillResource`，按库内路径读）[已核] |
| 注入 | `skills/promptContext.ts` `buildSkillPromptContext`：按请求的 intent 与授权来源选出注入的技能摘要并记审计 [已核]。对话会话在没有 intent 时是否注入全部已启用技能的摘要 [待核] |
| 导入 | 无从本机 agent 目录导入的流程 |

现状里，没有 runtime manifest 的技能实际上已经是"知识型"，只是没有在模型和界面上区分。

### B3. 设计

**分类**：

- 不加存储字段，由是否存在 runtime manifest 推导：`kind = executable | knowledge`，列表接口返回该字段。
- 页面分两个区块：知识型（朱雀的技能页交互）、可执行（现有 `SkillsRuntimePanel`）。
- 知识型技能被 `skill_read` 读取时，只能读技能目录内的文字文件；路径越出目录、非文字文件一律拒绝。

**导入（知识型）**：

- 扫描来源（只读）：`~/.claude/skills`、`~/.codex/skills`、`~/.pi/agent/skills`，以及项目目录下的 `.claude/skills`（按项目范围导入）。
- 列出候选：名称、描述（取 `SKILL.md` 头部）、来源、文件数，已导入的标"已导入"，源有更新的标"有更新"。
- 用户逐个选择导入；导入时只复制 `.md`、`.txt`、`.yaml`、`.yml`、`.json`，单文件 ≤ 256KB，整个技能 ≤ 2MB；脚本、二进制、隐藏文件全部丢弃，丢弃清单展示给用户。
- 复制前做秘密扫描（复用 `redactSensitiveText` 的规则），命中的文件拦下，用户改掉源文件后才能导入。
- 导入后作为 `inline` 来源的托管技能（带 digest），范围默认 `instance`。
- 带 runtime manifest 的源技能**不能**经这个流程导入成可执行技能；导入时去掉 manifest，作为知识型导入，并提示"可执行版本需按 0058 的流程安装"。

**注入**：

- 对话：最多注入 5 个技能摘要（名称 + 一句描述），按 intent 与触发规则选择；其余靠 `skill_list` 工具按需查。若 B2 的待核项确认现在会全量注入，改为这个上限。
- 分拣：不注入任何技能（ADR 2.5 第 4 条）。
- 简报、通知改写：不注入。

**长期**：两类是否合并成一类，等阶段 A 用过之后再定（ADR 第 6 节）。

### B4. 步骤

| 步 | 内容 | 验收 |
| --- | --- | --- |
| K1 | 分类字段与 `skill_read` 的知识型读取限制 | 越界路径、非文字文件被拒的测试 |
| K2 | 核实注入行为并加上限 | 提示词快照测试 |
| K3 | 导入扫描、候选、复制、秘密拦截 | 脚本被丢弃、秘密被拦的测试 |
| K4 | 前端技能页分区与导入（TD-5） | — |

## 待决

- [ ] 对话注入上限 5 是否合适。
- [ ] 导入是否也支持 git 来源的知识型技能（现有库已支持 git 来源，可能不需要另做）。
