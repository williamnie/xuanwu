import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { createHumanReviewRequest, reviewHumanIssue } from "./humanReview.ts";
import { readHumanFeedback } from "./humanFeedback.ts";
import { createDefaultRouter } from "../../http/server.ts";

const fixtures: Array<{ db: RunnerDatabase; root: string }> = [];
afterEach(async () => {
  for (const { db, root } of fixtures.splice(0)) { db.close(); await rm(root, { recursive: true, force: true }); }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "handoff-feedback-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  fixtures.push({ db, root });
  db.sqlite.run("insert into projects (id,name,cwd,provider,auto_run,sort_order,created_at,updated_at) values ('demo','demo',?,'codex',0,1,'2026-09-29','2026-09-29')", [root]);
  const issue = createIssue(db, { project_id: "demo", status: "needs_user", title: "Delivery feedback" });
  const oldRun = createIssueRun(db, issue.id);
  db.sqlite.run("update issue_runs set status='succeeded', ended_at='2026-09-29', provider_session_id='original-session' where id=?", [oldRun.id]);
  const fingerprint = "a".repeat(64);
  recordIssueEvent(db, issue.id, "issue.completion_card.v1", { fingerprint, card: { run: { id: oldRun.id } } });
  const request = createHumanReviewRequest(db, issue.id, { question: "是否接受本地实现？", excluded_scope: ["真实页面验收"], evidence_refs: [`completion-card:${fingerprint}`] });
  return { db, issue, oldRun, request };
}

test("feedback is absent before a response and binds accepted text to the original request version", async () => {
  const { db, issue, request, oldRun } = await fixture();
  expect(readHumanFeedback(db, issue.id)).toBeNull();
  await reviewHumanIssue(db, issue.id, { action: "accept", comment: "只接受本地结果", review_request_id: request.id, review_revision: request.revision });
  expect(readHumanFeedback(db, issue.id)).toMatchObject({ status: "received", feedback: "只接受本地结果", review_request_id: request.id, review_revision: 1, question: request.question, origin_run_id: oldRun.id, run: null });
  const response = await createDefaultRouter({ database: db }).handle(new Request(`http://localhost/api/works/${encodeURIComponent(`xw:work:issues:${issue.id}`)}`));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ feedback: { review_request_id: request.id, status: "received" } });
  await expect(reviewHumanIssue(db, issue.id, { action: "accept", review_request_id: request.id, review_revision: 1 })).rejects.toThrow();
  updateIssue(db, issue.id, { status: "done" });
  expect(readHumanFeedback(db, issue.id)?.status).toBe("completed");
});

test("reserved, resumed and ended Runs distinguish receipt, execution and PI acceptance", async () => {
  const { db, issue, request } = await fixture();
  updateIssue(db, issue.id, { status: "in_progress" });
  const run = createIssueRun(db, issue.id);
  recordIssueEvent(db, issue.id, "issue.human_revision_requested.v1", { request_id: request.id, revision: 1, feedback: "补充测试", new_run_id: run.id });
  expect(readHumanFeedback(db, issue.id)?.status).toBe("received");
  recordIssueEvent(db, issue.id, "issue.human_revision_resumed.v1", { request_id: request.id, revision: 1, new_run_id: run.id });
  expect(readHumanFeedback(db, issue.id)).toMatchObject({ status: "executing", run: { id: run.id, attempt: 2 } });
  db.sqlite.run("update issue_runs set status='succeeded', ended_at='2026-09-29' where id=?", [run.id]);
  expect(readHumanFeedback(db, issue.id)?.status).toBe("received");
  updateIssue(db, issue.id, { status: "failed" });
  expect(readHumanFeedback(db, issue.id)?.status).toBe("failed");
  updateIssue(db, issue.id, { status: "cancelled" });
  expect(readHumanFeedback(db, issue.id)?.status).toBe("cancelled");
});

test("resume failure preserves feedback and a new question is shown as needing input", async () => {
  const { db, issue, request } = await fixture();
  updateIssue(db, issue.id, { status: "in_progress" });
  const run = createIssueRun(db, issue.id);
  recordIssueEvent(db, issue.id, "issue.human_revision_requested.v1", { request_id: request.id, revision: 1, feedback: "补充真实检查", new_run_id: run.id });
  recordIssueEvent(db, issue.id, "issue.human_revision_resume_failed.v1", { request_id: request.id, revision: 1, run_id: run.id, error: "resume unavailable" });
  expect(readHumanFeedback(db, issue.id)).toMatchObject({ status: "failed", feedback: "补充真实检查", error: "resume unavailable" });
  updateIssue(db, issue.id, { status: "needs_user" });
  const next = createHumanReviewRequest(db, issue.id, { question: "请提供测试环境" });
  expect(readHumanFeedback(db, issue.id)).toMatchObject({ status: "needs_input", review_request_id: request.id, review_revision: 1, next_question: next.question });
});

test("mismatched revision and unrelated Run never produce executing feedback", async () => {
  const { db, issue, request } = await fixture();
  recordIssueEvent(db, issue.id, "issue.human_revision_requested.v1", { request_id: request.id, revision: 99, feedback: "stale", new_run_id: "foreign-run" });
  expect(readHumanFeedback(db, issue.id)).toBeNull();
});
