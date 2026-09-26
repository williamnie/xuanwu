import { readFile, lstat, readlink, realpath } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { retryIssue } from "../../db/repositories/issueActions.ts";
import { listStoredHandoffs, recordHandoff } from "../../db/repositories/handoffs.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { deliveryScope, readFinalWorkspace } from "../../domain/handoff/acceptedDelivery.ts";
import { observeGitWorkspaceBaseline } from "../../domain/run/gitWorkspaceObservation.ts";
import type { HandoffRecord } from "../../domain/handoff/contracts.ts";
import { startProjectLoop, type ProjectLoopRuntime } from "../../runner/projectLoopManager.ts";
import { fingerprint, auditGitHubCase, getGitHubIssueCase, queueGitHubWrite, updateGitHubIssueCase, type GitHubIssueCase } from "./issueCaseStore.ts";
import { githubRepositoryPath, GitHubIssueClient, GitHubIssueApiError, type GitHubObject } from "./issueClient.ts";
import type { GitHubIssueRepository } from "./issueSyncConfig.ts";
import { readAcceptedGitHubReport } from "./issueWorkflow.ts";
import { publicGitHubSummary } from "./issueOutbox.ts";

type DeliveryManifest = {
  sourceRevision: number; cardFingerprint: string; baseline: string; branch: string; baseBranch: string;
  parent: string; createdAt: string; tree?: string; commit?: string; priorHead: string;
  files: Array<{ path: string; mode: "100644" | "100755" | "120000"; content: string | null }>;
};

/** 通过 Git 对象 API 发布经过验证的文件快照，不切换/重置共享工作区，也不写真实 index。 */
export class GitHubIssueDelivery {
  constructor(private readonly runtime: ProjectLoopRuntime) {}

  async advance(record: GitHubIssueCase, policy: GitHubIssueRepository, client: GitHubIssueClient): Promise<void> {
    if (record.stage === "review") return this.review(record, policy, client);
    if (!policy.allowPullRequest || !policy.allowFix || !record.issue_id) return;
    const db = this.runtime.database;
    const accepted = readAcceptedGitHubReport(db, record);
    if (!accepted || accepted.report.result !== "fixed") throw new Error("GitHub PR requires accepted repair evidence");
    const project = getProject(db, record.project_id);
    if (!project) throw new Error("GitHub delivery project disappeared");
    const handoff = listStoredHandoffs(db, { work_id: `xw:work:issues:${record.issue_id}`, limit: 20 }).items
      .find(item => item.source === "pi-accepted-delivery" && item.handoff.run_ids.includes(`xw:run:issue_runs:${accepted.card.run.id}`))?.handoff;
    const scope = await deliveryScope(db, accepted.card, listIssueRuns(db, record.issue_id)[0]?.id ?? accepted.card.run.id);
    if (!handoff || !handoff.changed_files.length || scope.problems.length || fingerprint(scope.paths) !== fingerprint(handoff.changed_files)) throw new Error("GitHub delivery needs complete attributable file evidence");
    if (handoff.changed_files.length > 100) throw new Error("GitHub automatic delivery is limited to 100 files; explicit review required");
    let manifest = JSON.parse(record.delivery_json) as DeliveryManifest;
    const path = githubRepositoryPath(policy.repository);
    await assertRemoteIntakeCurrent(client, record, policy);
    if (manifest.cardFingerprint !== accepted.card.fingerprint) {
      const terminal = readFinalWorkspace(db, accepted.card);
      const current = await observeGitWorkspaceBaseline({ project_cwd: project.cwd, run_id: accepted.card.run.id });
      if (!terminal || !current || terminal.base_revision !== current.base_revision || terminal.snapshot_sha256 !== current.snapshot_sha256) throw new Error("Workspace changed since verification; new verification is required");
      const repository = (await client.request(path)).data;
      const baseBranch = policy.baseBranch || String(repository.default_branch);
      const base = object((await client.request(`${path}/git/ref/heads/${encodeURIComponent(baseBranch)}`)).data.object);
      if (base.sha !== current.base_revision) throw new Error("Remote base changed; revalidation required before publishing");
      const files: DeliveryManifest["files"] = [];
      let totalBytes = 0;
      for (const relative of handoff.changed_files) {
        if (!relative || relative.startsWith("/") || relative.split("/").some(part => part === ".." || part === ".git") || /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519)$/i.test(relative)) throw new Error("GitHub delivery path is unsafe");
        const full = resolve(project.cwd, relative);
        const parent = await realpath(dirname(full));
        const root = await realpath(project.cwd);
        if (parent !== root && !parent.startsWith(root + sep)) throw new Error("GitHub delivery path escapes repository");
        const metadata = await lstat(full).catch((error) => { if (error.code === "ENOENT") return null; throw error; });
        if (!metadata) { files.push({ path: relative, mode: "100644", content: null }); continue; }
        if ((!metadata.isFile() && !metadata.isSymbolicLink()) || metadata.size > 1024 * 1024) throw new Error("GitHub delivery supports files up to 1 MiB; explicit review required");
        const content = metadata.isSymbolicLink() ? Buffer.from(await readlink(full)) : await readFile(full);
        totalBytes += content.byteLength;
        if (totalBytes > 4 * 1024 * 1024) throw new Error("GitHub automatic delivery is limited to 4 MiB; explicit review required");
        files.push({ path: relative, mode: metadata.isSymbolicLink() ? "120000" : metadata.mode & 0o111 ? "100755" : "100644", content: content.toString("base64") });
      }
      // 读取文件后再次核对快照，避免验证后与上传前之间的变动混入。
      const after = await observeGitWorkspaceBaseline({ project_cwd: project.cwd, run_id: accepted.card.run.id });
      if (!after || after.base_revision !== terminal.base_revision || after.snapshot_sha256 !== terminal.snapshot_sha256) throw new Error("Workspace changed while preparing delivery");
      manifest = { sourceRevision: record.source_revision, cardFingerprint: accepted.card.fingerprint, baseline: current.base_revision,
        branch: `codex/xuanwu-${record.issue_number}-${fingerprint(record.issue_node_id).slice(0, 8)}`, baseBranch,
        parent: record.head_sha || current.base_revision, priorHead: record.head_sha, createdAt: new Date().toISOString(), files };
      record = updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { delivery_json: JSON.stringify(manifest) });
    }
    this.assertCurrent(record, policy);
    if (!manifest.tree) {
      const entries: GitHubObject[] = [];
      for (const file of manifest.files) {
        const sha = file.content === null ? null : String((await client.request(`${path}/git/blobs`, {
          method: "POST", body: { content: file.content, encoding: "base64" }
        })).data.sha);
        if (sha !== null) objectID(sha);
        entries.push({ path: file.path, mode: file.mode, type: "blob", sha });
      }
      const baseTree = object((await client.request(`${path}/git/commits/${manifest.baseline}`)).data.tree);
      manifest.tree = objectID((await client.request(`${path}/git/trees`, { method: "POST", body: { base_tree: objectID(baseTree.sha), tree: entries } })).data.sha);
      this.saveManifest(record, manifest);
    }
    if (!manifest.commit) {
      // 同一文件树的重新验证不创建空提交，避免仅因新报告触发另一轮 CI。
      if (manifest.priorHead) {
        const previous = (await client.request(`${path}/git/commits/${objectID(manifest.priorHead)}`)).data;
        if (object(previous.tree).sha === manifest.tree) manifest.commit = manifest.priorHead;
      }
    }
    if (!manifest.commit) {
      const identity = { name: "Xuanwu", email: "xuanwu@users.noreply.github.com", date: manifest.createdAt };
      manifest.commit = objectID((await client.request(`${path}/git/commits`, { method: "POST", body: {
        message: `fix: address GitHub issue #${record.issue_number}`, tree: manifest.tree, parents: [manifest.parent], author: identity, committer: identity
      } })).data.sha);
    }
    this.saveManifest(record, manifest);
    this.assertCurrent(record, policy);
    await assertRemoteIntakeCurrent(client, record, policy);
    const refPath = `${path}/git/refs/heads/${manifest.branch}`;
    let remoteHead: string | null = null;
    try { remoteHead = objectID(object((await client.request(`${path}/git/ref/heads/${manifest.branch}`)).data.object).sha); }
    catch (error) { if (!(error instanceof GitHubIssueApiError) || error.status !== 404) throw error; }
    if (remoteHead !== manifest.commit) {
      if (remoteHead !== (manifest.priorHead || null)) throw new Error("PR branch changed outside Xuanwu; refusing overwrite");
      await client.request(remoteHead ? refPath : `${path}/git/refs`, { method: remoteHead ? "PATCH" : "POST",
        body: remoteHead ? { sha: manifest.commit, force: false } : { ref: `refs/heads/${manifest.branch}`, sha: manifest.commit } });
    }
    const published = objectID(object((await client.request(`${path}/git/ref/heads/${manifest.branch}`)).data.object).sha);
    if (published !== manifest.commit) throw new Error("GitHub branch publication verification failed");
    const prs = await client.all(`${path}/pulls?state=all&head=${encodeURIComponent(`${policy.repository.split("/")[0]}:${manifest.branch}`)}&base=${encodeURIComponent(manifest.baseBranch)}&per_page=100`);
    let pr = prs.find(item => object(item.head).ref === manifest.branch && String(object(object(item.head).repo).full_name).toLowerCase() === policy.repository.toLowerCase());
    if (pr && pr.state !== "open") throw new Error("Existing PR was closed; new delivery requires a decision");
    if (!pr) {
      await assertRemoteIntakeCurrent(client, record, policy);
      const body = publicGitHubSummary([`Refs #${record.issue_number}`, "", accepted.report.summary, "", "验证：",
        ...accepted.report.regression_commands.map(command => `- ${command}`), "", "玄武已完成本地修复与回归，等待人工评审和合并。",
        "维护者也可在本 PR 新建评论 `/xuanwu revise <完整 head SHA> 具体修改意见` 请求继续；回复只对指定版本有效。"].join("\n"));
      pr = (await client.request(`${path}/pulls`, { method: "POST", body: { title: `fix: address #${record.issue_number}`,
        head: manifest.branch, base: manifest.baseBranch, draft: true, body } })).data;
    }
    if (object(pr.head).sha !== manifest.commit) throw new Error("PR head does not match verified delivery");
    const number = positiveID(pr.number);
    db.transaction(() => {
      this.assertCurrent(record, policy);
      const event = recordIssueEvent(db, record.issue_id!, "github.pull_request_delivered.v1", {
        pull_request_number: number, url: pr!.html_url, commit: manifest.commit, card_fingerprint: manifest.cardFingerprint,
        source_revision: record.source_revision, branch: manifest.branch
      });
      const now = new Date().toISOString();
      const actionBase = { classification: "state_change" as const, required: true, gate: { authority: "deterministic_policy" as const, policy_ref: `github-issue-policy:${fingerprint(policy)}` },
        gate_decision: "allow" as const, outcome: "succeeded" as const, audit_event_ref: `issue_events:${event.id}` };
      const delivered: HandoffRecord = { ...handoff, id: `xw:handoff:derived:github-${record.issue_id}-${manifest.commit}-${manifest.cardFingerprint}`, revision: 0,
        created_at: now, updated_at: now, status: "ready", baseline_revision: manifest.baseline, final_revision: manifest.commit!, review_ref: String(pr!.html_url),
        summary: "已发布经过验证的修复草稿 PR，等待人工评审；尚未合并或发布。",
        delivery: { mode: "draft_pr", branch_ref: `refs/heads/${manifest.branch}`, commit_ref: manifest.commit!, remote_ref: `${policy.repository}#refs/heads/${manifest.branch}`, pull_request_ref: String(pr!.html_url), url: String(pr!.html_url) },
        delivery_actions: [
          { ...actionBase, action: "commit", target: manifest.commit!, after_ref: manifest.commit! },
          { ...actionBase, classification: "external_write", action: "push", target: `${policy.repository}#${manifest.branch}`, after_ref: manifest.commit! },
          { ...actionBase, classification: "external_write", action: "pull_request", target: String(pr!.html_url), after_ref: String(pr!.html_url) }
        ], review: { required: true, state: "pending", reviewer_refs: [], review_ref: String(pr!.html_url) } };
      if (!listStoredHandoffs(db, { work_id: `xw:work:issues:${record.issue_id}`, limit: 100 }).items.some(item => item.handoff.id === delivered.id)) {
        recordHandoff(db, record.issue_id!, delivered, { recorded_at: now, source: "github-issue-delivery" });
      }
      updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { pull_request_number: number, head_sha: manifest.commit!, stage: "review", last_error: "" });
      queueGitHubWrite(db, record, { kind: "progress", repository: record.repository, issueNumber: record.issue_number,
        issueNodeId: record.issue_node_id, sourceRevision: record.source_revision, body: `修复与回归已完成，草稿 PR：${String(pr!.html_url)}\n\n等待评审和合并，尚未上线。` }, `pr:${record.issue_node_id}:${manifest.commit}`);
    }).immediate();
  }

  private async review(record: GitHubIssueCase, policy: GitHubIssueRepository, client: GitHubIssueClient): Promise<void> {
    if (!record.pull_request_number || !record.issue_id) return;
    const db = this.runtime.database;
    const path = githubRepositoryPath(record.repository);
    const pr = (await client.request(`${path}/pulls/${record.pull_request_number}`)).data;
    if (object(pr.head).sha !== record.head_sha) throw new Error("PR head changed outside Xuanwu; evidence must be revalidated");
    const checks = await readGitHubChecks(client, path, record.head_sha);
    if (pr.merged === true) {
      if (checks.pending || checks.failed.length) {
        updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { last_error: "PR merged but CI is pending or failed; Issue remains open" });
        return;
      }
      updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { stage: "resolved" });
      auditGitHubCase(db, record.issue_node_id, record.project_id, "pr_merged", { number: record.pull_request_number, merge_commit_sha: pr.merge_commit_sha });
      if (policy.closeOnMerge) queueGitHubWrite(db, record, { kind: "close", repository: record.repository,
        issueNumber: record.issue_number, issueNodeId: record.issue_node_id, sourceRevision: record.source_revision, body: "", stateReason: "completed" }, `close:${record.issue_node_id}:${record.head_sha}`);
      return;
    }
    if (pr.state === "closed") {
      updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { stage: "paused", last_error: "PR closed without merge" });
      return;
    }
    await assertRemoteIntakeCurrent(client, record, policy);
    if (checks.failed.length && policy.ciFailureMode === "report_only") {
      const reason = publicGitHubSummary(`CI 未通过：${checks.failed.join("、")}。仅记录，不自动重试：${policy.ciFailureReason}。仍等待人工评审；不视为 CI 通过或合并授权。`);
      if (record.last_error !== reason) {
        updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { last_error: reason });
        auditGitHubCase(db, record.issue_node_id, record.project_id, "ci_failure_reported", { head_sha: record.head_sha, failed: checks.failed, reason: publicGitHubSummary(policy.ciFailureReason) });
        queueGitHubWrite(db, record, { kind: "progress", repository: record.repository, issueNumber: record.issue_number,
          issueNodeId: record.issue_node_id, sourceRevision: record.source_revision, body: `草稿 PR：${String(pr.html_url)}\n\n${reason}` },
        `ci-report:${record.issue_node_id}:${fingerprint({ head: record.head_sha, failed: checks.failed, reason: policy.ciFailureReason })}`);
      }
    }
    // 人类针对当前版本的评审优先处理；CI 环境限制不能阻塞有效反馈。
    const retryFailedChecks = () => {
      if (!checks.failed.length || policy.ciFailureMode === "report_only") return;
      const key = fingerprint({ head: record.head_sha, failed: checks.failed });
      const previous = db.sqlite.query("select id from issue_events where issue_id=? and type='github.review_followup.v1' and json_valid(payload) and json_extract(payload,'$.decision_id')=?")
        .get(record.issue_id, `github-ci:${key}`);
      if (!previous) {
        this.continueRepair(record, policy, `github-ci:${key}`, `草稿 PR 的 CI 检查失败：${checks.failed.join("、")}。读取实际失败日志，判断是本次修改、环境故障还是旧失败；仅修复本任务回归，无法自行处理时求助。`, "github-ci", record.review_cursor);
      }
    };
    const reviews = await client.all(`${path}/pulls/${record.pull_request_number}/reviews?per_page=100`);
    for (const review of reviews.sort((a, b) => Number(a.id) - Number(b.id))) {
      const id = positiveID(review.id);
      if (id <= record.review_cursor || review.state !== "CHANGES_REQUESTED" || review.commit_id !== record.head_sha) continue;
      const author = object(review.user);
      const permission = (await client.request(`${path}/collaborators/${encodeURIComponent(String(author.login))}/permission`)).data.permission;
      if (!["admin", "maintain", "write"].includes(String(permission)) || author.type === "Bot") continue;
      const comments = await client.all(`${path}/pulls/${record.pull_request_number}/comments?per_page=100`);
      const feedback = [String(review.body ?? ""), ...comments.filter(item => item.pull_request_review_id === id).map(item => `${String(item.path)}: ${String(item.body)}`)].join("\n").trim();
      if (!feedback) continue;
      this.continueRepair(record, policy, `github-review:${id}`, feedback, String(author.login), id);
      return;
    }
    // 作者不能给自己的 PR 提交 changes_requested review；维护者评论提供同样的显式、版本绑定入口。
    const comments = await client.all(`${path}/issues/${record.pull_request_number}/comments?per_page=100`);
    for (const comment of [...comments].reverse()) {
      const match = /^\/xuanwu\s+revise\s+([a-f0-9]{40}(?:[a-f0-9]{24})?)\s+([\s\S]+)$/.exec(String(comment.body ?? "").trim());
      if (!match || match[1] !== record.head_sha || !match[2]!.trim()) continue;
      const id = positiveID(comment.id);
      const decisionID = `github-pr-comment:${id}`;
      if (db.sqlite.query("select id from issue_events where issue_id=? and type='github.review_followup.v1' and json_valid(payload) and json_extract(payload,'$.decision_id')=?").get(record.issue_id, decisionID)) continue;
      const author = object(comment.user);
      const permission = (await client.request(`${path}/collaborators/${encodeURIComponent(String(author.login))}/permission`)).data.permission;
      if (!["admin", "maintain", "write"].includes(String(permission)) || author.type === "Bot") continue;
      this.continueRepair(record, policy, decisionID, match[2]!, String(author.login), record.review_cursor);
      return;
    }
    retryFailedChecks();
  }

  private continueRepair(record: GitHubIssueCase, policy: GitHubIssueRepository, decisionID: string, feedback: string, author: string, reviewCursor: number): void {
    const db = this.runtime.database;
    db.transaction(() => {
      this.assertCurrent(record, policy);
      recordIssueEvent(db, record.issue_id!, "github.review_followup.v1", { reason: publicGitHubSummary(feedback), decision_id: decisionID, author, head_sha: record.head_sha });
      retryIssue(db, record.issue_id!);
      updateGitHubIssueCase(db, record.issue_node_id, record.source_revision, { stage: "repair", review_cursor: reviewCursor });
    }).immediate();
    startProjectLoop(this.runtime, record.project_id);
  }

  private saveManifest(record: GitHubIssueCase, manifest: DeliveryManifest): void {
    updateGitHubIssueCase(this.runtime.database, record.issue_node_id, record.source_revision, { delivery_json: JSON.stringify(manifest) });
  }
  private assertCurrent(record: GitHubIssueCase, policy: GitHubIssueRepository): void {
    const current = getGitHubIssueCase(this.runtime.database, record.issue_node_id);
    if (!current || current.source_revision !== record.source_revision || current.issue_id !== record.issue_id || current.project_id !== policy.projectId ||
      current.external_state !== "open" || !policy.allowFix || !policy.allowPullRequest || getIssue(this.runtime.database, current.issue_id!)?.status !== "done") throw new Error("GitHub delivery authorization or source version changed");
  }
}

async function assertRemoteIntakeCurrent(client: GitHubIssueClient, record: GitHubIssueCase, policy: GitHubIssueRepository): Promise<void> {
  const issue = (await client.request(`${githubRepositoryPath(record.repository)}/issues/${record.issue_number}`)).data;
  const labels = Array.isArray(issue.labels) ? issue.labels.map(label => typeof label === "string" ? label : object(label).name) : [];
  const sourceHash = fingerprint({ title: String(issue.title ?? "").slice(0, 1000), body: String(issue.body ?? "").slice(0, 65536) });
  if (issue.node_id !== record.issue_node_id || issue.state !== "open" || !labels.includes(policy.intakeLabel) || sourceHash !== record.source_fingerprint) {
    throw new Error("GitHub intake changed before delivery; wait for source reconciliation");
  }
}

export async function readGitHubChecks(client: GitHubIssueClient, path: string, sha: string): Promise<{ pending: boolean; failed: string[] }> {
  const runs = (await client.request(`${path}/commits/${objectID(sha)}/check-runs?per_page=100`)).data;
  const status = (await client.request(`${path}/commits/${sha}/status?per_page=100`)).data;
  if (!Array.isArray(runs.check_runs) || !Array.isArray(status.statuses) || Number(runs.total_count) > 100 || Number(status.total_count) > 100) throw new Error("GitHub CI evidence incomplete");
  const failed: string[] = [];
  let pending = false;
  for (const check of runs.check_runs as GitHubObject[]) {
    if (check.status !== "completed") { pending = true; continue; }
    if (!["success", "neutral", "skipped"].includes(String(check.conclusion))) failed.push(String(check.name));
  }
  for (const check of status.statuses as GitHubObject[]) {
    if (check.state === "pending") pending = true;
    else if (check.state !== "success") failed.push(String(check.context));
  }
  return { pending, failed };
}

function object(value: unknown): GitHubObject { return value && typeof value === "object" && !Array.isArray(value) ? value as GitHubObject : {}; }
function objectID(value: unknown): string { if (typeof value !== "string" || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value)) throw new Error("Invalid GitHub Git object ID"); return value; }
function positiveID(value: unknown): number { if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("Invalid GitHub object ID"); return Number(value); }
