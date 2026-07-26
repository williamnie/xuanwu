import { afterEach, describe, expect, test } from "bun:test";
import { performance } from "node:perf_hooks";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { clearEventSummaryProjection } from "../../db/repositories/eventSummaryProjection.ts";
import { EVENT_SUMMARY_PROJECTOR_VERSION, projectPendingEventSummaries } from "../../events/eventSummaryProjector.ts";
import { issueIDToWorkID } from "./issueAdapter.ts";
import { queryWorkTimeline, type WorkTimelineNode } from "./timeline.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("Work timeline projection", () => {
  test("combines authoritative sources in a stable cross-source order with source links", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedTimeline(db);
      const workID = issueIDToWorkID(issueID);
      const result = queryWorkTimeline(db, workID, { limit: 50 });

      expect(result).toMatchObject({
        has_more: false,
        next_cursor: "",
        schema_version: "xuanwu.work-timeline.v1",
        source_of_truth: {
          approval: "pi_approval_requests",
          issue_events: "issue_events-via-event_summary_projection",
          runs: "issue_runs",
          work: "issues"
        },
        summary_projection: {
          issue_event_projection_status: "ready",
          scope: "page"
        },
        work_id: workID
      });
      expect(result.items.map((item) => item.event_name)).toEqual([
        "evidence.recorded.v1",
        "attention.status_changed.v1",
        "run.status_changed.v1",
        "work_ledger.work_updated.v1",
        "handoff.prepared.v1",
        "evidence.recorded.v1",
        "issue.comment",
        "attention.opened.v1",
        "run.created.v1",
        "work.created.v1"
      ]);
      expect(result.items.map((item) => item.kind)).toEqual([
        "evidence", "approval", "run", "work_event", "handoff",
        "evidence", "issue_event", "approval", "run", "work_event"
      ]);
      expect(result.items.every((item) => item.source_links.some((link) => link.rel === "work"))).toBe(true);
      expect(result.items.find((item) => item.source.authority === "issue_events")?.source_links)
        .toEqual(expect.arrayContaining([expect.objectContaining({ rel: "source" }), expect.objectContaining({ rel: "summary" })]));
      const verification = result.items.find((item) => item.payload.issue_event_type === "issue.verification_report");
      const ledgerEvent = result.items.find((item) => item.source.authority === "work_events");
      const actionEvidence = result.items.find((item) => item.source.authority === "pi_action_events");
      expect(verification?.payload.source_sha256).not.toBe("spoofed");
      expect(ledgerEvent?.payload).toMatchObject({ outcome: "applied", reason: "metadata synchronized" });
      expect(actionEvidence?.payload.action_id).toBe("action-1");
      expect(new Set(result.items.map((item) => item.dedupe_key)).size).toBe(result.items.length);
    } finally {
      db.close();
    }
  });

  test("keeps keyset pages stable when newer events arrive and rejects duplicate rebuild nodes", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedTimeline(db);
      const workID = issueIDToWorkID(issueID);
      insertIssueEvent(db, issueID, "issue.comment", { body: "same timestamp" }, "2026-01-01T00:00:06Z");
      projectPendingEventSummaries(db);
      const first = queryWorkTimeline(db, workID, { limit: 3 });
      expect(first.has_more).toBe(true);
      expect(first.next_cursor).not.toBe("");

      insertIssueEvent(db, issueID, "issue.comment", { body: "arrived later" }, "2026-01-01T00:00:10Z");
      const remaining = collectPages(db, workID, first.next_cursor, 3);
      const combined = [...first.items, ...remaining];
      const combinedIDs = combined.map((item) => item.id);
      expect(combined.map((item) => item.summary)).not.toContain("arrived later");
      expect(combined).toHaveLength(11);
      expect(new Set(combinedIDs).size).toBe(combinedIDs.length);
      const tiedIDs = combined
        .filter((item) => item.occurred_at === "2026-01-01T00:00:06.000Z")
        .map((item) => item.id);
      expect(tiedIDs).toHaveLength(2);
      expect(tiedIDs).toEqual([...tiedIDs].sort().reverse());

      projectPendingEventSummaries(db);
      const beforeRebuild = queryWorkTimeline(db, workID, { limit: 50 }).items.map((item) => item.id);
      clearEventSummaryProjection(db, EVENT_SUMMARY_PROJECTOR_VERSION, "2026-01-01T01:00:00.000Z");
      projectPendingEventSummaries(db);
      const afterRebuild = queryWorkTimeline(db, workID, { limit: 50 }).items.map((item) => item.id);
      expect(afterRebuild).toEqual(beforeRebuild);
      expect(new Set(afterRebuild).size).toBe(afterRebuild.length);
    } finally {
      db.close();
    }
  });

  test("benchmarks a 12000-event Work query on the indexed summary projection", async () => {
    const db = await fixtureDatabase();
    try {
      const issueID = seedIssue(db);
      const insertMany = db.transaction(() => {
        for (let index = 0; index < 12_000; index += 1) {
          insertIssueEvent(db, issueID, "issue.log", {
            raw_method: "item/agentMessage/delta",
            text: `event-${index}`,
            type: "agent_message_delta"
          }, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
        }
      });
      insertMany.immediate();
      projectPendingEventSummaries(db);

      const startedAt = performance.now();
      const result = queryWorkTimeline(db, issueIDToWorkID(issueID), { limit: 100 });
      const elapsedMs = performance.now() - startedAt;
      const plan = db.sqlite.query<{ detail: string }, [number]>(`
        explain query plan select source_event_id from event_summary_projection
        where source='issue_events' and issue_id=? order by source_event_id desc limit 101
      `).all(issueID).map((row) => row.detail).join("\n");

      console.info(`[work-timeline benchmark] 12000 events first page: ${elapsedMs.toFixed(1)}ms`);
      expect(result.items).toHaveLength(100);
      expect(result.has_more).toBe(true);
      expect(plan).toContain("idx_event_summary_projection_issue");
      expect(elapsedMs).toBeLessThan(5_000);
    } finally {
      db.close();
    }
  }, 10_000);
});

function collectPages(
  db: RunnerDatabase,
  workID: ReturnType<typeof issueIDToWorkID>,
  initialCursor: string,
  limit: number
): WorkTimelineNode[] {
  const items: WorkTimelineNode[] = [];
  let cursor = initialCursor;
  while (cursor) {
    const page = queryWorkTimeline(db, workID, { cursor, limit });
    items.push(...page.items);
    cursor = page.next_cursor;
  }
  return items;
}

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "work-timeline-"));
  roots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function seedTimeline(db: RunnerDatabase): number {
  const issueID = seedIssue(db);
  const workID = issueIDToWorkID(issueID);
  insertIssueEvent(db, issueID, "issue.created", { title: "Timeline fixture" }, "2026-01-01T00:00:00Z");
  insertIssueEvent(db, issueID, "issue.comment", { author: "user", body: "scope confirmed" }, "2026-01-01T00:00:03Z");
  insertIssueEvent(db, issueID, "issue.verification_report", {
    issue_event_type: "spoofed",
    recommendation: "accept",
    source_sha256: "spoofed"
  }, "2026-01-01T00:00:04Z");
  insertIssueEvent(db, issueID, "issue.status_changed", { status: "pending_verification" }, "2026-01-01T00:00:05Z");
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at, exit_reason)
    values (?, ?, 1, 'done', 'codex', 'thread-1', ?, ?, 'completed')`, [
    `issue-${issueID}-attempt-1`, issueID, "2026-01-01T00:00:01Z", "2026-01-01T00:00:07Z"
  ]);
  insertWorkLedgerEvent(db, workID);
  insertApproval(db, issueID);
  db.sqlite.run(`insert into pi_action_events
    (action_id, project_id, issue_id, conversation_id, event_type, actor, decision,
     reason, payload_json, result_json, error, delegation_id, heartbeat_id, created_at)
    values ('action-1', 'demo', ?, '', 'execution_result', 'runner', 'allow',
      'focused verification passed', '{"action_id":"spoofed"}', '{"status":"passed"}', '', '', '', ?)`, [
    issueID, "2026-01-01T00:00:09Z"
  ]);
  projectPendingEventSummaries(db);
  return issueID;
}

function seedIssue(db: RunnerDatabase): number {
  db.sqlite.run(`insert or ignore into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/work-timeline-demo', ?, ?)`, [
    "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
  db.sqlite.run(`insert into issues (project_id, title, description, status, created_at, updated_at)
    values ('demo', 'Timeline fixture', 'Build timeline', 'in_progress', ?, ?)`, [
    "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
  return Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
}

function insertIssueEvent(
  db: RunnerDatabase,
  issueID: number,
  type: string,
  payload: Record<string, unknown>,
  createdAt: string
): void {
  db.sqlite.run("insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)", [
    issueID, type, JSON.stringify(payload), createdAt
  ]);
}

function insertWorkLedgerEvent(db: RunnerDatabase, workID: string): void {
  db.sqlite.run(`insert into works
    (id, project_id, type, title, goal, status, acceptance_json, provenance_json,
     workflow_ref, revision, created_at, updated_at)
    values (?, 'demo', 'engineering_task', 'Timeline fixture', 'Build timeline', 'in_progress',
      '{"criteria":[{"id":"tests","description":"tests","required":true}],"requires_handoff":true,"version":"v1"}',
      '{"causes":[],"origin":{"authority":"issues","external_id":"1","kind":"issue","occurred_at":"2026-01-01T00:00:00Z","completeness":"legacy_incomplete","missing_fields":["actor","correlation_id"]}}',
      'fixture:workflow', 1, ?, ?)`, [workID, "2026-01-01T00:00:00Z", "2026-01-01T00:00:06Z"]);
  db.sqlite.run(`insert into work_events
    (event_id, work_id, project_id, event_type, actor_json, reason, correlation_id,
     gate_authority, gate_decision, gate_policy_ref, expected_revision, before_revision,
     after_revision, outcome, payload_json, occurred_at, created_at)
    values ('work-update-1', ?, 'demo', 'work_ledger.work_updated.v1',
      '{"id":"runner","kind":"runner"}', 'metadata synchronized', 'correlation-1',
      'deterministic_policy', 'allow', 'fixture-policy', 0, 0, 1, 'applied',
      '{"outcome":"rejected","reason":"spoofed"}', ?, ?)`, [
    workID, "2026-01-01T00:00:06Z", "2026-01-01T00:00:06Z"
  ]);
}

function insertApproval(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(`insert into pi_approval_requests
    (approval_id, project_id, issue_id, run_id, provider, request_type, summary,
     request_summary, risk, status, decision, approval_source, provider_approval_id,
     resolved_decision, resolved_scope, resolved_at, raw_payload_json, created_at, updated_at)
    values ('approval-1', 'demo', ?, ?, 'codex', 'command', 'Allow test command',
      'Allow test command', 'medium', 'approved', 'approve', 'codex_provider_event',
      'approval-1', 'approve', 'turn', ?, '{}', ?, ?)`, [
    issueID,
    `issue-${issueID}-attempt-1`,
    "2026-01-01T00:00:08Z",
    "2026-01-01T00:00:02Z",
    "2026-01-01T00:00:08Z"
  ]);
}
