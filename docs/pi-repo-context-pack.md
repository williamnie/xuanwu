# Supervisor repo_context_pack 契约

`repo_context_pack` 是 Supervisor 在只读 repo / issue / session / memory 上下文后生成的初步上下文包，用于写入 runner issue body、refinement comment 或 proposal rationale。它帮助 executor 快速定位线索，但不是执行约束。

> Supervisor repo_context_pack 是只读代码/上下文后的初步上下文，不是 executor 的强制指令；executor 需要复核运行态和代码后再实现、测试、提交。

## 字段

最小结构由 `backend-ts/src/pi/repoContextPack.ts` 导出：

- `intent`：用户原始意图或 Supervisor 归纳后的目标。
- `project`：`id/name/cwd`，用于说明 pack 归属项目。
- `evidence[]`：只读证据项，包含 `source_kind`、`path/issue_id/session_key/message_id`、`reason`、`excerpt/summary`、`confidence`。
- `relevant_files[]`：候选相关文件和符号，仅表示“Supervisor 认为值得 executor 复核”。
- `proposed_changes[]`：初步改动方向，不是强制方案。
- `acceptance_criteria[]`：用户可见验收点。
- `validation[]`：建议 executor 复核后的最小验证。
- `open_questions[]`：仍需确认的问题。
- `confidence`：`low|medium|high`，表示 Supervisor 对上下文完整性的置信度。
- `generated_at/source`：生成时间与入口来源，例如 Feishu IM message。

所有字符串在创建 pack 时会 trim；空数组默认保留为空；疑似 secret/token 行会脱敏。

工具调用中的 machine key 以英文 schema 为准：`intent`、`evidence`、`relevant_files`、`proposed_changes`、`acceptance_criteria`、`validation`、`open_questions`。为兼容既有 PI 会话，action layer 也会规范化 `需求理解`、`相关证据`、`相关文件`、`建议改动`、`验收标准`、`验证建议`、`未确认问题`；中英文字段重复的文本会稳定去重。未知字段会显式拒绝，不能再静默渲染成 `(none)`。

## 现有 Supervisor 工具边界

- `read` / `grep` / `find` / `ls`：Supervisor runtime 暴露的只读 SDK 工具，可读项目文件、搜索和列目录；不提供 `write` / `edit` / `bash`。
- `project_status`：读取 runner 项目快照，包括 issue/session/run 状态摘要、近期错误和 findings；不修改状态。
- `session_read_summary`：读取 runner 观察到的 session 进度摘要；不 steer session。
- `issue_create_proposal`：创建 `issue.create` proposal，默认写入 triage issue；是否真实创建受 action gate/policy 控制。context pack 应放进 `description` 或后续 refinement/comment 中。
- `issue_create_batch_proposal`：一次提交 2–40 个详细 triage Issue。每项必须有稳定本地 `ref`、证据、建议改动、验收标准和验证建议；`depends_on_refs` 形成的 DAG 会在 action gate 后原子映射成真实 Issue 依赖。工具只创建、不 enqueue，避免把整个依赖图盲目启动。

面对明确点名的 PRD/spec/design/roadmap，PI 必须先用 bounded excerpt 读取权威文档，目录列表不能代替正文。单一可独立交付目标使用 `issue_create_proposal`；跨合同、持久化、Provider、UI、可靠性或端到端旅程的大型目标，应按可独立实现、独立验收的结果拆分后使用 batch tool。若用户要求“先 review”，PI 只输出完整编号计划和依赖，不调用 mutation tool。

## Supervisor 审批边界

Action gate 默认不要求用户确认普通只读上下文收集。`repo_search` / `repo_read_excerpt` / `repo_tree`、`project_status`、`session_read_summary`、skills metadata，以及已安装 MCP registry / capability / read-only resource metadata 默认直接执行并写审计，不生成 pending approval。

需要确认或按 policy 拦截的是有真实副作用或高风险的动作：写文件、执行命令、创建/修改/入队 issue、发送 IM、外部写回、修改配置、steer/resume executor session、非只读 MCP tool call，或显式提升为 `requires_confirmation` / `risk_level` 非 low 的动作。项目/授权策略仍可通过 forbidden/allowlist/MCP capability allowlist 覆盖默认行为。

## 渲染格式

`renderRepoContextPack(pack)` 输出 Markdown，可直接附在 issue body/refinement/comment：

```md
## Supervisor repo_context_pack
> Supervisor repo_context_pack 是只读代码/上下文后的初步上下文，不是 executor 的强制指令；executor 需要复核运行态和代码后再实现、测试、提交。

- Intent: 帮我实现这个折叠面板功能
- Project: movo-web / MOVO Web
- Confidence: medium
- Generated at: 2026-06-12T00:00:00.000Z
- Source: im / feishu / feishu-msg-42

### Evidence
1. [message/high] message=feishu-msg-42 - user asked for an accordion-like interaction — 用户希望新增可展开/收起的面板。
2. [code/medium] path=`src/components/Accordion.tsx` - existing component likely owns the interaction — export function Accordion() { ... }

### Relevant files
1. `src/components/Accordion.tsx` - primary UI component (symbols: Accordion)

### Proposed changes
1. Add collapsed state and accessible toggle affordance.

### Acceptance criteria
1. Panel expands and collapses from the IM-described entry point.

### Suggested validation
1. bun test src/components/Accordion.test.tsx

### Open questions
1. 确认折叠默认态是否展开。
```

Executor 接收到 pack 后仍必须重新读取代码、确认运行态、选择最终方案并执行验证；不能把 Supervisor 的 `proposed_changes` 当成必须照做的指令。
