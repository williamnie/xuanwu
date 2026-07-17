# ADR-XW-0058：可执行 Skill Runtime 与权限审计

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.12 / Runner #691
- 硬依赖：XW P06.02 / #681、P06.07 / #686（均为 `done`）
- 可执行合同：`backend-ts/src/skills/runtime.ts`
- 首个内置 handler：`backend-ts/src/skills/builtinDomainProposal.ts`
- canonical manifest：`skills/pi-domain-proposal/manifest.json`

## 1. 决策与边界

`SKILL.md` 继续提供人可读 metadata；同目录 `manifest.json` 是 runtime declaration 的 source of truth。可执行
Skill 必须声明 `execution.adapter=builtin`、allowlisted `handler`、`sandbox=capability` 和 `timeout_ms`。Runtime 不加载
manifest 指定的任意 JS/module/shell 路径：handler 只能来自进程内显式 allowlist，并只收到冻结后的 schema input、
`AbortSignal` 与 capability tool gateway；不会收到 DB、cwd、filesystem、env 或 provider adapter。

本期只接管原 `domainSkillFixture` 的生产路径：默认 Skill 改为 `pi-domain-proposal`，通过真实 repo-local manifest 和
`builtin:pi-domain-proposal` handler 生成 proposal-only 输出。现有 `runIntakeSkill` 仍是 LLM intake 的 authority；本 issue
不新建 provider adapter、DB 表、公共状态机、外部写执行器或 Workflow stage scheduler。

## 2. 确定性门禁

一次执行固定经过以下顺序，任一失败都 fail closed：

1. manifest 必须存在 executable handler，handler 必须在 allowlist；
2. 若由 Workflow stage 调用，Skill ID 必须在 `required_skill_ids`，Skill 的权限上限与全部 required tools 必须落在
   frozen stage ceiling/allowlist 内；
3. input 必须通过 manifest `input_schema`；handler 只能读取深冻结副本；
4. `required_tools` 是 capability grant，不是文字提示。gateway 以当前 Tool Registry snapshot 解析 exact tool，拒绝未授权、
   缺失、歧义或超过 Skill/Workflow ceiling 的工具；
5. capability sandbox 只自动调用 `read` 工具，并复用 `invokeReadOnlyAssistantTool` 与 `tool_call_audit`。即使 manifest 的
   上限为 `write`，write/dangerous 工具也必须转 Action Proposal/Approval，不能由 handler 直接执行；
6. handler 必须在 `timeout_ms` 内完成；超时后 sandbox 关闭，迟到 handler 不能继续调用 tool；
7. output 必须通过 `output_schema`。Domain proposal 的每个 `evidence_refs` 还必须非空且属于受控 inbox input；
8. 只有上述门禁全部通过才写现有 `pi_actions` / `pi_action_proposals` 并把 inbox item 标为 `proposal_created`。

LLM 输出、Skill 文档、handler summary 或 manifest 文本都不能修改 Tool Registry permission、Workflow ceiling、Evidence
scope 或 Action Gate decision。

## 3. Run history、失败隔离与审计

不新增 Skill Run 表。现有 append-only `pi_action_events` 保存 `xw.skill-run.v1`：

- `skill_runtime.started`：Skill/handler、manifest、sandbox、timeout、tool grants、Workflow ref/stage 与 Evidence refs；
- `skill_runtime.completed`：`succeeded | failed | timeout`、耗时、input/output/Evidence validation 和脱敏 error code；
- 每次工具调用或拒绝继续写既有 `tool_call_audit`；
- 成功后的 `pi_action` 与 `pi_action_proposal` 仍是 proposal/action authority，runtime event 只保存执行审计与关联 ID。

坏 input/output、越权、缺工具、handler error 或 timeout 不写 proposal、不修改 inbox 状态，也不影响其他 Skill Run。
`GET /api/pi/skills/domain-runs` 同时读取新 `skill_runtime.completed` 与 legacy
`attention_inbox.domain_skill_requested`，返回形状保持兼容，失败也可回读。

## 4. Authority、兼容、迁移与回滚

- **Skill authority：** repo/runtime policy 选中的 `SKILL.md` + `manifest.json`；可执行行为由 manifest handler ID 与代码
  allowlist 共同确定，二者缺一不可。
- **Workflow authority：** P06.07 frozen manifest/stage；Skill Runtime 只收窄 grant，不能扩权或切换 revision。
- **Tool authority：** 当前 Tool Registry snapshot 与共享 invocation/audit service。
- **Evidence authority：** inbox/context 的受控 Evidence refs 与 P04 Evidence；handler 不能制造新的可信 ref。
- **状态 authority：** `pi_actions`、`pi_action_proposals`、Attention/Issue/Run repositories；Skill events 不是第二份 ledger。

迁移窗口：

- **W1（本期）：** 新 Domain Run 只写 `skill_runtime.*`，默认 Skill 只用 `pi-domain-proposal`；旧
  `fixture-domain` action/event 保留只读，不回填、不双写。API 对两种历史事件双读，最长两个正式 release window。
- **回滚：** 回退 runtime selector/caller 到上一 scoped commit；保留所有新 Skill/tool audit、proposal 和旧记录，不删除、
  不反写、不让 legacy 与新 runtime 同时处理同一 inbox item。
- **最终删除门禁：** P10 evaluation 与 clean-baseline Golden Journey 覆盖成功、坏 schema、越权、超时、Evidence 越界、
  retry/replay；连续一个正式 release 无 legacy new-run producer；双读窗口结束并经 P11/G7 批准后，才可删除 legacy
  event reader 与 fixture-only artifacts。

## 5. 最小验证

```bash
cd backend-ts
bun test src/skills/runtime.test.ts src/skills/registry.test.ts src/http/piSkillsApi.test.ts src/pi/eventRouter.test.ts
```

测试必须覆盖真实 `pi-domain-proposal` smoke、坏 execution/输入/输出、write tool 越权、timeout 后 capability 关闭、
Workflow stage grant 交集、Evidence 绑定、run history API 与生产默认路径不再使用 `fixture-domain`。
