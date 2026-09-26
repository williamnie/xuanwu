import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { insertIssueRunRecord } from "../../db/repositories/issueRuns.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { listStoredHandoffs } from "../../db/repositories/handoffs.ts";
import { prepareReservedIssueRun } from "../../domain/run/runPreparation.ts";
import { buildIssueCompletionCard } from "../../domain/acceptance/completionCard.ts";
import { reconcileProviderOutcome } from "../../runner/providerOutcome.ts";
import { applyPiAcceptanceDecision } from "../../runner/piAcceptanceApplication.ts";
import type { PiAcceptanceDecision } from "../../pi/issueAcceptance.ts";
import { buildGitHubIssueSyncConfig } from "./issueSyncConfig.ts";
import { getGitHubIssueCase, observeGitHubIssue, updateGitHubIssueCase } from "./issueCaseStore.ts";
import { GitHubIssueClient } from "./issueClient.ts";
import { GitHubIssueDelivery } from "./issueDelivery.ts";
import { GITHUB_REPORT_MARKER, githubWorkAcceptanceProblem, readAcceptedGitHubReport, type GitHubWorkReport } from "./issueWorkflow.ts";

const roots: string[] = [];
const databases: RunnerDatabase[] = [];
afterEach(async () => { databases.splice(0).forEach(db => db.close()); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const accept: PiAcceptanceDecision = { confidence: "high", decision: "accept", rationale: "复现和回归证据满足验收", evidence_refs: [], unmet_requirements: [],
  progress: { made_progress: true, evidence_refs: [], summary: "已修复并通过回归" } };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-github-delivery-")); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  const git = (...args: string[]) => { const result = Bun.spawnSync(["git", "-C", repo, ...args]); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout.toString().trim(); };
  git("init", "-q", "-b", "main"); git("config", "user.name", "Fixture"); git("config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "math.py"), "def add(a, b): return a - b\n");
  git("add", "math.py"); git("commit", "-qm", "baseline");
  const baseline = git("rev-parse", "HEAD");
  await writeFile(join(repo, "user-note.txt"), "preexisting user file\n");
  const db = await openDatabase({ stateDir: join(root, "state") }); databases.push(db);
  const now = new Date().toISOString();
  db.sqlite.run("insert into projects (id,name,cwd,provider,auto_run,created_at,updated_at) values ('demo','Demo',?,'codex',0,?,?)", [repo, now, now]);
  const issue = createIssue(db, { project_id: "demo", title: "修复加法", status: "in_progress" });
  const observed = observeGitHubIssue(db, { nodeId: "I_delivery", repositoryId: 123, repository: "acme/demo", number: 5, title: "加法错误", body: "预期 5，实际 -1", author: "reporter",
    url: "https://github.com/acme/demo/issues/5", state: "open", stateReason: "", updatedAt: now, labels: ["xuanwu"] }, "demo");
  updateGitHubIssueCase(db, observed.record.issue_node_id, 1, { issue_id: issue.id, work_source_revision: 1, stage: "repair" });
  const preparation = await prepareReservedIssueRun(db, insertIssueRunRecord(db, issue.id));
  if (preparation.status !== "ready") throw new Error("Run preparation failed");
  const run = preparation.run;
  const command = "python3 -c 'from math_fixture import add; assert add(2,3)==5'";
  await writeFile(join(repo, "math.py"), "def add(a, b): return a + b\n");
  recordIssueEvent(db, issue.id, "issue.log", { runtime_evidence_correlation: { issue_run_id: run.id }, raw_payload: JSON.stringify({ item: {
    id: "regression", type: "commandExecution", command, cwd: repo, exitCode: 0, status: "completed", aggregatedOutput: "assertion passed"
  } }) });
  const report: GitHubWorkReport = { stage: "repair", source_revision: 1, result: "fixed", summary: "修复了加法，原用例和回归通过", expected_basis: ["加法契约"],
    reproduction: { status: "reproduced", expected: "5", actual: "修复前 -1，修复后 5", steps: ["调用 add(2,3)"] }, evidence_commands: [command], regression_commands: [command] };
  recordIssueEvent(db, issue.id, "issue.log", { runtime_evidence_correlation: { issue_run_id: run.id }, text: `${GITHUB_REPORT_MARKER}${JSON.stringify(report)}\nRUNNER_OUTCOME: completed` });
  await reconcileProviderOutcome({ database: db, issueID: issue.id, issueRunID: run.id, providerID: "codex", reportedOutcome: { outcome: "completed", reason: "" } });
  const card = await buildIssueCompletionCard(db, issue.id);
  expect(githubWorkAcceptanceProblem(db, card)).toBe("");
  await applyPiAcceptanceDecision({ database: db }, card, accept);
  const record = getGitHubIssueCase(db, "I_delivery")!;
  expect(readAcceptedGitHubReport(db, record)).not.toBeNull();
  const policy = buildGitHubIssueSyncConfig({ repositories: [{ repository: "acme/demo", projectId: "demo", allowFix: true, allowPullRequest: true, closeOnMerge: true }] }).repositories[0]!;
  const blobs: string[] = []; const trees: unknown[] = []; const commits: Array<Record<string, unknown>> = [];
  const prs: Array<Record<string, any>> = [];
  const reviews: Array<Record<string, unknown>> = [];
  const checks: Array<Record<string, unknown>> = [];
  const prComments: Array<Record<string, unknown>> = [];
  let head: string | null = null; let loseResponse = false;
  let issueState = "open";
  const sha = (value: unknown) => createHash("sha1").update(JSON.stringify(value)).digest("hex");
  const client = new GitHubIssueClient({ apiBaseUrl: "https://api.github.com", token: async () => "test-delivery-token", fetch: async (url, init) => {
    const path = new URL(String(url)).pathname; const method = init?.method ?? "GET"; const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/repos/acme/demo") return Response.json({ default_branch: "main" });
    if (path === "/repos/acme/demo/issues/5") return Response.json({ node_id: "I_delivery", title: "加法错误", body: "预期 5，实际 -1", state: issueState, labels: [{ name: "xuanwu" }] });
    if (path === "/repos/acme/demo/git/ref/heads/main") return Response.json({ object: { sha: baseline } });
    if (path.endsWith("/git/blobs")) { blobs.push(Buffer.from(body.content, "base64").toString()); return Response.json({ sha: sha(body) }); }
    if (path.endsWith(`/git/commits/${baseline}`)) return Response.json({ tree: { sha: "a".repeat(40) } });
    const existingCommit = commits.find(commit => path.endsWith(`/git/commits/${sha(commit)}`));
    if (existingCommit) return Response.json({ tree: { sha: existingCommit.tree } });
    if (path.endsWith("/git/trees")) { trees.push(body); return Response.json({ sha: sha(body) }); }
    if (path.endsWith("/git/commits")) { commits.push(body); return Response.json({ sha: sha(body) }); }
    if (path.includes("/git/ref/heads/codex/")) return head ? Response.json({ object: { sha: head } }) : new Response(null, { status: 404 });
    if (path.endsWith("/git/refs") || path.includes("/git/refs/heads/")) { expect(body.force).not.toBe(true); head = body.sha; return Response.json({ object: { sha: head } }); }
    if (path.endsWith("/pulls") && method === "GET") return Response.json(prs);
    if (path.endsWith("/pulls") && method === "POST") {
      const pr = { number: 7, html_url: "https://github.com/acme/demo/pull/7", state: "open", merged: false, draft: body.draft,
        head: { ref: body.head, sha: head, repo: { full_name: "Acme/Demo" } }, body: body.body };
      prs.push(pr); if (loseResponse) { loseResponse = false; throw new Error("lost PR response"); } return Response.json(pr, { status: 201 });
    }
    if (path.endsWith("/pulls/7")) return Response.json(prs[0]);
    if (path.endsWith("/reviews")) return Response.json(reviews);
    if (path.endsWith("/check-runs")) return Response.json({ check_runs: checks, total_count: checks.length });
    if (path.endsWith("/status")) return Response.json({ statuses: [], total_count: 0 });
    if (path.endsWith("/permission")) return Response.json({ permission: "write" });
    if (path === "/repos/acme/demo/issues/7/comments") return Response.json(prComments);
    if (path.endsWith("/comments")) return Response.json([]);
    throw new Error(`Unexpected API request ${method} ${path}`);
  } });
  const delivery = new GitHubIssueDelivery({ database: db });
  return { db, repo, git, baseline, card, record, policy, client, delivery, blobs, trees, commits, prs, reviews, checks, prComments,
    loseResponse: () => { loseResponse = true; }, changeRemoteHead: () => { head = "b".repeat(40); }, closeRemote: () => { issueState = "closed"; } };
}

test("publishes only attributed verified files, retains workspace and records draft PR Handoff", async () => {
  const f = await fixture(); const before = f.git("status", "--porcelain=v1");
  await f.delivery.advance(f.record, f.policy, f.client);
  expect(f.blobs).toEqual(["def add(a, b): return a + b\n"]);
  expect(f.trees[0]).toMatchObject({ tree: [{ path: "math.py" }] });
  expect(f.commits[0]?.parents).toEqual([f.baseline]);
  expect(f.git("status", "--porcelain=v1")).toBe(before);
  expect(f.git("rev-parse", "HEAD")).toBe(f.baseline);
  expect(f.prs[0]?.draft).toBe(true);
  expect(f.prs[0]?.body).toContain("Refs #5");
  expect(f.prs[0]?.body).not.toContain("Fixes #5");
  expect(getGitHubIssueCase(f.db, "I_delivery")).toMatchObject({ stage: "review", pull_request_number: 7 });
  const handoffs = listStoredHandoffs(f.db, { work_id: `xw:work:issues:${f.record.issue_id}`, limit: 10 }).items;
  expect(handoffs.some(item => item.source === "github-issue-delivery" && item.handoff.delivery.mode === "draft_pr")).toBe(true);
});

test("recovers lost PR response without making another PR or commit", async () => {
  const f = await fixture(); f.loseResponse();
  await expect(f.delivery.advance(f.record, f.policy, f.client)).rejects.toThrow();
  await f.delivery.advance(getGitHubIssueCase(f.db, "I_delivery")!, f.policy, f.client);
  expect(f.prs).toHaveLength(1); expect(f.commits).toHaveLength(1);
  expect(getGitHubIssueCase(f.db, "I_delivery")!.stage).toBe("review");
});

test("blocks publication when files change after verification", async () => {
  const f = await fixture(); await writeFile(join(f.repo, "math.py"), "unverified edit\n");
  await expect(f.delivery.advance(f.record, f.policy, f.client)).rejects.toThrow("Workspace changed");
  expect(f.blobs).toHaveLength(0); expect(f.prs).toHaveLength(0);
});

test("a GitHub close between polling and publication stops every remote Git write", async () => {
  const f = await fixture(); f.closeRemote();
  await expect(f.delivery.advance(f.record, f.policy, f.client)).rejects.toThrow("intake changed");
  expect(f.blobs).toHaveLength(0); expect(f.commits).toHaveLength(0); expect(f.prs).toHaveLength(0);
});

test("merged PR queues closure only under closeOnMerge policy", async () => {
  const f = await fixture(); await f.delivery.advance(f.record, f.policy, f.client);
  f.prs[0]!.merged = true; f.prs[0]!.merge_commit_sha = "c".repeat(40);
  await f.delivery.advance(getGitHubIssueCase(f.db, "I_delivery")!, f.policy, f.client);
  expect(getGitHubIssueCase(f.db, "I_delivery")!.stage).toBe("resolved");
  expect(f.db.sqlite.query("select count(*) as n from sync_outbox where operation_kind='github_issue' and json_extract(payload_json,'$.kind')='close'").get()).toEqual({ n: 1 });
});

test("maintainer changes_requested resumes the same Work and does not approve stale heads", async () => {
  const f = await fixture(); await f.delivery.advance(f.record, f.policy, f.client);
  const record = getGitHubIssueCase(f.db, "I_delivery")!;
  f.reviews.push({ id: 8, state: "CHANGES_REQUESTED", commit_id: "0".repeat(40), body: "stale feedback", user: { login: "maintainer", type: "User" } });
  await f.delivery.advance(record, f.policy, f.client);
  expect(getGitHubIssueCase(f.db, "I_delivery")!.stage).toBe("review");
  f.reviews.push({ id: 9, state: "CHANGES_REQUESTED", commit_id: record.head_sha, body: "Please cover negative inputs", user: { login: "maintainer", type: "User" } });
  await f.delivery.advance(record, f.policy, f.client);
  expect(getGitHubIssueCase(f.db, "I_delivery")).toMatchObject({ issue_id: record.issue_id, stage: "repair", review_cursor: 9 });
  expect(f.db.sqlite.query("select status from issues where id=?").get(record.issue_id)).toEqual({ status: "todo" });
  expect(f.db.sqlite.query("select payload from issue_events where issue_id=? and type='github.review_followup.v1'").get(record.issue_id)).toMatchObject({ payload: expect.stringContaining("negative inputs") });
});

test("merge with failed CI cannot close the Issue", async () => {
  const f = await fixture(); await f.delivery.advance(f.record, f.policy, f.client);
  f.prs[0]!.merged = true;
  f.checks.push({ name: "regression", status: "completed", conclusion: "failure" });
  await f.delivery.advance(getGitHubIssueCase(f.db, "I_delivery")!, f.policy, f.client);
  expect(getGitHubIssueCase(f.db, "I_delivery")!.stage).toBe("review");
  expect(f.db.sqlite.query("select count(*) as n from sync_outbox where operation_kind='github_issue' and json_extract(payload_json,'$.kind')='close'").get()).toEqual({ n: 0 });
});

test("version-bound maintainer PR comments can request a revision on an authored PR", async () => {
  const f = await fixture(); await f.delivery.advance(f.record, f.policy, f.client);
  const record = getGitHubIssueCase(f.db, "I_delivery")!;
  f.prComments.push({ id: 1001, user: { login: "author", type: "User" }, body: `/xuanwu revise ${record.head_sha} 补充负数回归` });
  await f.delivery.advance(record, f.policy, f.client);
  expect(getGitHubIssueCase(f.db, "I_delivery")).toMatchObject({ stage: "repair", issue_id: record.issue_id });
  expect(f.db.sqlite.query("select payload from issue_events where issue_id=? and type='github.review_followup.v1'").get(record.issue_id)).toMatchObject({ payload: expect.stringContaining("github-pr-comment:1001") });
});

test("revalidation of the published file tree reuses its commit without triggering another CI run", async () => {
  const f = await fixture(); await f.delivery.advance(f.record, f.policy, f.client);
  const published = getGitHubIssueCase(f.db, "I_delivery")!;
  const revalidated = updateGitHubIssueCase(f.db, "I_delivery", 1, { stage: "repair", delivery_json: "{}" });
  await f.delivery.advance(revalidated, f.policy, f.client);
  expect(f.commits).toHaveLength(1); expect(f.prs).toHaveLength(1);
  expect(getGitHubIssueCase(f.db, "I_delivery")).toMatchObject({ stage: "review", head_sha: published.head_sha });
});

test("acknowledged CI failure is reported once without retrying work or bypassing merge gates", async () => {
  const f = await fixture(); await f.delivery.advance(f.record, f.policy, f.client);
  const policy = { ...f.policy, ciFailureMode: "report_only" as const, ciFailureReason: "Actions quota exhausted" };
  f.checks.push({ name: "regression", status: "completed", conclusion: "failure" });
  for (let i = 0; i < 2; i++) await f.delivery.advance(getGitHubIssueCase(f.db, "I_delivery")!, policy, f.client);
  expect(getGitHubIssueCase(f.db, "I_delivery")).toMatchObject({ stage: "review", last_error: expect.stringContaining("Actions quota exhausted") });
  expect(f.db.sqlite.query("select status from issues where id=?").get(f.record.issue_id)).toEqual({ status: "done" });
  expect(f.db.sqlite.query("select count(*) as n from issue_events where type='github.review_followup.v1'").get()).toEqual({ n: 0 });
  expect(f.db.sqlite.query("select count(*) as n from sync_outbox where operation_kind='github_issue' and json_extract(payload_json,'$.body') like '%Actions quota exhausted%'").get()).toEqual({ n: 1 });
  f.prs[0]!.merged = true;
  await f.delivery.advance(getGitHubIssueCase(f.db, "I_delivery")!, policy, f.client);
  expect(getGitHubIssueCase(f.db, "I_delivery")!.stage).toBe("review");
  expect(f.db.sqlite.query("select count(*) as n from sync_outbox where operation_kind='github_issue' and json_extract(payload_json,'$.kind')='close'").get()).toEqual({ n: 0 });
});

for (const ciFailureMode of ["repair", "report_only"] as const) {
  test(`${ciFailureMode} CI failure still gives priority to version-bound maintainer feedback`, async () => {
    const f = await fixture(); await f.delivery.advance(f.record, f.policy, f.client);
    const record = getGitHubIssueCase(f.db, "I_delivery")!;
    f.checks.push({ name: "regression", status: "completed", conclusion: "failure" });
    f.prComments.push({ id: 1002, user: { login: "author", type: "User" }, body: `/xuanwu revise ${record.head_sha} 补充负数回归` });
    await f.delivery.advance(record, { ...f.policy, ciFailureMode, ciFailureReason: "Actions quota exhausted" }, f.client);
    expect(getGitHubIssueCase(f.db, "I_delivery")!.stage).toBe("repair");
    expect(f.db.sqlite.query("select payload from issue_events where type='github.review_followup.v1'").all()).toEqual([
      { payload: expect.stringContaining("github-pr-comment:1002") }
    ]);
  });
}
