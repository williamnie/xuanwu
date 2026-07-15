# ADR-XW-0002：玄武品牌术语与兼容标识合同

- 状态：Accepted
- 日期：2026-07-15
- 依赖：[ADR-XW-0001](0001-product-positioning.md)
- 决策范围：用户可见品牌、Supervisor/Runner 职责名称、内部兼容名称和逐文件迁移边界
- canonical 级别：本文件是玄武品牌术语的 source of truth

## 1. 决策

玄武只有一个产品身份，不再把 PI Assistant、Runner Brain 或 Codex Issue Runner 当作并列产品展示。

| 对象 | 用户可见名称 | 使用规则 |
| --- | --- | --- |
| 产品 | **玄武**；英文或双语场景使用 **Xuanwu** | 页面标题、品牌锁定和产品文档使用“玄武 / Xuanwu”；描述词固定为 **AI Engineering Control Plane** |
| 监督与交互运行时 | **Xuanwu Supervisor**；上下文明确时简称 **Supervisor** | 对话、Inbox、Memory、Settings、策略、自动化与 issue 监督统一使用；不再显示 PI Assistant、Runner Brain 或 PI Supervisor |
| 执行子系统 | **Runner** | 仅指 claim issue、启动 provider/session、执行、重试、恢复和运行状态；不得作为产品名或智能人格 |
| 监督能力 | **Guardian** | 仅指 watchdog、失败分类、恢复建议和告警能力；不得作为产品 descriptor 或第二个 Supervisor |
| 工程工作对象 | Issue / Session（当前），Work / Run（目标） | 按 ADR-XW-0001 的迁移原则演进；本合同不提前创建新表、路由或状态机 |

首选品牌锁定为“玄武 Xuanwu · AI Engineering Control Plane”。`Local-first · Verification-first` 可以作为短 tagline，但不能替代产品类别。

## 2. 内部兼容名称

下列名称继续存在仅为兼容，不得重新进入用户可见产品文案：

| 兼容名称 | 当前用途 | 本期决策 |
| --- | --- | --- |
| `codex-issue-runner` | 仓库、发行二进制、CLI、skill、Codex `clientInfo`、安装目录和服务标识 | **保留稳定**；它是兼容产品 ID，不是 UI 品牌名 |
| `CODEX_RUNNER_*` | 环境变量和部署配置 | **保留稳定** |
| `/api/pi/*`、`pi_*`、`pi_agents`、`pi_agent_id` | API、数据库表/列、事件与内部模块命名 | **保留稳定**；不得因 UI 改名复制 `/api/supervisor/*` 或新表 |
| `runner-default` | 默认 Supervisor runtime 的稳定 agent ID | **保留稳定**；只把新建数据库的默认显示名改为 `Xuanwu Supervisor` |
| `PI_ASSISTANT_*`、`Pi*`、`pi-*` | 前端常量、组件、文件和 route ID | **保留稳定**，直到有独立的代码迁移 issue |
| `runner-brain` | Settings 的兼容 tab ID | **保留稳定**；显示标签固定为 `Runtime`，不得显示 Runner Brain |
| PI Assistant / Runner Agent / Runner Brain 的旧默认名称和 instructions | 既有数据库读取兼容 | 只对精确的历史默认值做 UI projection；其他名称和 instructions 不改写 |

“保留稳定”意味着本 issue 不重命名、不新增别名路由、不双写，也不修改这些标识的语义。日志、诊断 JSON 或开发文档可以在解释兼容实现时显示原始标识，但必须明确其 compatibility/internal 身份。

## 3. Source of truth、兼容窗口与回滚

### 3.1 Source of truth

1. 产品术语以本文件为 source of truth。
2. 前端代码中的固定术语投影以 `frontend/src/brand.js` 为 source of truth。
3. 运行状态继续以现有 SQLite、Bun API 与 Runner 状态机为 source of truth；UI 名称不能改变权限、状态或完成判定。
4. `pi_agents.name` 仍是用户可编辑的 runtime metadata，不是产品品牌字段；除精确命中历史默认值的 compatibility projection 外，其他名称必须原样保留。

### 3.2 新旧模型并存

- **双写：无。** 本期不创建新字段、新表或新 API，也不在两个名称字段间同步。
- **双读：无。** API 和 DB 仍只有原 `pi_*` 路径。
- **兼容 projection：有。** 前端读取 `runner-default` 时，只把精确匹配的历史默认名称 `PI Assistant` / `Runner Agent` / `Runner Brain` 和历史默认 instructions 映射为 canonical 默认值；自定义值不映射。用户下次保存设置时，仍通过原 `/api/pi/agents/runner-default` 写回同一行。
- **期限：** projection 最多保留本 ADR 生效后的两个正式 release；若 P11 清理更早完成则提前删除。需要延期时必须有新的 ADR、数据审计和明确退出版本。
- **回滚：** 回滚本期前端文案、projection 和新数据库 seed 即可；因为没有 schema/data migration，旧 API/DB/CLI 无需恢复或重建。

### 3.3 最终删除门禁

删除兼容 projection 或重命名内部 `pi_*` 前必须同时满足：

1. 受支持数据库中 `runner-default` 的历史默认名称和 instructions 已完成只读计数审计，并有备份/恢复步骤。
2. 前端、CLI、API consumer、skill、fixture 和部署脚本的引用清单为零，或已有逐项兼容证明。
3. 至少一条 clean-baseline journey 覆盖 Supervisor 对话 → Issue/Session → Evidence → 最终状态回写。
4. 回滚观察窗结束，且没有 active consumer 依赖被删除的 ID/route/table。
5. 删除通过独立 migration issue 完成；不得在普通 UI issue 中顺手清理。

## 4. API、DB 与 CLI 稳定标识

本 issue 明确不改以下 contract：

| 类型 | 稳定标识 |
| --- | --- |
| CLI / binary | `codex-issue-runner` |
| Codex client | `clientInfo.name = codex-issue-runner` |
| 默认 runtime ID | `runner-default` |
| API | `/api/pi/*`、`/api/runner/*` 及其现有 payload 字段 |
| DB | `pi_agents`、所有现有 `pi_*` 表、`pi_agent_id` 和既有 migration 编号 |
| 配置 / 部署 | `CODEX_RUNNER_*`、现有 state dir、launchd/systemd 标识 |

用户可见改名不得成为绕过 action gate、Permission/Approval、审计事件或 Verification Policy 的理由。本期没有新增状态变更、外部写或 destructive 操作路径。

## 5. 逐文件迁移表

| 文件 | 本期动作 | 兼容边界 / 后续 |
| --- | --- | --- |
| `README.md` | 以玄武作为产品标题，链接本合同；把发行物说明为 `codex-issue-runner` 兼容名 | 安装命令、路径和 CLI 示例保持原值 |
| `frontend/index.html` | 浏览器标题改为玄武产品类别 | favicon 路径保持不变 |
| `frontend/src/brand.js` | 固定产品、Supervisor、Runner 术语与 descriptor/tagline | `BRAND.name` / `BRAND.hanzi` 保持现有组件 contract |
| `frontend/src/components/BrandMark.jsx` | 继续从 `BRAND` 渲染，不新增第二套 logo | 组件名和资源名保持不变 |
| `frontend/src/components/AppSidebar.jsx` | 分组标题显示 `Xuanwu Supervisor` | `PI_ASSISTANT_*` 常量保持内部兼容 |
| `frontend/src/pages/assistantModules.js` | 模块说明统一使用 Supervisor / Runner | `pi-*` page ID 保持不变 |
| `frontend/src/pages/SettingsChrome.jsx` | 页面和 tab 显示 Supervisor Settings | `assistant`、`runner-brain` tab ID 保持不变 |
| `frontend/src/pages/AssistantSettingsPlaceholders.jsx` | 单 runtime 心智改为 Xuanwu Supervisor | 组件/文件名暂不改 |
| `frontend/src/pages/AssistantSettingsSections.jsx` | Connectors、Skills、Memory 归属统一为 Supervisor | API client 仍调用 `/api/pi/*` |
| `frontend/src/pages/PiAgentSettingsPanel.jsx` | 设置、OAuth、display name、enabled 文案统一为 Supervisor | `pi_oauth` response 字段保持不变 |
| `frontend/src/pages/piAgentSettingsState.js` | 新默认值改为 Supervisor；精确读取旧默认名称/instructions 时做兼容 projection | 不后台写库；自定义值不改写；期限见 3.2 |
| `frontend/src/pages/PiChat.jsx` | 对话、role、loading、diagnostics 文案统一为 Supervisor | conversation/session payload 和 `pi_session_id` 保持不变 |
| `frontend/src/pages/piChatState.js`、`PiChatComposerMeta.jsx`、`piChatComposer.js` | toast、runtime context 和项目绑定文案统一为 Supervisor | 内部函数名、事件名保持不变 |
| `frontend/src/pages/AttentionInbox.jsx` | Inbox 归属和解释者改为 Supervisor | intake/proposal 数据链保持不变 |
| `frontend/src/pages/PiMemoryPanel.jsx` | Memory UI 改为 Supervisor Memory | `memory_write_candidate` 和存储 contract 保持不变 |
| `frontend/src/pages/PiMcpManagementPanel.jsx` | MCP enablement 的主体改为 Supervisor | MCP registry/capability ID 保持不变 |
| `frontend/src/pages/IssueSupervisorPanel.jsx` | 删除 PI Supervisor 显示别名 | `pi_decision` payload 保持不变 |
| `frontend/src/components/guardianAlertDisplay.js` | 告警只显示 Guardian / Supervisor | `pi_guardian` 状态字段保持不变 |
| `backend-ts/src/db/defaultPiAgent.ts` | fresh DB 的默认显示名和 instructions 改为 Xuanwu Supervisor | `runner-default`、`pi_agents` 和 legacy seed 行为保持不变；不更新既有行 |
| `frontend/src/brandTerminology.test.js` | 审计 UI 禁用术语和稳定 CLI/API/DB 标识 | 作为本合同的最小自动化门禁 |

未列入本表的 runtime prompt、provider adapter、数据库 schema、公开 API、共享状态机和历史架构文档不在本 issue 的修改范围内。它们可以保留兼容名，但不得被解释为另一套产品身份。

## 6. 验证合同

`frontend/src/brandTerminology.test.js` 必须至少证明：

1. 产品、Supervisor、Runner 的 canonical 常量与本文件一致。
2. live UI source 不再出现 PI Assistant、Runner Brain、PI Supervisor、PI Guardian、PI Memory、PI OAuth 或 Agent Guardian；精确的 legacy projection literal 是唯一例外。
3. `codex-issue-runner` CLI/client、`runner-default`、`/api/pi/agents`、`pi_agents` 与 `pi_agent_id` 没有被误改。

术语审计失败时不得通过增加宽泛 allowlist 绕过；只能修正文案，或在新的 ADR 中说明一个精确、限期的兼容例外。
