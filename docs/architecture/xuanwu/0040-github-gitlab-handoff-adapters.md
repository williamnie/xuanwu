# ADR-XW-0040：GitHub / GitLab Handoff Adapters

- 状态：Accepted
- 日期：2026-07-17
- 路线 issue：XW P05.05 / Runner #676
- 硬依赖：XW P05.04 / #675（`done`）
- provider port：`backend-ts/src/integrations/git/remoteProvider.ts`
- GitHub adapter：`backend-ts/src/integrations/github/provider.ts`
- GitLab adapter：`backend-ts/src/integrations/gitlab/provider.ts`

## 1. 决策与边界

GitHub、GitLab 都只实现 ADR-XW-0039 的 `RemoteGitProvider`，不得在 Handoff service、HTTP route、PI tool
或 workflow 中另写 `gh`、`glab`、REST/GraphQL 旁路。本 issue 提供 adapter，并把 connector input 加入现有
`RunnerConfig.integrations`；不新增公共 API、DB/schema、共享状态机或 Handoff repository，P05.08 才注册 provider
并把该 port 接入 Handoff API/UI/通知。

- push 使用受控 `git` CLI：只把指定 `commit_ref` 推到指定 `refs/heads/*`，以
  `--force-with-lease=<ref>:<expected>` 实施 compare-and-set；无条件 force 不可用。
- PR/MR create-update-read 使用 provider API。GitHub readiness 使用官方 GraphQL
  `markPullRequestReadyForReview` / `convertPullRequestToDraft`；GitLab readiness 使用官方 draft title 语义。
- GitHub `reviewer_refs` 是 login；GitLab `reviewer_refs` 是 numeric user ID string。它们继续通过同一个
  provider-neutral `string[]` contract 传递。
- `buildHandoffPullRequestBody` 确定性组合 summary、branch/commit、验证、review、tracker update 和 status link；
  adapter 只附加隐藏的 hashed idempotency marker，读取时会移除 marker。

参考 provider authority：

- GitHub REST pull request / review-request API：<https://docs.github.com/en/rest/pulls>
- GitHub GraphQL pull request mutations：<https://docs.github.com/en/graphql/reference/pulls>
- GitLab Merge Requests API：<https://docs.gitlab.com/api/merge_requests/>
- GitLab draft/ready 语义：<https://docs.gitlab.com/user/project/merge_requests/drafts/>

## 2. Connector config 与 secrets 边界

现有 `loadConfig` 从 environment / `runner-settings.local.json` 构造 `buildGitHubConnectorConfig`、
`buildGitLabConnectorConfig`；但 provider request、response、receipt、audit、PR body 和 error 只携带
`RemoteGitAuthRef`，不携带 token。

| Provider | credential input | default auth ref | API/base inputs |
| --- | --- | --- | --- |
| GitHub | `GITHUB_TOKEN` | `env://GITHUB_TOKEN` | `GITHUB_API_URL`, `GITHUB_GRAPHQL_URL`, `GITHUB_SERVER_URL` |
| GitLab | `GITLAB_TOKEN` | `env://GITLAB_TOKEN` | `GITLAB_API_URL`, `GITLAB_SERVER_URL` |

Adapter 在最后一跳校验 `provider_id + token_ref` 后取得 token；token 只进入 HTTP authorization header 或 Git child
process 的 `http.extraHeader` environment，不进入 argv。Config status 只输出 configured boolean 与 auth locator；
redacted config 把 token 变为 `[redacted]`。统一 vault、rotation、short-lived credential 和 secrets migration 由后续安全
issue 承接，本 issue 不创建第二套 secret store，也没有 credential 双写。

## 3. 权限与 audit

每个外部写在 credential resolve 前执行 `assertRemoteGitWriteContext`，只接受已有
`deterministic_policy|human_approval + allow`；LLM/ask/deny fail closed。Factory 强制注入：

1. `RemoteGitAdapterAuditSink`：write 前记录 `handoff.remote_git.attempt.v1`，结果记录
   `handoff.remote_git.outcome.v1`；facts 只包含 Work/Handoff/correlation/intent ref、provider/repository/target、
   outcome、request ref、rate limit 和 retryability，不包含 title/body/token。
2. `RemoteGitMutationReceiptStore`：生产调用方必须把 receipt 接到现有 durable audit/idempotency carrier；
   `createMemoryRemoteGitMutationReceiptStore` 仅供 focused test 和短生命周期 sandbox 明确使用，避免默认为生产持久化。

Read 不改变 provider 状态，因此没有 write audit；其 request ref / rate limit 仍在返回 contract 中。

## 4. Safe retry、response loss 与 rate limit

写 receipt key 为 `provider + repository + operation + idempotency key` 的 canonical hash，value 仅保存 mutation
fingerprint 与脱敏 provider response。同 key / 同 fingerprint 返回 `replayed=true`；同 key / 不同 fingerprint 抛
`RemoteGitIdempotencyConflictError`。

Create 在 PR/MR body 中保存 key hash 与 mutation fingerprint，不保存 raw key。若 POST 已成功但 response 丢失，
重试按 base/head 缩小 provider 查询，再以 marker key **精确匹配**；fingerprint 相同才恢复，fingerprint 不同 fail
closed，因此不是靠 title/head 猜 artifact。Push response 丢失时重读 remote ref，只有目标 ref 已精确等于
`commit_ref` 才恢复。Update 重试先读取当前 provider fact，patch 已完全满足才作为 replay；生产跨进程 key collision
仍以注入的 durable receipt 为 authority。

HTTP 401/403/404/408/409/422/429/5xx/network 分别映射到 ADR-XW-0039 稳定 error kind；429（及 GitHub
remaining=0 的 403）返回 `RemoteGitRateLimitError` 与 `Retry-After`/reset metadata。Adapter 不 sleep、不做无界自动
重试、不修改 Issue/Work status。Provider body、network error、Git stderr 在进入 error/audit 前统一脱敏。

## 5. Source of truth、迁移、回滚与删除门禁

- **当前 source of truth：** local repository/commit 负责本地 Git 事实；GitHub/GitLab 负责 remote ref、PR/MR、
  labels/reviewers/readiness/lifecycle/URL；现有 policy/approval 与 audit carrier 负责权限、intent、receipt 和 outcome；
  Handoff 仍是引用这些事实的 projection，provider success 不改变 Work status。
- **双写/双读期限：** 本 issue 为 0。Adapter 尚未注册到 live Handoff workflow，不替换 legacy writer，不写
  Handoff/Issue/Work；P05.08 接线后仍遵守 migration plan G4 与 W1/W2 shadow/parity 窗口。
- **回滚：** 停止 provider 注册/调用并回到 P05.03 `branch_commit`；保留 remote artifact、receipt 与 audit，禁止删除
  branch/PR/MR 或反写 Work 来伪装回滚。
- **最终删除门禁：** 仅 P11.03/P11.06 + G7、GitHub/GitLab contract parity、durable receipt restore、auth/error/
  rate-limit/response-loss fixtures、artifact/audit restore rehearsal、legacy writer 连续一个正式 release 为零后，才能删除
  compatibility path。本 issue 不删除旧路径。

## 6. Focused verification

```bash
cd backend-ts
bun test \
  src/config/env.test.ts \
  src/integrations/git/remoteProvider.test.ts \
  src/integrations/git/pullRequestBody.test.ts \
  src/integrations/github/provider.test.ts \
  src/integrations/gitlab/provider.test.ts

bunx tsc --ignoreConfig --noEmit --target ES2022 --module ESNext \
  --moduleResolution Bundler --allowImportingTsExtensions --strict \
  --skipLibCheck --lib ES2022 --types bun \
  src/integrations/git/remoteProvider.ts \
  src/integrations/git/adapterSupport.ts \
  src/integrations/git/pullRequestBody.ts \
  src/config/env.ts src/config/localSettings.ts \
  src/integrations/github/config.ts src/integrations/github/provider.ts \
  src/integrations/gitlab/config.ts src/integrations/gitlab/provider.ts
```

Fixtures 证明 GitHub/GitLab create response-loss 只形成一个 PR/MR、draft → ready、labels/reviewers、read round-trip、
429 metadata 与 token/path redaction。GitHub test 另以真实 `git` CLI + 临时 local bare repository 执行 sandbox push，
证明 compare-and-set 与重复 request replay；不会访问真实外部 provider。
