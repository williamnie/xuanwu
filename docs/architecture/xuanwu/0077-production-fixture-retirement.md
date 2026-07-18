# ADR-XW-0077：生产 Skill/MCP fixture 退出

- 状态：Accepted
- 日期：2026-07-18
- 路线 issue：XW P11.01 / Runner #736
- 硬依赖：XW P06.12 / #691、P10.08 / #731（均为 `done`）
- 数据迁移：`051_remove_production_fixtures`

## 引用审计

2026-07-18 对当前 launchd/3008 live runtime 与其 SQLite authority 做只读计数审计：

- `pi_actions` payload/id/idempotency key 中 `fixture-domain`：0；
- `pi_action_events` payload 与 legacy domain event：0；
- `pi_automations.steps_json`、`intake_runs.skill_id`、skill-scoped `pi_memory_items.scope_id`：0；
- enabled MCP server/capability：0；live launchd 配置未设置 MCP registry fixture JSON/file；
- `domainSkillRun.ts` 与 `eventRouter.ts` 的默认值均来自 `DEFAULT_DOMAIN_SKILL_ID=pi-domain-proposal`；live binary 审计同时发现
  compiled `repo` root 不存在，Registry 因而改为在 `PI_PACKAGE_DIR` 环境中读取 installer 已复制的 canonical `skills/`；
- 生产代码的剩余缺口只有 domain run legacy 双读，以及 MCP tool/resource 在无 transport 时执行 inline output/content 的分支。

Issue/Run/Event 中命中 `fixture-domain` 的其他行来自 backlog 描述、历史 Evidence 或审计投影，不是可执行配置，必须保留而不能按字符串批量删除。

## 退出决策与迁移

- Skill source of truth 仍是 repo-local `skills/pi-domain-proposal/{SKILL.md,manifest.json}` 与 allowlisted builtin handler；binary 安装只复制并读取同一目录资产，无第二 runtime、双写或双读。
- `051_remove_production_fixtures` 只迁移可执行配置：Automation 的 domain step 与 skill-scoped Memory 改用 `pi-domain-proposal`。
- legacy domain run 不改写原 append-only event；迁移追加 `skill_runtime.completed`/`legacy-domain-proposal` 投影并记录 `migration_source_event_id`，随后 API 删除 legacy event reader。
- MCP tool/resource 必须有真实 transport；无 transport 即返回既有 `mcp_server_unavailable`，不会读取 registry 中的 `output`、`content`、`fixture`、`call` 或 `invocation` 作为执行结果。
- Skill manifests fixture 移到 `backend-ts/test-fixtures/pi-skills`，仅由测试显式 root 加载；默认 Registry 和 binary 不加载该目录。

## 回滚与最终门禁

- 数据迁移是 forward-only；原 legacy event 保持不变，新增投影可按 `actor=migration` 和 `migration_source_event_id` 审计。
- 回滚到迁移前 binary 不要求反写数据：`pi-domain-proposal` 已由 P06.12 支持，真实 MCP transport 记录不变；不得重新启用 inline fixture execution。
- 删除完成门禁为：相关 Skill/API/MCP/migration tests 通过、生产路径 fixture ID 检查归零、binary build/smoke 通过、scoped diff/commit 复核通过。
