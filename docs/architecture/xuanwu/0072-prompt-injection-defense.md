# ADR-XW-0072：威胁模型与 Prompt Injection 防线

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P10.05 / Runner #728
- 硬依赖：XW P06.02 / #681、XW P08.08 / #714、XW P09.01 / #717（均为 `done`）
- 可执行防线：`backend-ts/src/security/promptInjectionDefense.ts`
- 攻击 fixtures：`docs/fixtures/security/prompt-injection-attacks.json`
- canonical 级别：本文与现有 `actionGate.ts`、Tool Registry/Skill Runtime、ChannelConnector outbound contract 共同定义 Supervisor 的 prompt/data 边界；LLM 文本不是权限 authority

## 1. 威胁模型与 trust boundaries

| 输入 | 事实可信度 | 指令权限 | 必须经过的边界 |
| --- | --- | --- | --- |
| canonical Supervisor system contract、确定性 project/runtime policy | 配置 authority | 有限；仍不能越过代码 gate | 固定 prompt 装配、policy parser、audit |
| 用户和外部消息、Webhook、connector inbound | 不可信请求/证据 | 无；用户意图也不是 capability | `external_events`/context bundle、`xw.untrusted-data.v1`、source policy |
| repository/Issue/HTML/web/browser content | 不可信证据；可含伪 system 文本 | 无 | bounded read、路径/内容/secret redaction、marker |
| Skill/AGENTS/custom resource text | allowlisted metadata/resource，但正文不授予权限 | 无；manifest 声明也不是 grant | controlled loader、Skill policy、builtin handler allowlist、capability sandbox |
| MCP/CLI/HTTP/browser/tool output | provider data，不是 gate 结果 | 无 | Tool Registry、permission ceiling、tool audit、model-visible marker |
| LLM proposal/rationale/“approved”文本 | 候选数据 | 无 | Action Gate、exact scope、approval carrier、idempotency/audit |

攻击目标包括：伪造 system/approval 文本、诱导读取 secrets、通过 URL/MCP/tool input 外带数据、让 Skill/仓库文件扩权、让 tool output 触发下一次写操作，以及借 connector outbound 绕过 action/outbox authority。

## 2. untrusted markers 与 prompt/context

所有 model-visible tool output 统一包在 `xw.untrusted-data.v1`，显式声明 `instruction_authority=none`；payload 使用 JSON 编码，攻击者控制的引号、换行和 HTML 仍是数据。外部消息进入 context bundle 时在每项 `source_ref` 写入 `untrusted://external_message/...instruction_authority=none`，不挤占原 token budget；Skill metadata 注入同样标记。canonical system prompt 列举 repository、web、Skill、MCP、memory、connector、tool output 边界，并声明 marker 仿冒也不能升级权限。

Marker 只降低模型误跟随概率，不是安全 authority。即使模型完全忽略 marker，后续确定性 capability gate 仍必须阻止越权执行。

## 3. capability gates 与 approvals

1. Tool Registry 的 `read|write|dangerous`、provider kind 与 allowlist 决定可见/可调用能力；模型不能注册工具或修改 permission。
2. Skill Runtime 只允许内建 handler，取 Skill/Workflow/tool ceiling 的交集；capability sandbox 只自动执行 `read`，write/dangerous 转 proposal/approval。
3. `actionGate.ts` 在任何 mutation/external action 前检查 forbidden、scope/window、allowed action/MCP/Skill、risk 和 exact delegated envelope；无授权写保持 `deny`/`ask`。
4. external connector outbound 继续要求 `deterministic_policy|human_approval` 的 `allow` 和 `action_gate_ref`；LLM 不是合法 authority。
5. decision 与 dispatch 写入现有 `pi_actions`/`pi_action_events`、`pi_approval_requests`、tool audit 和既有 outbox/provider receipt，不新增第二套 approval 或 external writer。

## 4. data exfiltration controls

- repository reader 拒绝 `.env`、`.git`、secret/token/credential 路径、越界和 symlink escape，内容在进入模型/审计前脱敏并限长。
- browser 只暴露授权 snapshot、同源页面和 storage key metadata，不暴露 cookie/storage value；HTTP 只允许 bounded `GET|HEAD`。
- 所有非 builtin connector/tool invocation 在 dispatch 前检查 input；raw token/password/cookie/Authorization/private-key/常见 production key 被 `sensitive_egress_denied` fail closed。
- `mcp.tool.call`、message send、push/deploy/publish/upload/delivery 等 external action 在 Action Gate 最前面执行同一 secret egress 检查，即使 allowlist 或 LLM 生成了“approved”也不能覆盖。
- URL userinfo 与敏感 query/value 被拒绝；认证应经 opaque `secret_ref`/受控 env，而不是模型生成的 payload 或 URL。
- 拒绝事件沿现有 Action Gate/tool audit 留痕；错误只返回字段路径和代码，不回显 secret。

## 5. authority、兼容、回滚与删除门禁

- **source of truth 不变：** Issue/Work/Run/Evidence/Handoff、`pi_actions`、`pi_approval_requests`、Tool Registry、Skill manifest+handler allowlist、connector/outbox 各自继续拥有既有事实；marker 不是状态 authority。
- **双读=0、双写=0：** 仅在现有 prompt/context/model-output choke points 增加标记，并在现有 invocation/Action Gate 增加 fail-closed preflight；无 schema、公共 API、provider adapter 或状态机迁移。
- **兼容：** tool `details` 和 domain return object 保持原形，只有 model-visible text 增加 wrapper；已脱敏占位值允许通过，raw secret input 现在确定性拒绝。
- **回滚：** 回退本 issue scoped commit 即恢复旧 model-visible formatting/preflight；现有 audit/state 无需回写或删除。
- **最终删除门禁：** 只有替代机制覆盖相同六类输入、恶意 fixtures、secret egress、unauthorized write、Skill/MCP/connector gates，且连续一个正式 release 无 bypass，才能经 P11/G7 非 LLM 安全批准删除 marker或 preflight。不得以“模型更安全”为由删除确定性 gate。

## 6. 验证合同

```bash
cd backend-ts
bun test src/security/promptInjectionDefense.test.ts \
  src/pi/contextBundleBuilder.test.ts \
  src/pi/actionGate.test.ts \
  src/pi/readOnlyToolInvocation.test.ts \
  src/pi/httpToolCall.test.ts \
  src/pi/runnerActionTools.test.ts \
  src/http/piRuntimePrompt.test.ts
```

fixtures 必须覆盖恶意 prompt、HTML、repo file、MCP/tool output；并证明 marker 不授予权限、未授权 write 为 `deny|ask`、raw secret 不能通过 connector/MCP/URL egress。
