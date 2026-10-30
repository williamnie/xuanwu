import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";

import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import {
  createHumanReviewRequest,
  readIssueDecisionProjection,
  reviewHumanIssue
} from "../domain/review/humanReview.ts";
import { refreshSafeWorkspaceWaits } from "../domain/review/workspaceWait.ts";
import { isWorkspaceWaitReleased, readWorkspaceWait } from "../db/repositories/workspaceWaits.ts";
import { reserveNextIssue } from "../db/repositories/issueQueue.ts";
import { cancelIssue } from "../db/repositories/issueActions.ts";
import { insertIssueRunRecord } from "../db/repositories/issueRuns.ts";
import { prepareReservedIssueRun } from "../domain/run/runPreparation.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";

import { startProjectLoop } from "./projectLoopManager.ts";

import { fixture, git, drain, answer } from "./workspaceWaitTestFixtures.ts";

export function registerWorkspaceWaitReleaseCases() {
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
}
