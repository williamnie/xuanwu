import { expect, test } from "bun:test";
import { symlink, writeFile } from "node:fs/promises";

import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { readIssueDecisionProjection, reviewHumanIssue } from "../domain/review/humanReview.ts";
import { refreshSafeWorkspaceWaits } from "../domain/review/workspaceWait.ts";
import { readWorkspaceWait } from "../db/repositories/workspaceWaits.ts";
import { reserveNextIssue } from "../db/repositories/issueQueue.ts";
import { enqueueIssue, retryIssue } from "../db/repositories/issueActions.ts";
import { insertIssueRunRecord, mustGetCurrentOpenIssueRun } from "../db/repositories/issueRuns.ts";
import { prepareReservedIssueRun } from "../domain/run/runPreparation.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";

import { createPiAction } from "../db/repositories/pi.ts";
import { dispatchPiAction } from "../http/pi/piActionDispatch.ts";
import { recoverInProgressIssues } from "./recovery.ts";
import { prepareRunAttempt, readRunRevision } from "../domain/run/service.ts";

import { startProjectLoop } from "./projectLoopManager.ts";

import { fixture, git, drain, answer } from "./workspaceWaitTestFixtures.ts";

export function registerWorkspaceWaitReservationCases() {
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
}
