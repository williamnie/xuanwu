# ADR-XW-0097：Jev 可选辅助 Skill

- 状态：Accepted
- 日期：2026-09-28
- 替代 ADR-XW-0096 中 GitHub 专属 Jev 调用和配置；保留其他 GitHub 流程。
- 技能包：`skills/jev-assist/SKILL.md`、`scripts/server.mjs`
- 宿主接入：`backend-ts/src/skills/jev/`、现有 MCP / Skill Registry

## 1. 运行边界

Jev 是全局可发现、按范围启用、由 Agent 按需选择的辅助 skill。它不是启动依赖、前置路由器、主模型或工作流必需项。
`SKILL.md` 提供使用说明；包内独立 MCP 脚本提供 `jev_classify_report`，不依赖玄武 TypeScript、PI SDK 或常驻进程。
宿主通过既有 MCP stdio transport 调用，只在调用时解析并向子进程注入 Key。没有 Node/Bun 时该技能不可用，玄武核心仍可运行。

首版输入是有界的 `title`、`body`、可选 `latest_message`，只输出报告意图、信息完整性和消息类型。不是通用规划、审批或验收工具。
`shadow` 只记录是否成功观察，不向 Agent 暴露分类建议；`assist` 仅返回通过 schema、分类取值和置信度检查的辅助建议。
PI 继续负责语义决策；权限、Work、Evidence、Handoff 和验收仍由现有机制决定。

普通辅助 skill 不伪造 intake/domain manifest，也不扩展它们的工作流输入输出合同。
已有 MCP 和技能目录按需组装能力，不新增插件管理器或状态账本。

## 2. 配置与界面

设置 → Skills → Jev 辅助判断提供启停、模式、模型、使用来源、Key 只写入/留空保留/明确移除、合成连接测试和最近调用状态。
页面上的“已配置”只表示本地配置齐备；连接测试和真实业务调用是独立证据。测试不会保存草稿、启用技能或发送真实任务内容。

状态目录的 `runner-settings.local.json`：

```json
{
  "optionalSkills": {
    "jev-assist": {
      "enabled": true,
      "mode": "shadow",
      "model": "jev-latest",
      "scopes": ["web", "github"],
      "apiKeyRef": "secret://skills/jev-assist/api-key",
      "apiKeyEnvFile": "",
      "minConfidence": 0.9,
      "timeoutMs": 5000
    }
  }
}
```

- 默认关闭、无允许来源；来源可选 `web`、`github`、`feishu`、`telegram`、`background`。
- Key 使用现有 SecretService；配置文件只存引用。兼容 `env://TYPESAFE_API_KEY` 和仅当前用户可读写的私有 env 文件。
- 移除凭据保存空引用，阻止 env/file/旧 GitHub 配置回退；只撤销本技能创建的 Secret，不删除共享凭据。
- 配置无效、凭据丢失、技能包缺失或解析失败只影响该技能，不能使宿主配置构建失败。
- API：`GET/PUT /api/pi/skills/jev-assist/settings`，`POST /api/pi/skills/jev-assist/test`。沿用现有 HTTP 鉴权边界，均不回显 Key。

## 3. 调用和权限

各渠道首先进入原有 Agent 流程，Jev 不在渠道入站时自动执行。
`chat`、`manager_cycle`、`recovery`、`acceptance` 在范围和权限允许时加载同一技能及工具；后两种内部 profile 只额外加载这个受控技能，不因此开放其他扩展。
`notification` 保持无工具。代码执行器只收到可选技能提示，宿主不修改用户的 Codex/Claude 原生安装或 MCP 配置；没有该工具时执行器正常继续。
GitHub 监督/验收会话通过权威 issue 来源识别 `github` 范围，并在其原有固定工具名单中按需加入该工具。

一次调用必须同时满足：技能已安装、全局已启用、来源允许、项目/委派/会话技能及 MCP 上限允许，以及 `skill.optional.call` 的 Action Gate。
该动作是受控只读辅助调用，但包含外发，因此仍验证授权有效期、目标范围、禁止动作和输入外发限制。
后台 manager 的 `pi-cycle:<project>` 是审计 ID，不是假定存在的持久化委派；实际委派仍检查其独立权限。
未声明项目 MCP allowlist 时，显式启用后台技能只为 manager 增加 Jev 这一项；已有显式 allowlist 不被扩大。

每次调用重新读取配置和项目策略。排队结束、实际 spawn 前再次校验；禁用/改配置/卸载后的排队调用不得启动。
已经发出的请求无法撤回，若在调用中配置变化，返回结果会被丢弃。Key 不进入模型参数、结果、配置响应或调用审计。

## 4. 失败和可观测性

- 未启用、不在允许范围、缺凭据、缺包、输入不合法：零外部请求。
- 网络/鉴权/输出校验失败或超时：返回 `unavailable`；Agent 继续使用原始上下文。
- 低置信度：无建议，继续原有流程。
- 连续三次服务失败后冷却 60 秒；每实例最多四个活动调用，额外请求立即降级，不做隐式重试。
- 超时覆盖响应体读取；外部响应和输出大小有上限。MCP 的排队/进程组清理沿用现有 transport。
- `ToolResult.status=succeeded` 表示成功返回结构化结果，不代表 Jev 成功；调用者查看 `output.status` 和 `reason`。连接测试的 `ok` 仅在真实适配器返回 `observed` 时为真。
- 现有 `pi_action_events` 的 `optional_skill.called` 保存状态、耗时、模型、来源、输入 hash；不保存原始报告或上游响应。现有工具审计仍脱敏处理。

## 5. 兼容与卸载

当新配置不存在时兼容读取 `integrations.github.issueSync.jev`。只有旧 issue sync 开启且旧 mode 明确为 `shadow`/`routing` 才启用；缺省或 `off` 保持关闭。
旧 `routing` 映射为 `assist`，使用范围仅 `github`。无效旧配置停用该技能并显示诊断，不影响 GitHub。
首次保存写入新配置，随后只读新配置；旧字段保留以便回滚，不会双调用。
GitHub polling 删除原直接 API 调用，不因 Jev 失败延误 Work 接入。

停用或移除 `skills/jev-assist` 即可撤下该能力，保留配置与历史审计。发布打包在技能目录不存在时跳过，不要求安装 Jev。

## 6. 验证

定向测试：`bun test src/skills/jev`。覆盖 SDK 会话工具选择、MCP 协议、配置/API/密钥生命周期、各来源和实际内部 profile、权限拒绝、缺包、缺 Key、超时、冷却、排队禁用及旧配置迁移。
同时运行受影响的 MCP、Skill Runtime、Action Gate、PI 对话和 GitHub 回归。
前端覆盖草稿保护、保存并发反馈、Key 移除语义，以及浅色/深色和相关响应式断点。
隔离测试使用合成数据和假服务；不把它称作真实 Jev 服务连通性、性能收益或生产部署验收。
