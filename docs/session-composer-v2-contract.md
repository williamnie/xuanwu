# Session Composer v2 契约

> Issue #89：`@` 必须表示 attach context，`/` 必须表示 invoke workflow/command。只插入纯文本 snippet 不再算作 Composer 能力完成。

## 现状与根因

当前 #69 已上线的 `/` 与 `@` 是轻量输入增强，但运行态仍只有 plain prompt：

- `frontend/src/components/editor/promptEditorSuggestions.js` 的 `insertPromptSuggestion()` 只把 `item.insertText` 插入编辑器文本。
- `frontend/src/pages/sessions/sessionComposerAssist.js` 只生成 `insertText`：`/issue`、`/status` 是 prompt 模板，`@project`、`@issue` 是可读文本。
- `frontend/src/pages/Sessions.jsx` 新建 session 与发送消息只提交 `prompt` 字符串。
- `backend/internal/api/sessions.go` 的 `createSessionRequest` / `sessionMessageRequest` 只接收 `prompt` 和 runtime options。
- `backend/internal/runner/sessions.go` 继续把 `prompt` 交给 `buildTurnInput()`；`backend/internal/runner/attachments.go` 只把 markdown 文本与 `attachment://` 图片转成 provider input。

因此 #69 的旧行为应被定义为 v1 文本辅助，而不是 v2 能力。v2 之后，任一入口若没有结构化对象、命令执行或可验证状态变化，只能标注为“插入文本模板”，不得宣传为 reference / command。

## 语义边界

### `@` = attach context

`@` 选择的是一个真实对象，并在发送时进入结构化 `references`。它可以同时保留一段用户可读的 markdown 文本用于 transcript，但系统行为不得依赖模型从文本里猜对象。

### `/` = invoke workflow / command

`/` 选择的是一个工作流命令，并在发送时进入结构化 `command`。命令必须触发表单、状态查询、后端动作或运行流之一；如果只是把 prompt 模板塞进输入框，必须叫“模板”，不能叫“命令”。

### 底部项目选择器关系

底部 project 选择器仍是默认执行环境，决定新 session 的 `project_id` / `cwd` / runtime defaults。

`@project` 默认只附加 context reference，不切换执行环境。任何切换执行项目的行为必须显式确认，并在 payload 中用独立字段表达，例如 `execution_project_id` 或确认后的 `project_id`，不能由 `@project` 暗中改变。

## 发送 payload 契约

新建 session 与发送 session message 共用同一 Composer payload shape。第一阶段可以把 `references` / `command` 作为可选字段加到现有 API；旧客户端只发 `prompt` 仍可工作。

```json
{
  "prompt": "用户自然语言内容，允许包含可读引用文本",
  "references": [
    {
      "type": "issue",
      "id": "89",
      "label": "Composer v2 契约：@=上下文引用，/=工作流命令",
      "source": "composer",
      "required": true,
      "metadata": { "project_id": "codex-issue-runner" }
    }
  ],
  "command": {
    "type": "status",
    "target": { "type": "issue", "id": "89" },
    "args": {},
    "requires_confirmation": false
  }
}
```

协作规则：

1. `prompt` 是用户给模型看的自然语言，不是对象解析的 source of truth。
2. `references[]` 是系统已解析并校验过的对象列表；后端必须按 `type + id/path/name` 重新读取当前对象。
3. `command` 至多一个，代表本次发送触发的主工作流；需要多个动作时先由 UI 展开表单或拆成多步。
4. command 可以消费 references，例如 `/status @issue 89`；若缺少必需 target，UI 应阻止发送并提示补齐。
5. 后端执行 command 时必须返回可验证结果：状态数据、创建的 issue id、入队结果、确认请求或明确错误。
6. provider turn input 由后端根据 `prompt + resolved references + command result` 组装；不得要求模型自行从 `@project:foo` 这类文本恢复系统状态。

## Reference 类型

| 类型 | 解析来源 | 第一阶段行为 | 需要确认 | 错误显示 |
| --- | --- | --- | --- | --- |
| `file` | 当前执行项目 workspace 内路径 | 附加文件内容或摘要，进入 `references` | 读取大文件、二进制、多文件展开、越过 workspace 边界 | “文件不存在 / 不在当前项目 / 文件过大 / 无权限读取” |
| `folder` | 当前执行项目 workspace 内目录 | 附加目录树摘要，必要时用户再选择文件 | 大目录、递归读取、包含大量文件 | “目录不存在 / 文件过多，请缩小范围” |
| `issue` | Runner issue store | 附加 issue 标题、状态、描述、最近 run 摘要 | 执行 `/run` 或跨项目 issue 影响当前执行环境时 | “Issue 不存在 / 无法读取 / 所属项目不可用” |
| `project` | Runner project store | 只作为上下文说明项目配置、cwd、provider 能力 | 切换执行项目或读取该项目大量文件时 | “Project 不存在 / provider 不支持 Sessions / cwd 不可用” |
| `skill` | 已安装 Codex skill registry | 附加 skill 名称、说明、入口路径或使用约束 | skill 会读取文件、调用工具或改变执行策略时 | “Skill 未安装 / 不适用于当前 provider / 入口不可读” |
| `plugin` | 已安装插件/connector registry | 附加插件能力说明与可用状态 | 安装、启用、授权、远程连接或访问账户数据时 | “Plugin 未安装 / 未授权 / 当前环境不可用” |

Reference MVP 不要求一次实现全部类型，但 UI 文案必须区分：已接入结构化引用的叫“引用”，未接入的只能叫“文本模板/提示”。

## Command 类型

| 类型 | 第一阶段语义 | 输入要求 | 系统行为 | 可验证结果 |
| --- | --- | --- | --- | --- |
| `status` | 查询当前 session、linked issue、runner 或指定 issue/project 状态 | 可选 target；无 target 时用当前 session 上下文 | 调用后端状态 API，不启动模型也能返回状态卡片；需要总结时再发 prompt | 返回状态、最近 run、错误摘要、时间戳 |
| `run` | 运行或重试 issue / workflow | 必须有 issue 或 workflow target | 显示确认，确认后调用 enqueue/retry/start API | 返回 run id / issue status / queued 状态 |
| `issue` | 创建或更新 runner issue | 表单化 title/body/project/status；可从 prompt 预填 | 调用 issue create/update API，而不是只让模型写模板 | 返回 issue id、链接、状态 |
| `skill` | 使用某个 skill 辅助当前 turn | 必须选择已安装 skill | 附加 skill reference，并在 turn instructions 中声明使用约束 | transcript 中可看到 skill context 已加入；缺失时报错 |
| `plugin` | 使用某个插件/connector 能力 | 必须选择可用 plugin，必要时授权 | 检查可用性；需要安装/授权时进入确认/授权状态 | 返回 plugin 状态、授权要求或执行结果 |

第一阶段不复刻完整 Codex App slash protocol；仅实现上表中与 Runner/Sessions 现有能力直接相连的最小动作。

## Confirmation 规则

以下行为必须确认，不能由文本输入隐式触发：

- `/run #id`、重试 issue、取消/中断运行、启动 project loop 等会改变状态或启动长任务的动作。
- `@project` 后切换执行项目、改变 `cwd`、改变 provider/runtime defaults。
- 读取大量文件、递归目录、跨 workspace 路径、二进制或敏感路径。
- 安装/启用 plugin、连接外部账户、访问 connector 数据。
- 使用 skill/plugin 导致工具调用、文件修改、网络访问或权限升级。

确认弹窗必须展示：动作、target、执行项目、权限影响、可撤销性。用户取消后不得修改状态，只保留输入草稿。

## 错误与缺失状态

Composer v2 错误应在发送前优先拦截；发送后错误由后端返回结构化错误并在 composer 附近展示。

- 对象不存在：标记对应 chip 为 invalid，并给出“重新选择/移除引用”。
- 权限不足或 provider 不支持：禁用发送或 command 按钮，显示具体能力缺口。
- target 不完整：例如 `/run` 没有 issue，提示选择 issue，不允许降级成普通 prompt 悄悄发送。
- command 执行失败：保留用户输入与结构化 payload，展示可重试动作。
- 后端重新校验失败：以后端为准，不信任前端缓存对象。

## #69 迁移策略

#69 原始目标是“轻量 `/` 与 `@` 输入增强”，并明确“生成内容仍走现有 prompt 文本通道”。在 v2 中按以下方式迁移：

- `/issue`：保留为文本模板时必须改名/描述为“Issue 模板”；升级为 `command.type=issue` 后才可叫“创建 issue”。
- `/status`：优先升级为 `command.type=status`，直接查询 linked issue / runner 状态；未升级前只能叫“状态查询提示模板”。
- `@project`：升级为 `reference.type=project`；用户可见文案必须写清“引用项目上下文，不切换执行项目”。
- `@issue` / `#id`：升级为 `reference.type=issue`；发送 payload 里必须有 issue id，不依赖模型解析 `#89` 文本。
- 旧的 plain-text 插入可作为 fallback 保留，但 UI 不能把 fallback 标为“已绑定上下文”或“已调用命令”。

## 第一阶段 MVP 顺序

1. **Payload 基础**：前端 composer state 支持 `references[]` 与 `command`，API request struct 接收并回显校验错误；不改变 provider 抽象。
2. **Issue / Project references**：把 #69 已有 `@issue`、`@project` 从 `insertText` 升级为结构化 chip + payload；发送时后端重新读取 issue/project 并组装 context。
3. **`/status` command**：接入 linked issue / selected issue / runner 状态查询，返回状态卡片；不再只插入查询 prompt。
4. **`/issue` command**：打开创建 issue 表单或 side panel，从 prompt 预填，提交后调用现有 issue API 返回 issue id。
5. **`/run #id` command**：依赖 issue reference 与 confirmation；确认后调用 enqueue/retry，并在 UI 展示 queued/run 状态。
6. **File / folder references**：依赖 workspace 边界、大小限制与读取确认；先目录树/摘要，后全文。
7. **Skill / plugin references 与 commands**：依赖本地 skill/plugin registry 与授权状态，不阻塞前五步。

## 后续子 issue 拆分建议

- Composer payload 与 API 校验：只加 schema、前端 state、后端 request validation，不接具体 command。
- `@issue` / `@project` 结构化引用：替换 #69 当前文本插入宣传口径。
- `/status` 状态命令：用真实 API 返回状态卡片。
- `/issue` 表单命令：创建 issue，不再只插 prompt 模板。
- `/run #id` 命令与确认：状态变更必须有 confirmation 与可验证 run 结果。
