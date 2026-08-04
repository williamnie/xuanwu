# ADR-XW-0045：Supervisor Runtime 受控资源装配

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P06.02 / Runner #681
- 硬依赖：XW P06.01 / #680、XW P00.06 / #636（均 `done`）
- 可执行实现：`backend-ts/src/http/piRuntimeResources.ts`
- Runtime 接入：`backend-ts/src/http/piRuntime.ts`
- 部署装配：`scripts/install-launchd.sh`
- canonical 级别：本文与 `createPiRuntimeResourceLoader()` 共同构成 PI SDK agents、prompts、skills、extensions discovery、allowlist、reload、diagnostics 和 failure isolation 的 source of truth

## 1. 决策

删除 `piRuntime.ts` 中始终返回空数组的 `emptyResourceLoader`。Supervisor 继续使用同一个 PI SDK `AgentSession`，但改由受控 `ResourceLoader` 装配真实资源，不建立第二套 session、tool registry 或 skill runtime。

资源来源只允许以下确定性根：

1. 当前 project 的 `.pi/` 与 project 根 `AGENTS.md`；
2. Runner state 内的 `pi-runtime/agent/` 与其中的 `AGENTS.md`；
3. 当前 Runner source/runtime root 的 `skills/`、`prompts/`、`extensions/`；
4. `PI_PACKAGE_DIR` 中随编译部署复制的 PI package assets；
5. 上述根内 `plugins/<package>/` 声明的本地 PI package 资源。

不读取用户 home 下的默认 PI/Codex resource roots，不安装 npm/git package，不因 settings/package 缺失发起网络或外部写。`package.json#pi` 只接受留在 package root 内的资源条目；绝对路径、`..` traversal 和 symlink escape 会使对应 source/resource fail closed。

## 2. 各资源的门禁

### agents

只加载 project 根和 runtime agent 根的精确 `AGENTS.md`，不向父目录爬升。文件必须是普通文件且不超过 128 KiB；读取失败只形成 warning diagnostic。

### skills

文件 discovery 先受资源根约束，随后还必须命中现有 project / issue / delegation skill policy 的有效交集。`buildSkillPromptContext()` 仍是授权语义的 source of truth；SDK loader 只消费其 authorized/missing IDs，不复制另一套权限算法。未命中的 skill 被诊断并从 SDK prompt/command resources 移除。

本期仍遵守 P06.01 的边界：skill 作为 prompt metadata 和显式命令资源装配，不成为可越权的执行 runtime；可执行 Skill Runtime、input/output schema、tool grants 与 run history 由 P06.12 交付。

### prompts

只加载 allowlisted package root 的 `prompts/` 或安全 `package.json#pi.prompts` 条目。模板内容不会替换 canonical Supervisor system prompt；它只能经 PI SDK 的显式 prompt-template 流程使用。

### extensions

只枚举 allowlisted root 内、大小不超过 512 KiB 且能由 Bun 预解析的 `.ts/.js/.mjs/.cjs`。坏语法在进入 SDK importer 前被隔离，避免同一坏文件令 in-process reload 卡住；extension 初始化错误继续使用 SDK 的 per-file error isolation。

Extension handler/command 可以装配，但 extension 注册的 LLM tool 和 provider registration 在本期被确定性清空并记录 diagnostic。它们必须先接入统一 tool/provider permission adapter，不能因 SDK reload 的默认行为绕过 `PI_ALLOWED_TOOLS`、Action Gate 或 audit。

## 3. reload、diagnostics 与 prompt summary

`ControlledPiResourceLoader.reload()` 每次重新 discovery 并创建新一代 SDK loader。资源代次、来源、各类 loaded name/count、diagnostics 与 `loaded|fallback` outcome 写入 append-only `pi_action_events`，事件类型为 `runtime_resource_snapshot`。公开 payload 使用 root label 和相对路径，不回显绝对 fixture/state 路径或 secret。

坏 skill、坏 prompt、坏 extension、manifest 越界和 allowlist miss 只移除对应资源；若 SDK loader 本身发生非预期 reload 异常，则切到只保留 canonical Supervisor prompt 的 core-only fallback，使 runtime 可继续启动并留下 error diagnostic。Extension `resources_discover` 的追加路径再次经过相同 root allowlist。

有效 system prompt 追加紧凑的 `Controlled PI resource summary`，只包含计数、受控名称、diagnostic 数量、generation 和 outcome，不注入 resource body 或 error stack。完整诊断留在审计事件中。

## 4. 编译部署资产

Source mode 从 Runner root 读取内置 `skills/`。编译二进制部署时，`scripts/install-launchd.sh` 把同一目录（以及存在时的 `plugins/`）复制到 `PI_PACKAGE_DIR`，与 PI SDK package assets 一起原子部署。这样 source/binary 使用同一份内置资源内容，不要求 binary 内另建硬编码副本。

## 5. 兼容、迁移、回滚与删除门禁

- **状态 authority 不变**：Work、Run、Evidence、Handoff、tool permission 与 audit 仍由现有 SQLite/services 拥有；resource file 从不成为业务状态 source of truth。
- **双写：0；双读：0**：新 loader 直接替换空 loader，没有 legacy/new resource winner 选择，也不新增 schema、API、state machine 或 provider adapter。
- **兼容窗口**：core-only loader 只作为单次 catastrophic reload 的 fail-closed fallback，不是并行产品路径；每次使用都必须有 `outcome=fallback` diagnostic/audit。
- **回滚**：回滚 `piRuntimeResources.ts` 接入与部署 asset copy 即可；没有数据迁移。已写 audit 继续保留，不做 destructive cleanup。
- **最终删除门禁**：只有正常/空/坏 fixtures、compiled binary smoke、至少一个真实 project resource smoke、reload 与 permission regression 连续通过，且 P06.12/P10.05 对可执行 skill/extension trust boundary 有替代门禁后，才可删除 core-only fallback 或放宽当前 extension tool/provider block。

## 6. 验证合同

最小门禁：

```bash
cd backend-ts
bun test src/http/piRuntimeResources.test.ts
bun test src/http/piRuntimeSmoke.test.ts --test-name-pattern 'injects only authorized skill metadata'

cd ..
node --test scripts/install-launchd.test.mjs

cd backend-ts
bun run build:binary
../dist/xuanwu --version
```

Fixtures 必须至少覆盖：空资源、正常 agents/prompts/skills/extensions、未授权 skill、坏 skill、坏 extension、PI package asset、plugin package、reload 后新增资源，以及 extension 动态越界路径被拒绝。
