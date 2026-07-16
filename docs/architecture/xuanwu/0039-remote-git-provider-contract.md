# ADR-XW-0039：Remote Push 与 Pull Request Provider 合同

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P05.04 / Runner #675
- 硬依赖：XW P05.01 / #672（`done`）、XW P05.03 / #674（`done`）
- 可执行合同：`backend-ts/src/integrations/git/remoteProvider.ts`
- contract tests：`backend-ts/src/integrations/git/remoteProvider.test.ts`

## 1. 决策与边界

`RemoteGitProvider` 是 P05 Handoff 对 remote Git/PR 的唯一 provider port。它以 `provider_id` 和
`contract_version=1` 发现实现，统一提供 `pushBranch`、`createPullRequest`、`updatePullRequest`、
`readPullRequest`；请求和结果不暴露 GitHub/GitLab wire type。P05.05 必须实现本 port，不得在
Handoff service、HTTP route 或 Workflow 中另写 `gh`、`glab`、GitHub REST/GraphQL 或 GitLab API 旁路。

本期只定义并以 fake provider 执行合同，不接真实 remote、不解析现有 connector、不执行 push/PR、
不新增 DB/schema/public API/shared state machine，也不修改 P05.01 `HandoffRecord`。P05.03 local branch/commit
仍是 remote 写入的前置 artifact；P05.05 才负责 adapter、credential resolve、provider request 与 outcome audit。

## 2. Source of truth 与结构化结果

- 本地 Git repository/commit/ref 继续是 local branch、tree 与 commit authority。
- remote Git provider 继续是 remote branch、PR lifecycle/readiness、URL 和 request/rate-limit authority。
- P05.01 Handoff 是引用上述事实及 audit 的可重建 projection，不反向改写 Git/provider/Work status。
- `issues`/Work service 继续拥有 Work status；provider success 不等于 Work `done`。

`RemoteGitPushResult` 固定目标 commit、remote branch/ref、before revision 与
`created|updated|unchanged`。Push 请求必须给出 `expected_remote_revision`；`null` 表示预期 remote branch
不存在，adapter 必须用 compare-and-set/lease 等价语义防止覆盖并发 remote 更新，不提供无条件 force。

PR 把 `lifecycle=open|closed|merged` 与 `readiness=draft|ready` 分开，避免把“ready for review”误当成
merged/closed。Create 固定 base/head/head revision、title/body 和初始 readiness；update 是显式 patch；read
返回 provider 当前事实。Labels/reviewer refs 是 provider-neutral opaque values，具体翻译属于 P05.05。

## 3. Auth ref 与 secrets 边界

每个调用只携带闭合的 `RemoteGitAuthRef={kind:"secret_ref",provider_id,ref}`。`ref` 是现有 secret/config
authority 的定位符，不是 token；请求、result、Handoff、audit 和 error 不得加入 token/password/private key
字段。共享 runtime guard 在 credential resolve **之前**拒绝额外 auth 字段及 provider mismatch。

P05.05 的 adapter 可以在最后一跳按 ref 取得最短生命周期 credential，但不得把 credential 放回 request、
provider response、idempotency receipt、exception message 或 audit facts。统一 secrets storage/migration 仍由后续
安全 issue 承接；本期不复制第二套 vault/config，也无 credential 双写。

## 4. 外部写门禁与审计

所有 push、PR create/update 请求必须带 `RemoteGitWriteContext`：同一 Work/Handoff、actor、correlation、
pre-write intent event、idempotency key，以及 `deterministic_policy|human_approval + allow + policy_ref`。
runtime guard 对对象做闭集校验，`ask|deny`、LLM authority、非法 Work/Handoff ID 均 fail closed。

此 context 是调用契约，不是新的 permission authority。P05.05 orchestration 必须在每次尝试前重新读取现有
project policy/approval authority，先持久化 intent，再调用 provider，最后把 provider request ref、before/after、
rate limit 与 success/failure 写入现有 audit carrier。LLM 只能提出操作 payload，不能构造可信 `allow`、伪造
provider response，或以相同 idempotency key 改写 mutation。

## 5. Idempotency

写操作按 `provider_id + repository_ref + operation + idempotency_key` 建立 receipt：

1. 第一次调用把 key 与 canonical mutation fingerprint 绑定，并保存脱敏 result/ref；
2. 相同 key、相同 mutation 重试返回原 artifact，`idempotency.replayed=true`，不得再次 push/创建/更新；
3. 相同 key、不同 mutation 必须抛 `RemoteGitIdempotencyConflictError`，不得采用后来的 payload；
4. provider timeout/response loss 后仍用原 key 重试；不得靠 title/head 搜索猜测“可能是同一个 PR”。

Fake contract test 证明重复 `createPullRequest` 只创建一个 PR，并覆盖 push replay、key collision、draft → ready
update/read。P05.05 的每个 adapter 必须复用同一套 contract tests，并补 response-loss replay fixture。

## 6. Error 与 rate limit

`RemoteGitProviderError` 的稳定 kind 为 `auth|permission|not_found|validation|conflict|idempotency_conflict|
rate_limit|temporary|permanent`，并携带 operation、可选 status/request ref/rate-limit metadata；只有
`rate_limit|temporary` 默认 `retryable=true`。`RemoteGitRateLimitError` 暴露 `retry_after_seconds`，成功响应也可
返回 limit/remaining/reset/resource，供现有 PI/Guardian recovery 映射；provider contract 本身不 sleep、不自动
无限重试、不改变 Issue 状态。

Error message 在边界统一经过现有 redaction；raw provider body/headers 不属于 error/Handoff contract。P05.05
必须把 401/403、404、409/422、429、5xx/network 映射到稳定 kind，并服从 provider `Retry-After`/reset，不能
用通用重试掩盖 permission、validation 或 idempotency conflict。

## 7. 兼容、迁移、回滚与删除门禁

- **本期 source of truth：** local Git、remote provider、现有 secret/config 和 audit carrier 各自 authoritative；
  本 port/fake 只定义边界，不持久化事实。
- **本期双写/双读窗口：** 0。没有 remote adapter、真实 provider write、Handoff repository 或 legacy 路径改写。
- **P05.05 接线：** provider adapter 仅在显式选择 audited Handoff remote workflow 时启用。正式 Handoff authority
  切换仍受 migration plan G4/W1/W2；shadow window 内旧路径 primary，new result 保存 provenance/parity/mismatch。
- **回滚：** P05.05 可停止注册/调用 remote provider，保留已发生 remote artifact 与 audit，回到 local
  `branch_commit` Handoff；不得删除 remote branch/PR 或反写 Work 来伪装回滚。
- **最终删除门禁：** 仅 P11.03/P11.06 + G7、GitHub/GitLab contract parity、idempotency/rate-limit/auth/error
  fixtures、artifact/audit restore rehearsal、legacy remote writer 连续一个正式 release 为零后，才能删除旧 writer
  或 compatibility reader。本 issue 不删除任何旧路径。

## 8. 验证

```bash
cd backend-ts
bun test src/integrations/git/remoteProvider.test.ts
bunx tsc --ignoreConfig --noEmit --target ES2022 --module ESNext \
  --moduleResolution Bundler --allowImportingTsExtensions --strict \
  --skipLibCheck --lib ES2022 --types bun \
  src/integrations/git/remoteProvider.ts src/integrations/git/remoteProvider.test.ts
```

Focused tests 必须至少证明：接口包含 push/PR create-update-read；draft/ready 可往返；重复 create 不产生重复
PR；key collision fail closed；raw credential field 与非可信授权被拒绝；rate-limit metadata/error 可恢复且不回显
token/path。
