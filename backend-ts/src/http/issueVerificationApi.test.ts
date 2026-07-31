import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { recordHandoff } from "../db/repositories/handoffs.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import { createHumanReviewRequest } from "../domain/review/humanReview.ts";
import type { AgenticWorkerClient } from "../agentic/protocol.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-issue-verification-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun issue verification API", () => {
  test("accept finalizes pending verification to done and records review events", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const issueId = insertIssue(database, { error: "bun test passed", status: "pending_verification" });
      seedReadyHandoff(database, issueId);
      const review = createHumanReviewRequest(database, issueId, {
        question: "是否接受当前交付并完成 Issue？"
      });
      const response = await reviewIssue(database, issueId, {
        action: "accept",
        comment: "人工验收通过",
        review_request_id: review.id,
        review_revision: review.revision
      });
      const body = await response.json() as Record<string, unknown>;
      const events = listEvents(database);

      expect(response.status).toBe(200);
      expect(body).toMatchObject({ id: issueId, status: "done", error: "" });
      expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
        "handoff.prepared.v1",
        "issue.comment",
        "issue.verification_human_evidence.v1",
        "evidence.recorded.v1",
        "issue.verification_gate_intent.v1",
        "handoff.delivery_requested.v1",
        "issue.status_changed",
        "issue.verification_gate_outcome.v1",
        "issue.verification_report",
        "issue.verification_reviewed"
      ]));
      expect(JSON.parse(events.find((event) => event.type === "issue.verification_reviewed")!.payload)).toEqual({
        action: "accept",
        comment: "人工验收通过",
        status: "done"
      });
      expect(JSON.parse(events.find((event) => event.type === "issue.verification_gate_outcome.v1")?.payload ?? "{}")).toMatchObject({
        evaluation: {
          decision: "overridden",
          override: { applied: true },
          satisfied: true
        },
        target_status: "done"
      });
      expect(JSON.parse(events.find((event) => event.type === "issue.verification_report")?.payload ?? "{}")).toMatchObject({
        structured_review: {
          verdict: "pass",
          gate_consistency: { expected_status: "done", policy_decision: "overridden" },
          recommended_next_action: { action: "complete_via_gate" }
        }
      });
    } finally {
      database.close();
    }
  });

  test("reject records the decision while request_changes fails closed without a resumable Session", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const rejectedId = insertIssue(database, { error: "evidence", status: "pending_verification" });
      const changesId = insertIssue(database, { error: "evidence", status: "pending_verification" });

      const rejectedReview = createHumanReviewRequest(database, rejectedId, { question: "是否拒绝当前交付？" });
      const changesReview = createHumanReviewRequest(database, changesId, { question: "是否接受当前实现？" });
      const rejected = await reviewIssue(database, rejectedId, {
        action: "reject",
        comment: "缺少测试",
        review_request_id: rejectedReview.id,
        review_revision: rejectedReview.revision
      });
      const changes = await reviewIssue(database, changesId, {
        action: "request_changes",
        comment: "补 smoke",
        review_request_id: changesReview.id,
        review_revision: changesReview.revision
      });

      expect(rejected.status).toBe(200);
      expect(await rejected.json()).toMatchObject({ id: rejectedId, status: "failed", error: "缺少测试" });
      expect(changes.status).toBe(400);
      expect(await changes.json()).toEqual({
        message: "无法继续原 Session：未找到带 provider_session_id 的历史 Run"
      });
      expect(getIssueStatus(database, changesId)).toBe("pending_verification");
    } finally {
      database.close();
    }
  });

  test("returns stable errors for invalid verification payloads", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      const pendingId = insertIssue(database, { error: "evidence", status: "pending_verification" });
      const todoId = insertIssue(database, { error: "", status: "todo" });

      const invalidAction = await reviewIssue(database, pendingId, { action: "bogus" });
      const wrongStatus = await reviewIssue(database, todoId, { action: "accept" });
      const missing = await reviewIssue(database, 404, { action: "accept" });
      const invalidJson = await createDefaultRouter({ database }).handle(new Request(`${BASE_URL}/api/issues/${pendingId}/verification`, {
        method: "POST",
        body: "{bad-json",
        headers: { "content-type": "application/json" }
      }));

      expect(invalidAction.status).toBe(400);
      expect(await invalidAction.json()).toEqual({ message: "verification action 必须是 accept、reject 或 request_changes" });
      expect(wrongStatus.status).toBe(409);
      expect(await wrongStatus.json()).toEqual({
        message: "当前没有等待人类处理的验收请求；PI 仍负责自主验证或修复"
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "资源不存在" });
      expect(invalidJson.status).toBe(400);
      expect(await invalidJson.json()).toEqual({ message: "请求体不是合法 JSON" });
    } finally {
      database.close();
    }
  });

  test("accepting a decision immediately dispatches a real PI verification cycle", async () => {
    const database = await openFixtureDatabase();
    let calls = 0;
    try {
      insertProject(database, "demo");
      database.sqlite.run(
        `insert into project_pi_settings (project_id, created_at, updated_at)
         values ('demo', ?, ?)`,
        ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
      );
      const issueId = insertIssue(database, { error: "", status: "pending_verification" });
      const review = createHumanReviewRequest(database, issueId, {
        kind: "decision",
        question: "是否接受当前技术与产品取舍？"
      });
      const agenticClient = fakeAgenticClient(async () => {
        calls += 1;
        return { status: "completed" };
      });
      const response = await reviewIssue(database, issueId, {
        action: "accept",
        review_request_id: review.id,
        review_revision: review.revision
      }, agenticClient);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: issueId,
        status: "pending_verification"
      });
      await waitUntil(() => calls === 1);
      await waitUntil(() => listEvents(database).some((event) =>
        event.type === "issue.pi_verification_waiting.v1"
      ));
      expect(listEvents(database).map((event) => event.type)).toEqual(expect.arrayContaining([
        "issue.pi_verification_queued.v1",
        "issue.pi_verification_started.v1",
        "issue.pi_verification_waiting.v1"
      ]));
    } finally {
      database.close();
    }
  });
});

function reviewIssue(
  db: RunnerDatabase,
  id: number,
  body: Record<string, unknown>,
  agenticClient?: AgenticWorkerClient
): Promise<Response> {
  return createDefaultRouter({ agenticClient, database: db }).handle(new Request(`${BASE_URL}/api/issues/${id}/verification`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

type IssueFixture = {
  error: string;
  status: string;
};

function insertIssue(db: RunnerDatabase, issue: IssueFixture): number {
  db.sqlite.run(
    `insert into issues (project_id, title, status, error, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Verification API", issue.status, issue.error, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing inserted issue id");
  return row.id;
}

function getIssueStatus(db: RunnerDatabase, issueID: number): string {
  return db.sqlite.query<{ status: string }, [number]>(
    "select status from issues where id=?"
  ).get(issueID)?.status ?? "";
}

function insertProject(db: RunnerDatabase, id: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function seedReadyHandoff(db: RunnerDatabase, issueID: number): void {
  const runLocalID = `issue-${issueID}-attempt-1`;
  const runID = `xw:run:issue_runs:${runLocalID}` as EvidenceRecord["run_id"];
  const workID = `xw:work:issues:${issueID}` as EvidenceRecord["work_id"];
  const at = "2026-01-01T00:01:00.000Z";
  db.sqlite.run(
    `insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
     values (?, ?, 1, 'done', ?, ?)`,
    [runLocalID, issueID, "2026-01-01T00:00:00.000Z", at]
  );
  const evidence: EvidenceRecord = {
    schema_version: 1,
    id: `xw:evidence:git:manual-review-${issueID}`,
    work_id: workID,
    run_id: runID,
    revision: 0,
    kind: "git",
    status: "passed",
    created_at: at,
    observed_at: at,
    updated_at: at,
    completed_at: at,
    decisive_output: { summary: "fixture Git delivery", facts: {} },
    artifact_refs: [{ kind: "diff", ref: `fixture:diff:${issueID}` }],
    provenance: {
      assertion_origin: "system_observation",
      source_kind: "git_repository",
      source_ref: "fixture:git",
      audit_event_ref: `fixture:git:${issueID}`,
      producer: { id: "issue-verification-test", kind: "runner" }
    },
    redaction: { status: "not_required", policy_ref: "fixture:redaction", redacted_paths: [] }
  };
  recordEvidenceRecords(db, issueID, [evidence], { recorded_at: at, source: "issue-verification-test" });
  const revision = `git-snapshot-manifest:sha256:${"b".repeat(64)}`;
  recordHandoff(db, issueID, {
    schema_version: 1,
    id: `xw:handoff:derived:manual-review-${issueID}`,
    work_id: workID,
    run_ids: [runID!],
    evidence_ids: [evidence.id],
    revision: 0,
    status: "ready",
    summary: "Fixture delivery ready for manual review",
    created_at: at,
    updated_at: at,
    baseline_revision: "a".repeat(40),
    final_revision: revision,
    review_ref: evidence.id,
    changed_files: ["fixture.ts"],
    delivery: { mode: "local_changes", working_tree_ref: revision },
    delivery_actions: [],
    risks: [],
    rollback: { availability: "not_required", destructive: false, refs: [evidence.id] },
    review: { required: false, state: "not_requested", reviewer_refs: [] }
  }, { recorded_at: at, source: "issue-verification-test" });
}

function listEvents(db: RunnerDatabase): Array<{ payload: string; type: string }> {
  return db.sqlite.query<{ payload: string; type: string }, []>(
    "select type, payload from issue_events order by id asc"
  ).all();
}

function fakeAgenticClient(
  runProjectCycle: AgenticWorkerClient["runProjectCycle"]
): AgenticWorkerClient {
  return {
    activity: () => ({ in_flight: 0, last_activity_at: "" }),
    decideCommunication: async () => ({ decision: "send", message: "test", rationale: "test" }),
    decideSupervisor: async () => ({
      decision: {
        confidence: "high",
        decision: "noop",
        evidence_refs: ["test"],
        expected_outcome: "test",
        fallback_if_no_progress: "blocked",
        rationale: "test",
        risk_level: "low"
      },
      raw_text: "",
      valid: true
    }),
    health: async () => ({ ok: true, role: "agentic" }),
    runProjectCycle
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("timed out waiting for PI verification dispatch");
}
