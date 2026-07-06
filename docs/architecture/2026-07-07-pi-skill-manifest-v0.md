# PI Skill Manifest v0：Intake 与 Domain Skill 边界

> 状态：P04.01 最小规范。范围只覆盖 manifest 解析、registry 展示与 loader 诊断，不包含 skill 执行、run history、proposal 持久化或自动路由。

## 两类 skill

PI Assistant 的主动处理链路按对象边界拆成两类 skill：

```text
Context Bundle → Intake Skill → Attention Inbox Item → Domain Skill → Action Proposal
```

- **Intake skill**：输入对象固定为 `context_bundle`。职责是看懂一组上下文，输出 `inbox_items` 与 `ignored_groups`；它不决定怎么执行后续动作。
- **Domain skill**：输入对象固定为 `inbox_item`。职责是决定这个事项如何处理，输出 `action_proposals`；它不重新做 raw/context intake，也不直接执行外部写操作。

## Manifest 文件

一个 runtime skill 目录仍以 `SKILL.md` 作为可读元信息入口；同目录可选 `manifest.json` 声明 PI runtime 能力。

```json
{
  "manifest_version": "pi-skill.v0",
  "kind": "intake",
  "input_object": "context_bundle",
  "output_objects": ["inbox_items", "ignored_groups"],
  "required_tools": ["source.fetch_context"],
  "primary_intents": ["bug_report", "reply_needed", "other"],
  "intent_tags": ["llm-first", "multi-source"],
  "input_schema": { "type": "object" },
  "output_schema": { "type": "object" },
  "permissions": { "max_tool_permission": "read" }
}
```

### 字段约束

- `kind` 只允许 `intake` 或 `domain`。
- `intake` 必须声明 `input_object=context_bundle`，且 `output_objects` 包含 `inbox_items` 与 `ignored_groups`。
- `domain` 必须声明 `input_object=inbox_item`，且 `output_objects` 包含 `action_proposals`。
- `primary_intents` 使用固定主类型集合，并保留 `other`；扩展分类放入 `intent_tags`。
- `required_tools` 只声明依赖，不代表自动执行；执行仍需后续 permission / approval gate。
- `permissions.max_tool_permission` 用于和实际 tool registry 权限对齐，避免 skill 声明的权限低于所需工具权限。

## Loader 诊断

错误 manifest 不会阻止服务启动，也不会阻止同目录 `SKILL.md` 作为普通技能元信息加载；loader 会把 runtime manifest 相关问题放入 diagnostics：

- `manifest_invalid`：JSON、schema、kind/input/output contract 或权限字段错误。
- `missing_tool`：`required_tools` 中的工具没有出现在当前 Tool Registry snapshot。
- `permission_conflict`：required tool 的权限高于 manifest 声明的 `max_tool_permission`。

Fixture 示例位于 `docs/fixtures/pi-skills/fixture-intake` 与 `docs/fixtures/pi-skills/fixture-domain`。
