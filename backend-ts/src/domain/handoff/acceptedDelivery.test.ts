import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { insertIssueRunRecord } from "../../db/repositories/issueRuns.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { listStoredHandoffs } from "../../db/repositories/handoffs.ts";
import { listStoredEvidence } from "../../db/repositories/evidence.ts";
import { createDefaultRouter } from "../../http/server.ts";
import { buildDeliveryEffectiveness } from "../../observability/deliveryEffectiveness.ts";
import { applyPiAcceptanceDecision } from "../../runner/piAcceptanceApplication.ts";
import { reconcileProviderOutcome } from "../../runner/providerOutcome.ts";
import type { PiAcceptanceDecision } from "../../pi/issueAcceptance.ts";
import { buildIssueCompletionCard } from "../acceptance/completionCard.ts";
import { prepareReservedIssueRun } from "../run/runPreparation.ts";

const roots: string[] = [];
const acceptance: PiAcceptanceDecision = { confidence: "high", decision: "accept", rationale: "任务已完成，实际检查通过。",
  evidence_refs: [], unmet_requirements: [], progress: { made_progress: true, evidence_refs: [], summary: "完成修改和检查。" } };
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

test("ordinary acceptance publishes one linked receipt and evidence through the existing API without Git writes", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    await writeFile(join(repo, "unrelated.txt"), "existing user edit\n");
    const run = await startRun(db, issueID);
    await writeFile(join(repo, "feature.txt"), "task output\n");
    const card = await finishRun(db, repo, issueID, run.id);
    expect(card.git.workspace_snapshot_ref).toContain(`run-git-snapshot:${run.id}:`);
    expect(card.git).not.toHaveProperty("workspace_snapshot");
    const before = git(repo, "status", "--porcelain=v1");
    const head = git(repo, "rev-parse", "HEAD");
    const [first, replay] = await Promise.all([
      applyPiAcceptanceDecision({ database: db }, card, acceptance),
      applyPiAcceptanceDecision({ database: db }, card, acceptance),
    ]);
    expect([first.status, replay.status]).toEqual(["done", "done"]);
    const records = receipts(db, issueID);
    expect(records).toHaveLength(1);
    const handoff = records[0]!.handoff;
    expect(handoff).toMatchObject({ status: "ready", changed_files: ["feature.txt"], delivery: { mode: "local_changes" }, delivery_actions: [] });
    expect(handoff.run_ids).toEqual([`xw:run:issue_runs:${run.id}`]);
    const evidence = listStoredEvidence(db, { work_id: handoff.work_id, limit: 100 }).items.map(item => item.evidence);
    expect(evidence.map(item => item.kind).sort()).toEqual(["git", "shell"]);
    expect(evidence.every(item => item.status === "passed" && handoff.evidence_ids.includes(item.id))).toBe(true);
    expect(git(repo, "status", "--porcelain=v1")).toBe(before);
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(db.sqlite.query<{ n: number }, [number]>("select count(*) n from issue_events where issue_id=? and type='issue.pi_acceptance_applied.v1'").get(issueID)?.n).toBe(1);
    const router = createDefaultRouter({ database: db });
    const response = await router.handle(new Request(`http://localhost/api/handoffs/${encodeURIComponent(handoff.id)}`));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ handoff: { changed_files: ["feature.txt"], status: "ready" }, delivery_status: { overall: "ready" } });
    expect(buildDeliveryEffectiveness(db, new Date(Date.now() + 1000))).toMatchObject({ completed_works: 1, delivered_works: 1 });
  } finally { db.close(); }
});

test("the receipt covers earlier Runs and does not claim external delivery from the final message", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    const first = await startRun(db, issueID);
    await writeFile(join(repo, "first.txt"), "first run\n");
    git(repo, "add", "first.txt"); git(repo, "commit", "-qm", "first output");
    await finishRun(db, repo, issueID, first.id);
    const second = await startRun(db, issueID);
    await writeFile(join(repo, "second.txt"), "second run\n");
    git(repo, "add", "second.txt"); git(repo, "commit", "-qm", "second output");
    const card = await finishRun(db, repo, issueID, second.id);
    await applyPiAcceptanceDecision({ database: db }, card, { ...acceptance, rationale: "修改完成，Agent 声称已发布。" });
    expect(receipts(db, issueID)[0]?.handoff).toMatchObject({ status: "ready", changed_files: ["first.txt", "second.txt"],
      run_ids: [`xw:run:issue_runs:${first.id}`, `xw:run:issue_runs:${second.id}`], delivery: { mode: "local_changes" }, delivery_actions: [] });
  } finally { db.close(); }
});

test("a read-only ordinary task also gets a valid zero-file receipt", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    const run = await startRun(db, issueID);
    const card = await finishRun(db, repo, issueID, run.id);
    await applyPiAcceptanceDecision({ database: db }, card, acceptance);
    const handoff = receipts(db, issueID)[0]!.handoff;
    expect(handoff.status).toBe("ready");
    expect(handoff.changed_files).toEqual([]);
    expect(handoff.baseline_revision).toBe(handoff.final_revision);
  } finally { db.close(); }
});

test("edits to a pre-existing dirty file remain uncertain and never block PI acceptance", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    await writeFile(join(repo, "README.md"), "user edit\n");
    const run = await startRun(db, issueID);
    await writeFile(join(repo, "README.md"), "mixed user and task edit\n");
    const card = await finishRun(db, repo, issueID, run.id);
    await applyPiAcceptanceDecision({ database: db }, card, acceptance);
    expect(getIssue(db, issueID)?.status).toBe("done");
    expect(receipts(db, issueID)[0]?.handoff).toMatchObject({ status: "draft", changed_files: [], risks: expect.arrayContaining([
      expect.objectContaining({ summary: expect.stringContaining("执行前已存在") }),
    ]) });
    expect(buildDeliveryEffectiveness(db, new Date(Date.now() + 1000)).delivered_works).toBe(0);
  } finally { db.close(); }
});

test("failed command observations stay failed rather than becoming proof of success", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    const run = await startRun(db, issueID);
    const card = await finishRun(db, repo, issueID, run.id, 1);
    await applyPiAcceptanceDecision({ database: db }, card, acceptance);
    expect(receipts(db, issueID)[0]?.handoff.status).toBe("draft");
    const evidence = listStoredEvidence(db, { work_id: `xw:work:issues:${issueID}`, limit: 100 }).items;
    expect(evidence.find(item => item.evidence.kind === "shell")?.evidence.status).toBe("failed");
  } finally { db.close(); }
});

test("missing legacy snapshots produce an honest draft without changing acceptance", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    const run = await startRun(db, issueID);
    const card = await finishRun(db, repo, issueID, run.id);
    db.sqlite.run("delete from issue_events where issue_id=? and type='issue.run_git_workspace_baseline.v1'", [issueID]);
    await applyPiAcceptanceDecision({ database: db }, card, acceptance);
    expect(getIssue(db, issueID)?.status).toBe("done");
    expect(receipts(db, issueID)[0]?.handoff.status).toBe("draft");
  } finally { db.close(); }
});

test("a newer Run prevents the stale acceptance from writing either completion or a receipt", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    const run = await startRun(db, issueID);
    const card = await finishRun(db, repo, issueID, run.id);
    await startRun(db, issueID);
    await expect(applyPiAcceptanceDecision({ database: db }, card, acceptance)).rejects.toThrow("stale");
    expect(receipts(db, issueID)).toHaveLength(0);
    expect(getIssue(db, issueID)?.status).toBe("in_progress");
  } finally { db.close(); }
});

test("acceptance rechecks the issue revision after asynchronous preparation", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    const run = await startRun(db, issueID);
    const card = await finishRun(db, repo, issueID, run.id);
    const accepting = applyPiAcceptanceDecision({ database: db }, card, acceptance);
    db.sqlite.run("update issues set updated_at=? where id=?", [new Date(Date.now() + 5000).toISOString(), issueID]);
    await expect(accepting).rejects.toThrow("stale");
    expect(receipts(db, issueID)).toHaveLength(0);
    expect(getIssue(db, issueID)?.status).toBe("in_progress");
  } finally { db.close(); }
});

test("terminal workspace observations exclude files added after the Run ended", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    const run = await startRun(db, issueID);
    await writeFile(join(repo, "owned.txt"), "task output\n");
    await finishRun(db, repo, issueID, run.id);
    await writeFile(join(repo, "later.txt"), "later user output\n");
    const card = await buildIssueCompletionCard(db, issueID);
    await applyPiAcceptanceDecision({ database: db }, card, acceptance);
    expect(receipts(db, issueID)[0]?.handoff.changed_files).toEqual(["owned.txt"]);
  } finally { db.close(); }
});

test("a receipt storage failure rolls back completion, evidence and notifications together", async () => {
  const { db, repo, issueID } = await fixture();
  try {
    const run = await startRun(db, issueID);
    const card = await finishRun(db, repo, issueID, run.id);
    const notificationsBefore = db.sqlite.query<{ n: number }, []>("select count(*) n from notifications").get()!.n;
    db.sqlite.exec("create trigger reject_handoff before insert on issue_events when new.type='issue.pi_acceptance_applied.v1' begin select raise(abort, 'fixture receipt write failure'); end");
    await expect(applyPiAcceptanceDecision({ database: db }, card, acceptance)).rejects.toThrow("fixture receipt write failure");
    expect(getIssue(db, issueID)?.status).toBe("in_progress");
    expect(receipts(db, issueID)).toHaveLength(0);
    expect(listStoredEvidence(db, { work_id: `xw:work:issues:${issueID}`, limit: 100 }).items).toHaveLength(0);
    expect(db.sqlite.query<{ n: number }, []>("select count(*) n from notifications").get()!.n).toBe(notificationsBefore);
    db.sqlite.exec("drop trigger reject_handoff");
    await applyPiAcceptanceDecision({ database: db }, card, acceptance);
    expect(receipts(db, issueID)).toHaveLength(1);
  } finally { db.close(); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "accepted-delivery-")); roots.push(root);
  const repo = join(root, "repo"); await mkdir(repo);
  git(repo, "init", "-q"); git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.test");
  await writeFile(join(repo, "README.md"), "base\n");
  git(repo, "add", "README.md"); git(repo, "commit", "-qm", "base");
  const db = await openDatabase({ stateDir: join(root, "state") });
  const now = new Date().toISOString();
  db.sqlite.run("insert into projects (id,name,cwd,provider,auto_run,created_at,updated_at) values ('demo','Demo',?,'codex',0,?,?)", [repo, now, now]);
  const issue = createIssue(db, { project_id: "demo", title: "Ordinary delivery", status: "in_progress" });
  return { db, repo, issueID: issue.id };
}

async function startRun(db: RunnerDatabase, issueID: number) {
  const result = await prepareReservedIssueRun(db, insertIssueRunRecord(db, issueID));
  if (result.status !== "ready") throw new Error("fixture run preparation failed");
  return result.run;
}

async function finishRun(db: RunnerDatabase, repo: string, issueID: number, runID: string, exitCode = 0) {
  recordIssueEvent(db, issueID, "issue.log", {
    runtime_evidence_correlation: { issue_run_id: runID },
    raw_payload: JSON.stringify({ item: {
      id: `command-${runID}`, type: "commandExecution", command: "printf 'observed output\\n'", cwd: repo,
      exitCode, status: exitCode ? "failed" : "completed", aggregatedOutput: "observed output\n",
    } }),
  });
  const now = new Date().toISOString();
  db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [now, runID]);
  // 走真实终态收尾入口，避免测试手工写快照而遗漏生产装配问题。
  await reconcileProviderOutcome({ database: db, issueID, issueRunID: runID, providerID: "codex",
    reportedOutcome: { outcome: "completed", reason: "" }, now: new Date(now) });
  return buildIssueCompletionCard(db, issueID);
}

function receipts(db: RunnerDatabase, issueID: number) { return listStoredHandoffs(db, { work_id: `xw:work:issues:${issueID}`, limit: 100 }).items; }
function git(repo: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", repo, ...args]);
  if (result.exitCode) throw new Error(result.stderr.toString());
  return result.stdout.toString();
}
