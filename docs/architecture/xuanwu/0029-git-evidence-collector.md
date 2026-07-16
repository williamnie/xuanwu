# ADR-XW-0029：Git 状态、Diff 与 Revision Evidence collector

- 状态：Accepted
- 日期：2026-07-16
- 路线 issue：XW P04.03 / Runner #665
- 依赖：[ADR-XW-0027](0027-evidence-domain-contract.md)
- 可执行 collector：`backend-ts/src/domain/evidence/gitCollector.ts`
- canonical 级别：本文定义一次只读 Git snapshot 到 `EvidenceRecord(kind=git)` 的收集边界；Evidence schema、状态和完成门禁资格继续以 ADR-XW-0027 与 `contracts.ts` 为准

## 1. 当前运行态与边界

现有 P04.01 合同已注册 `git + git_repository`，P04.02 command collector 只投影已经发生的 shell/test/lint/build observation；仓库内没有可复用的结构化 Git revision/status/diff collector。`issueSupervisorContextSupport.ts` 的 `gitStatusSummary()` 仍是 Guardian 恢复路径的轻量进展 heuristic，发布脚本中的 `git rev-parse/status` 只服务包版本标记；两者都不具备完整 revision/base/diff/provenance，不能直接冒充验证 Evidence，本期也不改写其运行路径。

P04.03 新增 provider-neutral 的只读 collector。调用方显式提供项目 Git working-tree root、可选的运行起点 `base_revision`、Evidence/Work/Run/Audit context 和 untracked policy；collector 直接以参数数组调用 Git，不执行 shell，不写 index/object/ref，不修改 Issue/Work/Run 状态，也不决定 dirty tree 是否允许完成。P04.06 才按 workflow policy 判断 revision freshness/cleanliness，P04.07 才把判断接到 done mutation。

## 2. Snapshot 合同

一次成功收集产生 terminal `EvidenceRecord(kind=git,status=passed)`；`passed` 只表示 Git authority 被成功读取和结构化，不表示仓库 clean 或 workflow 验证通过。Git command、输出上限、schema/redaction 任一失败都 fail closed，不生成伪造的 blocked/passed Evidence。

稳定 facts 包括：

- `head_revision/head_ref/is_unborn/is_detached`；HEAD 使用完整 40/64 位 object id，unborn 时 revision 为 null 但保留 symbolic branch；
- `base_revision/revision_changed_from_base`；调用方提供的 base 必须是完整、仓库内可解析的 commit id，未提供时以收集时 HEAD 为 base，避免把可变 branch name 当基线；
- `working_tree_dirty/tracked_dirty`、staged/unstaged/conflict/untracked counts；
- `changed_paths_json/working_tree_paths_json`、path counts；changed paths 是 base→当前 tracked worktree diff 与 status paths 的稳定并集；
- `changed_file_details_json`：manifest v2 的逐文件 path、tracked numstat、binary 标记和当前 worktree `lstat` size；untracked/非 diff path 的 numstat/binary 为 null，删除文件或 submodule 的 size 为 null，不伪造未知值；
- `diff_changed_file_count/insertions/deletions/binary_file_count`；有 base 时 scope 为 `base_to_worktree_tracked`，unborn 时为 `index_to_unborn`；untracked 内容不虚构行数；
- `snapshot_sha256`：canonical snapshot manifest 的指纹，用于比较两次 observation，不替代 Git object id 或 artifact availability。
- `pathspec_scope/pathspec_count/pathspec_sha256`：默认 `repository`；P05.03 显式提供 literal selected pathspecs 时为 `selected_paths`，保存 scope 数量与 canonical digest，exact scope 继续由同一 audit intent 持有，不能把 scoped Evidence 冒充整仓 snapshot。

因此 clean 分支切换仍能被证明：working tree 可保持 clean，但只要 HEAD 与给定 base 不同，revision 和 base diff 都会记录。unborn repository 也作为合法 Git 状态收集，不把缺失 HEAD 误判为命令失败。

## 3. ignored、untracked 与 changed-path overflow

- `ignored_policy` V1 固定为 `exclude`，collector 显式使用 `--ignored=no`，忽略文件不会进入 dirty/path/count 或 artifact；
- `untracked_policy=include_all`（默认）递归记录所有 untracked paths，并纳入 dirty/path/count；`exclude` 使用 `--untracked-files=no`，此时 `untracked_count=null` 表示未观察，不能伪造为 0；
- diff stat 只统计 Git 可比较的 tracked/index 内容；untracked path 会出现在 changed paths，但只读取当前 path 的 `lstat` 元数据，不读取内容、也不计入 insertions/deletions/binary count；symlink 不跟随 target；
- changed-file/path JSON 任一超过 Evidence inline 8 KiB 上限时必须提供 `GitEvidenceArtifactStore`，否则拒绝收集，不静默截断。文件系统 store 写 content-addressed、redacted manifest v2 JSON report，目录 `0700`、文件 `0600`，Evidence 保留 sha256；inline facts 改为 null 并以 `changed_paths_inline=false` 指向 artifact。

## 4. 读取范围与执行约束

collector 只接受带 `.git` marker 的显式 working-tree root，不从子目录向父级发现 repository，也不扫描 sibling/home/credential store。所有 Git 调用固定 `-C <validated-root>`，关闭 system/global config、terminal prompt、optional locks、pager、fsmonitor、hooks 和 external diff/textconv，并只继承执行 Git 所需的最小环境。Git 输出有总量上限。

这些限制避免任务外 HOME/config、外部 diff/textconv/fsmonitor/hook 被动扩大读取或执行范围。repository 自身 `.git` metadata、index、refs、tracked attributes 和显式 policy 下的 worktree status 仍是本 collector 必需且唯一的读取范围。

## 5. Provenance、authority 与审计

- provenance 固定 `assertion_origin=system_observation`、`source_kind=git_repository`；调用方提供 opaque `source_ref`、append-only `audit_event_ref` 和 producer；
- Evidence 不保存绝对 repository path，避免把本机目录变成公共语义；authority mapping 由 project/run audit context 持有；
- Git repository/object/index/worktree 是事实 source of truth；structured Evidence 是带 provenance 的 observation，不反向改写 Git；
- artifact store write 携带 evidence/source/audit ref，仍须由调用方在现有 append-only audit 边界持久化 intent/outcome；LLM/Agent narrative 无法改写 collector facts 或绕过 P04.06/P04.07 确定性门禁。

## 6. 兼容、回滚与删除门禁

- **W1 写入：** 新 verification step 对一次 Git snapshot 只产生一条 structured Evidence；当前 `issue.log`、provider prose、发布脚本 revision label 与 `VerificationEvidenceV0` 不双写为竞争 authority。本期双写窗口为 0。
- **双读：** V0/current event 继续按 ADR-XW-0027 的 W1/W2 最多两个正式 release window 兼容读取，但 legacy import 不能满足门禁；P05.02 builder 可读取旧 manifest v1/path-only Evidence，并显式标记逐文件 metadata 不可用。Git Evidence 始终回到 Git provenance，不从旧 summary 反推。
- **回滚：** 停用 Git collector/policy consumer，恢复当前 Git/event/V0 读取；保留已生成的 additive Evidence/audit/artifact，不删除或反写 repository。
- **最终删除门禁：** 仍须 P11.03/P11.06、G7、所有 provenance/audit consumer 映射完成、legacy producer/consumer 连续一个正式 release 为零、fixture 留档和 artifact/raw-event 恢复演练通过。本 issue 不删除发布脚本 Git 读取、V0、raw event 或 Git authority。

## 7. 验证

```bash
cd backend-ts
bun test src/domain/evidence/gitCollector.test.ts src/domain/evidence/contracts.test.ts
bunx tsc --noEmit --pretty false
```

真实临时 Git fixtures 覆盖 clean、dirty（staged/unstaged/untracked/ignored）、untracked exclude、unborn、branch switch 和 changed-path overflow artifact；scope fixture 证明不会从子目录发现父仓库，隔离 HOME config 的 fsmonitor 不会被加载。
