import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { createHumanReviewRequest, readIssueDecisionProjection, reviewHumanIssue } from "../domain/review/humanReview.ts";
import { refreshSafeWorkspaceWaits } from "../domain/review/workspaceWait.ts";
import { isWorkspaceWaitReleased, readWorkspaceWait } from "../db/repositories/workspaceWaits.ts";
import { reserveNextIssue } from "../db/repositories/issueQueue.ts";
import { cancelIssue, enqueueIssue, retryIssue } from "../db/repositories/issueActions.ts";
import { insertIssueRunRecord, mustGetCurrentOpenIssueRun } from "../db/repositories/issueRuns.ts";
import { prepareReservedIssueRun } from "../domain/run/runPreparation.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { createPiAction } from "../db/repositories/pi.ts";
import { dispatchPiAction } from "../http/piActionDispatch.ts";
import { recoverInProgressIssues } from "./recovery.ts";
import { prepareRunAttempt, readRunRevision } from "../domain/run/service.ts";
import { applyPiSemanticIssueStatus } from "./piIssueLifecycle.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import { isProjectLoopActive, startProjectLoop } from "./projectLoopManager.ts";
import type { ExecutorProvider, ProviderRunInput, SessionMessageInput } from "../providers/types.ts";

const roots: string[] = [];
setDefaultTimeout(30_000);
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

class Provider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution", "resume_session"] as const;
  inputs: ProviderRunInput[] = [];
  messages: SessionMessageInput[] = [];
  async sendSessionMessage(input: SessionMessageInput) {
    this.messages.push(input);
    return { provider: this.id, sessionId: input.sessionId, turn_id: "revision-turn", provider_session_id: input.sessionId };
  }
  async run(input: ProviderRunInput) {
    this.inputs.push(input);
    const session = { provider: this.id, sessionId: `session-${input.issueId}`, turnId: `turn-${input.issueId}` };
    input.onEvent?.({ provider: this.id, type: "done", status: "completed", session, raw: { method: "turn/completed" } });
    return { runId: `run-${input.issueId}`, session };
  }
}

async function fixture(withRequest = true) {
  const root = await mkdtemp(join(tmpdir(), "workspace-wait-"));
  roots.push(root);
  const cwd = join(root, "repo");
  await mkdir(cwd);
  git(cwd, "init", "-b", "main");
  await writeFile(join(cwd, "seed.txt"), "initial");
  git(cwd, "add", "seed.txt");
  git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "initial");
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(`insert into projects (id,name,cwd,provider,auto_run,created_at,updated_at)
    values ('demo','demo',?,'codex',1,?,?)`, [cwd, new Date().toISOString(), new Date().toISOString()]);
  const provider = new Provider();
  const runtime = { database: db, providers: { codex: provider } };
  const issue = createIssue(db, { project_id: "demo", title: "需要产品决定", status: "todo" });
  await runProjectLoopOnce({ ...runtime, projectId: "demo" });
  applyPiSemanticIssueStatus(db, issue.id, { card_fingerprint: "fixture", decision: "needs_user",
    reason: "需要产品决定", run_id: listIssueRuns(db, issue.id).at(-1)!.id, status: "needs_user" });
  const request = withRequest ? createHumanReviewRequest(db, issue.id, { kind: "decision", question: "是否继续？" }) : null;
  return { root, cwd, db, provider, runtime, issue, request };
}

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

async function drain(db: RunnerDatabase) {
  const deadline = Date.now() + 15_000;
  while (isProjectLoopActive("demo", db) && Date.now() < deadline) await Bun.sleep(10);
  expect(isProjectLoopActive("demo", db)).toBe(false);
}

test("project loop releases a clean terminal human wait and starts independent work", async () => {
  const f = await fixture();
  try {
    const next = createIssue(f.db, { project_id: "demo", title: "独立任务", status: "todo" });
    startProjectLoop(f.runtime, "demo");
    await drain(f.db);
    expect(f.provider.inputs.map(input => input.issueId)).toEqual([f.issue.id, next.id]);
    expect(getIssue(f.db, f.issue.id)?.status).toBe("needs_user");
  } finally { f.db.close(); }
});

function answer(f: Awaited<ReturnType<typeof fixture>>, action = "accept") {
  const request = f.request!;
  return { action, comment: "确认当前范围", review_request_id: request.id, review_revision: request.revision };
}

for (const dirty of ["tracked", "staged", "untracked", "git_operation"] as const) {
  test(`retains the directory for ${dirty}`, async () => {
    const f = await fixture();
    try {
      if (dirty === "git_operation") await writeFile(join(f.cwd, ".git", "MERGE_HEAD"), git(f.cwd, "rev-parse", "HEAD"));
      else {
        await writeFile(join(f.cwd, dirty === "untracked" ? "untracked.txt" : "seed.txt"), "pending");
        if (dirty === "staged") git(f.cwd, "add", "seed.txt");
      }
      await refreshSafeWorkspaceWaits(f.db);
      expect(readWorkspaceWait(f.db, f.issue.id)).toBeNull();
      createIssue(f.db, { project_id: "demo", title: "another", status: "todo" });
      expect(reserveNextIssue(f.db, "demo")).toBeNull();
    } finally { f.db.close(); }
  });
}

test("unclassified needs_user and live Session retain protection", async () => {
  const f = await fixture(false);
  try {
    await refreshSafeWorkspaceWaits(f.db);
    expect(readWorkspaceWait(f.db, f.issue.id)).toBeNull();
    createHumanReviewRequest(f.db, f.issue.id, { kind: "risk_acceptance", question: "授权？" });
    upsertAgentSession(f.db, { provider: "codex", provider_session_id: `session-${f.issue.id}`,
      project_id: "demo", issue_id: f.issue.id, status: "running" });
    await refreshSafeWorkspaceWaits(f.db);
    expect(readWorkspaceWait(f.db, f.issue.id)).toBeNull();
  } finally { f.db.close(); }
});

test("an open Run cannot be released even when Issue is needs_user", async () => {
  const f = await fixture();
  try {
    insertIssueRunRecord(f.db, f.issue.id);
    await refreshSafeWorkspaceWaits(f.db);
    expect(readWorkspaceWait(f.db, f.issue.id)).toBeNull();
  } finally { f.db.close(); }
});

test("Provider idle after a terminal Run is quiescent, but never overrides an open Run", async () => {
  const f = await fixture();
  try {
    upsertAgentSession(f.db, { provider: "codex", provider_session_id: `session-${f.issue.id}`,
      project_id: "demo", issue_id: f.issue.id, status: "idle" });
    await refreshSafeWorkspaceWaits(f.db);
    expect(isWorkspaceWaitReleased(f.db, f.issue.id)).toBe(true);
    await reviewHumanIssue(f.db, f.issue.id, answer(f));
    insertIssueRunRecord(f.db, f.issue.id);
    expect(isWorkspaceWaitReleased(f.db, f.issue.id)).toBe(false);
    expect(reserveNextIssue(f.db, "demo")).toBeNull();
  } finally { f.db.close(); }
});

test("release survives reopening the DB and only one connection can claim the cwd", async () => {
  const f = await fixture();
  await refreshSafeWorkspaceWaits(f.db);
  const path = f.db.path;
  f.db.close();
  const db = await openDatabase({ dbPath: path });
  const peer = await openDatabase({ dbPath: path });
  try {
    expect(isWorkspaceWaitReleased(db, f.issue.id)).toBe(true);
    const next = createIssue(db, { project_id: "demo", title: "another", status: "todo" });
    createIssue(db, { project_id: "demo", title: "third", status: "todo" });
    expect(reserveNextIssue(db, "demo")?.issue.id).toBe(next.id);
    expect(reserveNextIssue(peer, "demo")).toBeNull();
    await expect(reviewHumanIssue(peer, f.issue.id, answer(f))).rejects.toThrow("工作目录仍有执行");
    expect(listIssueEvents(db, f.issue.id, { types: ["issue.human_review_answered.v1"] })).toHaveLength(0);
    cancelIssue(db, next.id);
    await expect(reviewHumanIssue(peer, f.issue.id, answer(f))).resolves.toMatchObject({ status: "in_progress" });
  } finally { peer.close(); db.close(); }
});

for (const change of ["head", "branch", "input"] as const) {
  test(`${change} drift expires the answer and requires a new request revision`, async () => {
    const f = await fixture();
    try {
      await refreshSafeWorkspaceWaits(f.db);
      if (change === "head") git(f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "other work");
      if (change === "branch") git(f.cwd, "checkout", "-b", "other-work");
      if (change === "input") recordIssueEvent(f.db, f.issue.id, "issue.comment", { author: "user", body: "范围更新" });
      await expect(reviewHumanIssue(f.db, f.issue.id, answer(f))).rejects.toThrow("原回答已过期");
      const fresh = readIssueDecisionProjection(f.db, f.issue.id).request!;
      expect(fresh.id).not.toBe(f.request!.id);
      expect(fresh.revision).toBe(f.request!.revision + 1);
      expect(listIssueEvents(f.db, f.issue.id, { types: ["issue.human_review_answered.v1"] })).toHaveLength(0);
      await expect(reviewHumanIssue(f.db, f.issue.id, answer(f))).rejects.toThrow("已更新");
      await expect(reviewHumanIssue(f.db, f.issue.id, { ...answer(f), review_request_id: fresh.id,
        review_revision: fresh.revision })).resolves.toMatchObject({ status: "in_progress" });
      expect(readWorkspaceWait(f.db, f.issue.id)?.state).toBe("acquired");
    } finally { f.db.close(); }
  });
}

test("dirty peer changes after release cannot be accepted or mixed into a resumed Run", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    await writeFile(join(f.cwd, "seed.txt"), "another person's work");
    await expect(reviewHumanIssue(f.db, f.issue.id, answer(f, "request_changes"), f.runtime)).rejects.toThrow("不干净");
    expect(f.provider.messages).toHaveLength(0);
    expect(listIssueRuns(f.db, f.issue.id)).toHaveLength(1);
    expect(readWorkspaceWait(f.db, f.issue.id)?.state).toBe("released");
  } finally { f.db.close(); }
});

test("two simultaneous answers resume the original Session exactly once", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    const results = await Promise.allSettled([
      reviewHumanIssue(f.db, f.issue.id, answer(f, "request_changes"), f.runtime),
      reviewHumanIssue(f.db, f.issue.id, answer(f, "request_changes"), f.runtime)
    ]);
    if (results.every(result => result.status === "rejected")) {
      throw new AggregateError(results.flatMap(result => result.status === "rejected" ? [result.reason] : []), "Neither answer resumed");
    }
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(f.provider.messages).toHaveLength(1);
    expect(f.provider.messages[0]?.sessionId).toBe(`session-${f.issue.id}`);
    expect(listIssueRuns(f.db, f.issue.id)).toHaveLength(2);
    expect(readWorkspaceWait(f.db, f.issue.id)?.state).toBe("consumed");
  } finally { f.db.close(); }
});

test("a queue claim during answer observation wins without a competing resume", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    createIssue(f.db, { project_id: "demo", title: "another", status: "todo" });
    const response = reviewHumanIssue(f.db, f.issue.id, answer(f, "request_changes"), f.runtime);
    expect(reserveNextIssue(f.db, "demo")).not.toBeNull();
    await expect(response).rejects.toThrow("核验期间变化");
    expect(f.provider.messages).toHaveLength(0);
    expect(getIssue(f.db, f.issue.id)?.status).toBe("needs_user");
  } finally { f.db.close(); }
});

test("cancel during observation cannot be undone by a late answer", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    const response = reviewHumanIssue(f.db, f.issue.id, answer(f));
    cancelIssue(f.db, f.issue.id);
    await expect(response).rejects.toThrow("核验期间变化");
    expect(getIssue(f.db, f.issue.id)?.status).toBe("cancelled");
  } finally { f.db.close(); }
});

test("final preparation rechecks an acquired directory after restart", async () => {
  const f = await fixture();
  await refreshSafeWorkspaceWaits(f.db);
  await reviewHumanIssue(f.db, f.issue.id, answer(f));
  const path = f.db.path;
  f.db.close();
  const db = await openDatabase({ dbPath: path });
  try {
    const reserved = insertIssueRunRecord(db, f.issue.id);
    await writeFile(join(f.cwd, "seed.txt"), "late foreign work");
    expect(await prepareReservedIssueRun(db, reserved)).toMatchObject({ status: "claim_invalidated" });
    expect(getIssue(db, f.issue.id)?.status).toBe("needs_user");
    expect(listIssueRuns(db, f.issue.id).at(-1)?.ended_at).not.toBe("");
    expect(readIssueDecisionProjection(db, f.issue.id).request?.revision).toBe(f.request!.revision + 1);
  } finally { db.close(); }
});

test("retry cannot materialize an unanswered released wait", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    expect(() => retryIssue(f.db, f.issue.id)).toThrow("current human answer");
    expect(() => enqueueIssue(f.db, f.issue.id)).toThrow("current human answer");
    expect(getIssue(f.db, f.issue.id)?.status).toBe("needs_user");
    expect(reserveNextIssue(f.db, "demo")).toBeNull();
    expect(() => insertIssueRunRecord(f.db, f.issue.id)).toThrow("current human answer");
    expect(listIssueRuns(f.db, f.issue.id)).toHaveLength(1);
  } finally { f.db.close(); }
});

for (const actionType of ["session.steer", "session.resume_followup"]) {
  test(`${actionType} cannot bypass workspace reacquisition`, async () => {
    const f = await fixture();
    try {
      await refreshSafeWorkspaceWaits(f.db);
      const action = createPiAction(f.db, { id: `guard-${actionType}`, action_type: actionType,
        issue_id: f.issue.id, project_id: "demo", status: "approved", payload_json: JSON.stringify({
          issue_id: f.issue.id, provider: "codex", provider_session_id: `session-${f.issue.id}`, prompt: "resume"
        }) });
      await expect(dispatchPiAction(f.runtime, action)).rejects.toThrow("Workspace wait requires human review");
      expect(f.provider.messages).toHaveLength(0);
    } finally { f.db.close(); }
  });
}

test("Run Attempt commands cannot bypass a released human wait", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    const run = listIssueRuns(f.db, f.issue.id).at(-1)!;
    const runID = `xw:run:issue_runs:${run.id}` as const;
    expect(() => prepareRunAttempt(f.db, {
      audit: { actor: { id: "test", kind: "user" }, correlation_id: "guard", event_id: "guard",
        gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "fixture" },
        occurred_at: new Date().toISOString(), reason: "resume" },
      expected_revision: readRunRevision(f.db, f.issue.id, runID), expected_attempt_revision: 0,
      issue_run_id: run.id, run_id: runID, kind: "resume",
      previous_attempt_terminal: { reason: "completed", source_ref: "fixture", status: "succeeded" },
      provider_ref: { provider: "codex", session_ref: `session-${f.issue.id}` }
    })).toThrow("Workspace wait requires human review");
    expect(f.provider.messages).toHaveLength(0);
  } finally { f.db.close(); }
});

test("startup recovery restores confirmation instead of requeueing an acquired unstarted Run", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    await reviewHumanIssue(f.db, f.issue.id, answer(f));
    insertIssueRunRecord(f.db, f.issue.id);
    expect(await recoverInProgressIssues({ database: f.db })).toEqual({ reconciled: 0, requeued: 0, signaled: 1 });
    expect(getIssue(f.db, f.issue.id)?.status).toBe("needs_user");
    const fresh = readIssueDecisionProjection(f.db, f.issue.id).request!;
    expect(fresh.revision).toBe(f.request!.revision + 1);
    await refreshSafeWorkspaceWaits(f.db);
    const resumed = await reviewHumanIssue(f.db, f.issue.id, { ...answer(f), review_request_id: fresh.id,
      review_revision: fresh.revision });
    expect(resumed).toMatchObject({ status: "in_progress" });
  } finally { f.db.close(); }
});

test("input arriving during observation is never included in an already submitted answer", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    const response = reviewHumanIssue(f.db, f.issue.id, answer(f));
    recordIssueEvent(f.db, f.issue.id, "issue.comment", { author: "user", body: "new constraint" });
    await expect(response).rejects.toThrow("核验期间变化");
    expect(getIssue(f.db, f.issue.id)?.status).toBe("needs_user");
  } finally { f.db.close(); }
});

test("assume-unchanged index entries cannot hide edits from release validation", async () => {
  const f = await fixture();
  try {
    git(f.cwd, "update-index", "--assume-unchanged", "seed.txt");
    await writeFile(join(f.cwd, "seed.txt"), "hidden work");
    expect(git(f.cwd, "status", "--porcelain")).toBe("");
    await refreshSafeWorkspaceWaits(f.db);
    expect(readWorkspaceWait(f.db, f.issue.id)).toBeNull();
  } finally { f.db.close(); }
});

test("input drift after answer is restored to a new review before any Provider execution", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    await reviewHumanIssue(f.db, f.issue.id, answer(f));
    recordIssueEvent(f.db, f.issue.id, "issue.comment", { author: "user", body: "new constraint after answer" });
    const reserved = insertIssueRunRecord(f.db, f.issue.id);
    expect(() => mustGetCurrentOpenIssueRun(f.db, f.issue.id, reserved.run_id)).toThrow("must pass preparation");
    expect(await prepareReservedIssueRun(f.db, reserved)).toMatchObject({ status: "claim_invalidated" });
    expect(getIssue(f.db, f.issue.id)?.status).toBe("needs_user");
    expect(readIssueDecisionProjection(f.db, f.issue.id).request?.revision).toBe(f.request!.revision + 1);
    expect(f.provider.messages).toHaveLength(0);
  } finally { f.db.close(); }
});

test("a new Host process revalidates the persisted wait before accepting an answer", async () => {
  const f = await fixture();
  await refreshSafeWorkspaceWaits(f.db);
  const path = f.db.path;
  f.db.close();
  const source = `
    import { openDatabase } from ${JSON.stringify(new URL("../db/database.ts", import.meta.url).href)};
    import { reviewHumanIssue } from ${JSON.stringify(new URL("../domain/review/humanReview.ts", import.meta.url).href)};
    const input = JSON.parse(Bun.argv.at(-1));
    const db = await openDatabase({ dbPath: input.path });
    try { console.log(JSON.stringify({ status: (await reviewHumanIssue(db, input.id, input.answer)).status })); }
    finally { db.close(); }
  `;
  const child = Bun.spawn([process.execPath, "--eval", source,
    JSON.stringify({ path, id: f.issue.id, answer: answer(f) })], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()
  ]);
  if (code !== 0) throw new Error(`Restart fixture failed (${code}): ${stderr}`);
  expect(JSON.parse(stdout.trim())).toEqual({ status: "in_progress" });
  const db = await openDatabase({ dbPath: path });
  try {
    expect(readWorkspaceWait(db, f.issue.id)?.state).toBe("acquired");
    expect(listIssueRuns(db, f.issue.id)).toHaveLength(1);
  } finally { db.close(); }
});

test("cwd aliases share one reservation lock", async () => {
  const f = await fixture();
  try {
    await refreshSafeWorkspaceWaits(f.db);
    const alias = join(f.root, "alias");
    await symlink(f.cwd, alias);
    f.db.sqlite.run(`insert into projects (id,name,cwd,provider,auto_run,created_at,updated_at)
      values ('alias','alias',?,'codex',1,?,?)`, [alias, new Date().toISOString(), new Date().toISOString()]);
    createIssue(f.db, { project_id: "demo", title: "one", status: "todo" });
    createIssue(f.db, { project_id: "alias", title: "two", status: "todo" });
    expect(reserveNextIssue(f.db, "alias")).not.toBeNull();
    expect(reserveNextIssue(f.db, "demo")).toBeNull();
    await expect(reviewHumanIssue(f.db, f.issue.id, answer(f))).rejects.toThrow("工作目录仍有执行");
  } finally { f.db.close(); }
});

test("project loop preserves dirty workspace protection", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.cwd, "pending.txt"), "unprocessed work");
    const next = createIssue(f.db, { project_id: "demo", title: "独立任务", status: "todo" });
    startProjectLoop(f.runtime, "demo");
    await drain(f.db);
    expect(f.provider.inputs).toHaveLength(1);
    expect(getIssue(f.db, next.id)?.status).toBe("todo");
  } finally { f.db.close(); }
});
