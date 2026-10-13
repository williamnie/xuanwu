# 前端精简：剩余事项交接说明

> 背景与完整方案见 `docs/design/frontend-simplification-plan.md`（尤其 5.x、6.4、8.1.1、8.1.2、9.1 Q9）。
> 本文是给接手 Agent 的执行说明：每项写清范围、涉及文件、验收标准和不能动的部分。

## 0. 开工前必读

- 分支：`feat/frontend-simplification-v2`（当前工作区），**不要新建或切换 worktree，不要推送**。
- 动任何 UI 前，完整阅读 `docs/design-system/README.md` 与 `docs/design-system/spec.md`。只能复用既有令牌和组件（如 `.ds-request-card`、`settings-subsection-title`、`<details>` 折叠样式），不引入新颜色、圆角、字号、阴影、图标或动效。
- 每项**单独一个提交**，提交信息格式参考 `git log`（如 `feat(frontend): …`）。
- 每项完成后必须通过：

  ```bash
  cd frontend && bun test --timeout 60000 && npm run lint && npm run build
  ```

  并检查浅色 / 深色主题和 760px 以下窄屏。
- 中英文案都要改：`frontend/src/i18n/translations.js` 的 ZH_CN 与 EN_US 键必须一一对应（有测试）；组件内写死的中文若同文件已有 `english ? … : …` 写法，保持同样写法。
- 测试多数是源码正则测试（node:test）。改结构时**同步更新对应测试的断言**，不要删测试来让它通过；删除组件时一并删除它的测试，并在提交说明里写明。

## 1. 绝对不能改坏的部分（上一轮就坏在这里）

1. 任务详情“过程”段 `frontend/src/pages/work/WorkRunProcess.jsx`：复用完整的 `RunDetail` + `RunContextBar`，**默认展开**，执行中每 5 秒刷新并响应事件。不得改成摘要、不得默认折叠、不得去掉实时会话 / 日志 / 原始事件 / 尝试切换。
2. 左侧导航保留“执行记录”（route `runs`）；执行详情不自动跳转；`#/work?workId=&runId=` 深链可用。
3. 任务列表行按钮和看板拖拽共用 `frontend/src/pages/work/workActions.js`。
4. 设置路由映射在 `frontend/src/pages/settingsNavigation.js`。旧 section（`supervisor`、`code-agents`、`integrations`、`permissions`、`policies`、`diagnostics`、`skills`、`memory`、`activity`）必须继续落到正确位置。
5. 只改界面，不改接口语义：
   - `PersonaSettingsPanel` 是 persona 唯一的保存者，其他面板保存时不得携带 `persona` 字段。
   - `RunnerSettingsPanel` 只 PUT `{max_parallel_projects}`。
   - 删除某个输入框的 UI 时，保存请求里要**原样带回原值**，不能变成空值或默认值。
6. 删除面板前先确认它的功能有了新位置。“删掉即精简”是错的。
7. 不改 route ID、API 字段名、代码标识符。

## 2. 任务清单（按建议顺序）

### 任务 A：安全与权限去掉“能力标识”列（小）

- 文件：`frontend/src/pages/PermissionsSettingsPanel.jsx`（约第 49–60 行的 `MatrixHeader labels={['连接', '能力标识', '方向', '授权']}` 及行渲染）。
- 改法：删掉“能力标识”这一列（表头和每行对应单元格），其余列与权限判断逻辑不动。若同一行需要区分同名连接，可把能力标识放进该行的 `title` 属性，不再单独占一列。
- GitHub“当前生效规则”：它在 `GitHubSettingsPanel.jsx:135`，只在“已保存未生效”时出现，和保存状态机绑定，**保留在 GitHub 面板里不动**。本项不移动它（方案 8.1.1 第 3 条里的这半句作废）。
- 验收：`bun test` 里 `settingsProductModels`、`PermissionsSettingsPanel` 相关测试通过；页面只显示 3 列。

### 任务 B：处理记录的 ID 过滤收进“按 ID 查找”（小）

- 文件：`frontend/src/pages/ActivityTimelinePanel.jsx`、`frontend/src/pages/activityAuditFilters.js`（`DEFAULT_ACTIVITY_FILTERS`）。
- 改法：常用过滤（类型、时间等非 ID 字段）留在外面；所有 ID 类字段（issue / run / session / request 等，按 `DEFAULT_ACTIVITY_FILTERS` 实际字段为准）放进一个 `<details>`，summary 文案“按 ID 查找”（英文 “Find by ID”）。
- 只要任一 ID 字段有值，`<details>` 默认展开（`open={hasIdFilter}`），并在 summary 后显示已填数量。
- 过滤逻辑 `filterActivityAuditItems` 不改。
- 验收：`activityAuditFilters.test.js` 通过；补一条源码测试断言存在“按 ID 查找”的 details。

### 任务 C：剩余硬编码旧术语替换（小到中）

- 术语表（只改**用户可见文案**）：
  - 工作项 → 任务
  - 证据 → 验证结果
  - PI / Pi / Supervisor / 主管（指玄武助手时）→ 玄武助手
  - Provider（指 Codex / Claude Code 等时）→ 编程工具
  - 状态：queued → 排队中，running / in_progress → 执行中，needs_user → 待你处理
- 查找方式：`grep -rn "工作项\|证据\|Supervisor\|Provider\|PI " frontend/src --include=*.jsx --include=*.js | grep -v test`，逐条判断是否用户可见。
- 不改：变量名、CSS 类名、API 字段、route ID、日志里的英文技术词、测试夹具数据。
- 已知例子：`PiAgentSettingsPanel.jsx:128` 的“将同时移除 Supervisor OAuth 授权凭据”→“将同时移除玄武助手的 OAuth 授权”。
- 验收：相关测试里的文案断言同步更新；`translations` 测试通过。

### 任务 D：AI 连接 → 玄武助手的连接方式（中）

- 文件：`frontend/src/pages/PiAgentSettingsPanel.jsx`（`ConnectionModeTabs` 约 149 行、`OAuthConnectionFlow` 约 191 行、`ConnectionProgress` 约 282 行）及 `PiAgentSettingsPanel.css`。
- 改法：
  1. 把 `ConnectionModeTabs` 的两个小按钮改成两张并排的大选项卡片（复用设计系统已有的可选卡片 / radio 卡样式；若 spec 中没有，就用现有 `settings-notification-modes` 的三选一样式，不要新造）：
     - “API 连接”：填写地址和 Key。
     - “用 Codex / ChatGPT 账号登录”：OAuth。
     窄屏时上下排列。
  2. OAuth 的次要操作（重新授权、撤销、复制链接等）收进一个“更多”菜单或 `<details>`，主按钮只留“登录”或“已登录”。
  3. 状态拆成两行独立显示：“授权：已授权 / 未授权”和“模型：已测试可用 / 未测试 / 测试失败”。不要合成一个“已连接”。数据来源保持现有的 `state.oauthStatus` 与模型测试结果。
- 不改：保存逻辑、`api === 'openai-codex-responses'` 的判断、不得写入 persona。
- 验收：`piAgentSettingsPanel` 测试按新结构更新后通过；浅色、深色和窄屏都检查。

### 任务 E：项目编辑器调整与“高级 → 执行预设”（大）

- 文件：
  - `frontend/src/pages/ProjectSettingsEditor.jsx`（596 行）、`ProjectSettingsEditor.css`
  - `frontend/src/utils/agentProfiles.js`（含 Skill / Plugin 意图）
  - `frontend/src/pages/settingsNavigation.js`
  - `frontend/src/pages/AssistantSettingsSections.jsx`（`AdvancedSettingsTab`）
- 改法：
  1. 项目编辑器里“执行引擎”改名为“编程工具”。
  2. 默认模型改为下拉框，选项来自现有可用模型数据；若当前值不在列表中，保留为一个“当前值（自定义）”选项，不能清空。
  3. 执行速度、推理深度收进“更多选项” `<details>`。
  4. Agent Profile 区（含 Skill 意图）整块移出项目编辑器，放到 高级 → 新增“执行预设”节。项目编辑器原位置只留一行：“执行预设：<名称> · 在 高级 → 执行预设 中修改”，并附带跳转链接。
  5. 删除 Plugin 意图的输入 UI。保存时把读到的原值**原样带回**，并补测试断言这一点。
- 设置路由：
  - 在 `SETTINGS_ADVANCED_SECTIONS` 加入 `presets`（显示名“执行预设”）。
  - 更新 `advancedSectionCopy`。
  - 在 `settingsNavigation.test.js` 补映射测试。
  - 高级区的规则保持不变：首次展开才挂载，深链时自动展开并滚动到该节。
- 验收：`agentProfiles.test.js`、`settingsNavigation.test.js`、`Projects.*.test.js` 通过；在项目编辑里改模型并保存，再打开时值仍在。

### 任务 F：外部连接改为“连接列表 + 抽屉”（大，最后做）

- 文件：
  - `frontend/src/pages/AssistantSettingsSections.jsx` 的 `IntegrationsSettingsTab`（约 69–100 行，现有 github / feishu / telegram / health 4 个子 Tab）
  - `GitHubSettingsPanel.jsx`、`FeishuSettingsPanel.jsx`、`TelegramSettingsPanel.jsx`、`ConnectorDiagnosticsPanel.jsx`、`ImChannelRegistryPanel.jsx`
- 改法：
  1. 用一个列表替换 4 个子 Tab，每个连接（GitHub、飞书、Telegram）一行，包含：名称、一句说明、连接状态（来自现有诊断数据，即 `ConnectorDiagnosticsPanel` 的数据源）和“设置”按钮。
  2. 点“设置”后从右侧打开抽屉，抽屉内容**直接复用**现有面板组件。GitHub 抽屉用 `GitHubSettingsPanel`，其中的“测试 / 保存并生效”状态机不要重写。窄屏时抽屉全屏显示。抽屉复用现有 Modal / Drawer 组件；若没有 Drawer，复用 `ModalOverlay`，不要自己写遮罩。
  3. 完整诊断（`ConnectorDiagnosticsPanel`）移到 高级 → 运行维护（diagnostics 节），列表行只显示状态摘要。
  4. 删除 `ImChannelRegistryPanel`，以及它的 CSS 和测试。删除前先确认它展示的信息已由每行状态或诊断覆盖；若有未覆盖的字段，先停下来，在交接结果里说明，不要硬删。
  5. 飞书：字段按“应用凭据 / 事件订阅 / 通知目标”分组，每组加一句说明。
  6. Telegram：项目映射从手填 ID 改为项目下拉，数据来自 `selectProjects`，保存的值格式不变。
- 旧链接 `#/settings?section=integrations` 仍要落到这里；若有 `channel=` 参数，打开对应抽屉。
- 验收：`feishuSettingsPanel`、`telegramSettingsPanel`、`githubSettingsTests/*` 通过；GitHub 保存并生效流程在抽屉内可用。

## 3. 不要做的事

- D 阶段（批量创建、3 步引导、路由改名、飞书来源发现、任务按来源筛选）：依赖方案 8.2 中的后端合同，**不做**。
- 不改后端（`backend-ts/`）。
- 不顺手重构与本清单无关的组件。

## 4. 完成后的回报格式

每项回报以下内容：

- 提交哈希
- 改了哪些文件
- 测试 / lint / build 结果（失败要贴输出）
- 浅色 / 深色 / 窄屏是否已检查（未检查就写未检查）
- 偏离本文的地方及原因
