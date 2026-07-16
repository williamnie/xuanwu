# ADR-XW-0038：本地 Branch 与 Commit Handoff

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P05.03 / Runner #674
- 硬依赖：XW P05.01 / #672（`done`）、XW P05.02 / #673（`done`）、XW P04.07 / #669（`done`）
- 可执行实现：`backend-ts/src/domain/handoff/localBranchCommit.ts`
- 共享 Git adapter：`backend-ts/src/domain/git/adapter.ts`

## 1. 决策与 authority

`createLocalBranchCommitHandoffService()` 把一次本地交付固定为：project policy preflight → scoped Git Evidence → audit intent → isolated index staging → commit object → CAS branch ref → audit outcome → P05.01 `HandoffRecord`。Git repository 继续是 branch、tree、commit 和 diff 的唯一 source of truth；P04 Git Evidence、P05.02 Diff Summary、Handoff 与 audit event 都是带 provenance 的可重建 projection，不能反向改写 Work status。

本期只实现 `branch_commit`，不 push、不创建 PR、不更新 tracker、不 deploy/release，也不新增 Handoff table、public route、provider adapter 或共享状态机。P05.08 接线前，service 返回的 Handoff/Evidence 由调用方显式持有；不得另建临时 JSON authority。

## 2. Project policy 与 branch naming

service 只通过构造时注入的 `LocalGitHandoffProjectPolicyReader` 读取已解析 policy，并提供 `resolveLocalGitHandoffProjectPolicy()` 从现有 project policy 的 `allowed_actions_json` 解析权限。执行 request 只携带 `project_id`，不能携带或覆盖 policy。只有 authority reader 返回显式包含 `handoff.commit` 的 policy 才能执行；LLM/请求 payload 不能自报 `allow`。policy 还固定：

- `policy_ref` / `project_id`；
- allowed base branches；
- lowercase branch namespace prefix；
- `never | same_baseline` reuse 语义；
- commit subject prefix/byte limit；
- author/committer identity。

branch 名由 `branch_prefix + Work local id + normalized Work title` 确定性派生，并再过 `git check-ref-format --branch`。reuse 只允许未在任何 worktree checkout、且 ref 仍精确指向当前 baseline 的 branch；diverged、checked-out、detached HEAD、冲突 worktree 或 policy 不允许时 fail closed。

## 3. Preflight、dirty baseline 与 scoped staging

preflight 记录当前 attached branch、完整 HEAD、porcelain dirty baseline digest、dirty/staged count、target ref 是否已存在。已有 staged、unstaged、untracked 改动允许存在，但 conflict 不允许。

scoped commit 不调用真实 index 上的 `git add`/`git commit`：

1. P04 Git collector 以 literal selected pathspecs 和固定 baseline 收集 scoped Evidence；
2. 临时 `GIT_INDEX_FILE` 从 baseline `read-tree`，只对 selected paths 执行 `git add -A`；
3. staged path list 必须与 fresh P05.02 `changed_files` 完全一致；
4. `write-tree` + `commit-tree` 创建单 parent commit，并重新校验 commit tree 与 selected worktree freshness；
5. 最后才用 old-value CAS `update-ref` 创建/前移 target branch。

target branch 不自动 checkout。成功后 active branch、真实 index、staged intent 与全部 worktree bytes 保持原样；因此已有脏改不会被 commit、unstage、stash、reset 或丢弃。用户可在处理现有 baseline 后显式切换到交付 branch。Git command adapter 固定关闭 global/system config、prompt、pager、fsmonitor、external diff、hooks，并只接受 argv，不经过 shell。

## 4. Commit contract、Evidence 与审计

commit subject 必须是单行、无 NUL/首尾空白、满足 policy prefix 与 UTF-8 byte limit；identity 只来自 resolved policy。结果记录 full 40/64-character commit revision、branch ref、baseline、tree verification 与 exact changed files。

state mutation 前必须成功写 `handoff.local_git.intent.v1`；branch CAS 后必须成功写 `handoff.local_git.outcome.v1`。intent 关联 scoped Git Evidence id/snapshot、selected files、dirty baseline digest 与 policy；outcome 关联 exact commit、Handoff id、before/after ref。service 要求 audit sink，不能由模型叙述替代。P05.01 commit delivery action 引用 outcome event，`Handoff.evidence_ids` 引用 fresh Git Evidence 与调用方提供的同 Work Evidence。

## 5. Failure compensation 与 rollback

- commit/tree/freshness/CAS 失败：真实 index/worktree 未被修改；若 target ref 尚未变更，不需要 ref rollback，记录 failed outcome。
- target ref 已 CAS、但 Handoff validation 或 success audit 失败：使用 exact expected commit CAS 恢复旧 ref；新 branch 则 CAS delete，reused branch 则恢复 baseline，并写 `handoff.local_git.rollback.v1`。
- CAS rollback 因 ref 已被并发修改而失败时绝不强制 reset；错误必须保留并升级 Attention。不可达 blob/tree/commit 由 Git 自身 retention/GC 管理，不扫描或删除 object database。
- 成功 Handoff 的 rollback plan 仍只是一条审计引用与 CAS 计划；后续显式 destructive rollback 必须重新通过当时的权限/approval gate，不能把本次 commit allow 复用为未来 rollback allow。

## 6. 兼容、迁移与删除门禁

- **source of truth：** Git branch/ref/tree/commit authoritative；`issues`/Work service 继续拥有 Work status；`issue_events`/未来 P05.08 writer 持有审计事实。
- **本期双写窗口：** 0。无新 DB/schema/public API；现有 completion adapter、agent 自行 commit 路径与本 service 不双主。调用者只有明确选择 `handoff.commit` workflow 时才执行该 producer。
- **cutover：** P05.08/P06.09 接线时复用本 service、P04 Evidence writer 与既有 deterministic permission carrier；不得复制 shell `git add && git commit` 旁路。正式 authority 切换仍受 plan.json 的 G4/W1/W2 gate 约束。
- **回滚：** 停止调用本 producer 即可；保留 Git refs/commits与 audit，不反写 Evidence/Work。代码回滚不要求数据迁移。
- **最终删除门禁：** 仅 P11.03/P11.06 + G7、所有 Handoff/API/Workflow consumer 完成映射、legacy direct-commit producer 连续一个正式 release 为零，并完成 dirty-baseline/rollback rehearsal 后，才能删除 compatibility producer。

## 7. 验证

```bash
cd backend-ts
bun test src/domain/handoff/localBranchCommit.test.ts \
  src/domain/evidence/gitCollector.test.ts \
  src/domain/handoff/diffSummary.test.ts \
  src/domain/handoff/contracts.test.ts
```

临时仓库 E2E 覆盖：新建 branch、same-baseline reuse、已有 staged/unstaged/untracked baseline 完整保护、selected-only commit、policy deny、`commit-tree` 失败无 side effect，以及 success audit 失败后的 CAS branch rollback。
