import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { RunnerDatabase } from "../../database.ts";
import { runMigrations } from "../../migrations.ts";
import { loadPiActivityRows } from "./activityTimelineScope.ts";
import { listPiActivityTimeline } from "./activityTimeline.ts";
import { createContextBundle } from "../contextBundles.ts";
import { createExternalEvent } from "../externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun } from "../intakeRuns.ts";
import { projectPendingEventSummaries } from "../../../events/eventSummaryProjector.ts";
import { listEventSummaryProjection } from "../eventSummaryProjection.ts";
import { listCompactEventSummaryProjection, projectPendingCompactEventSummaries } from "../compactEventSummaryProjection.ts";
import { buildPiActivityNodes } from "./activityTimelineNodes.ts";
import { emptyActivityScope } from "./activityTimelineTypes.ts";
import { hydrateActivityEntities } from "./activityTimelineReads.ts";

test("activity loads only the requested issue or conversation Actions before reading payloads", () => {
  const db = fixture();
  try {
    const issueRows = loadPiActivityRows(db, { issueId: 967 });
    expect(issueRows.actions.map(row => row.id)).toEqual(["target"]);
    const conversationRows = loadPiActivityRows(db, { conversationId: "target-conversation" });
    expect(conversationRows.actions.map(row => row.id)).toEqual(["target"]);
  } finally { db.close(); }
});

test("unfiltered activity starts from bounded recent Actions rather than the entire history", () => {
  const db = fixture();
  try {
    const rows = loadPiActivityRows(db, {});
    expect(rows.actions.length).toBeLessThanOrEqual(500);
    expect(rows.actions.map(row => row.id)).toContain("target");
    expect(rows.actions.map(row => row.id)).not.toContain("unrelated-0000");
  } finally { db.close(); }
});

test("historical conversation windows filter audits before the row limit", () => {
  const db = fixture();
  try {
    const insert = db.sqlite.query(`insert into pi_action_events
      (action_id, conversation_id, event_type, created_at) values (?, 'target-conversation', 'tool_call_audit', ?)`);
    insert.run("target", "2026-01-02T00:00:00Z");
    for (let i = 0; i < 600; i++) insert.run(`newer-${i}`, "2026-09-29T00:00:00Z");
    const timeline = listPiActivityTimeline(db, {
      conversationId: "target-conversation", since: "2026-01-01T00:00:00Z", until: "2026-01-03T00:00:00Z"
    });
    expect(timeline.items.some(row => row.kind === "tool_call" && row.refs.action_id === "target")).toBe(true);
    expect(timeline.items.some(row => String(row.refs.action_id).startsWith("newer-"))).toBe(false);
  } finally { db.close(); }
});

test("limits every initial entity read and avoids unrelated details for exact issue requests", () => {
  const db = fixture();
  try {
    db.sqlite.run("insert into projects(id,name,cwd,created_at,updated_at) values('demo','Demo','/tmp/demo','2026-01-01','2026-01-01')");
    db.sqlite.transaction(() => {
      for (let index = 0; index < 700; index++) {
        db.sqlite.run("insert into issues(id,project_id,title,status,created_at,updated_at) values(?,'demo','Other','triage','2026-09-29','2026-09-29')", [index + 1]);
        db.sqlite.run("insert into pi_action_proposals(id,summary,actions_json) values(?,'Other',?)", [`other-${index}`, proposalActions()]);
        db.sqlite.run("insert into im_reply_drafts(source,content,created_at,updated_at) values('other','Other','2026-09-29','2026-09-29')");
        db.sqlite.run("insert into sync_outbox(source,content,created_at,updated_at) values('other','Other','2026-09-29','2026-09-29')");
      }
    })();
    const broad = loadPiActivityRows(db, {});
    for (const rows of [broad.issues, broad.proposals, broad.replies, broad.syncOutbox]) {
      expect(rows.length).toBeLessThanOrEqual(500);
    }
    const narrow = loadPiActivityRows(db, { issueId: 967 });
    expect(narrow.proposals).toHaveLength(0);
    expect(narrow.replies).toHaveLength(0);
    expect(narrow.syncOutbox).toHaveLength(0);
  } finally { db.close(); }
});

test("keeps an explicitly selected old inbox and proposal chain beyond the recent row limit", () => {
  const db = fixture();
  try {
    const old = seedInbox(db, "2026-01-01T00:00:00Z");
    const recent = seedInbox(db, "2026-09-29T00:00:00Z");
    for (let index = 0; index < 600; index++) db.sqlite.run(`insert into attention_inbox_items
      (source,bundle_id,intake_run_id,title,summary,primary_intent,confidence,created_at,updated_at)
      values('other',?,?,'Other','Other','bug_report',1,'2026-09-29','2026-09-29')`, [recent.bundleID, recent.runID]);
    db.sqlite.run(`insert into pi_action_proposals(id,skill_run_id,source_item_ids_json,actions_json,summary,created_at,updated_at)
      values('old-proposal','target',?,?,'Old proposal','2026-01-01','2026-01-01')`, [JSON.stringify([`attention_inbox_item:${old.itemID}`]), proposalActions()]);
    for (const filter of [{ inboxItemId: old.itemID }, { proposalId: "old-proposal" }]) {
      const ids = listPiActivityTimeline(db, { ...filter, limit: 500 }).items.map(item => item.id);
      expect(ids).toContain(`inbox_item:${old.itemID}`);
      expect(ids).toContain("proposal:old-proposal");
      expect(ids).toContain(`raw_event:${old.eventID}`);
      expect(ids).not.toContain(`inbox_item:${recent.itemID}`);
    }
  } finally { db.close(); }
});

function seedInbox(db: RunnerDatabase, at: string) {
  const date = new Date(at);
  const event = createExternalEvent(db, { source: "fixture", external_id: at, content: "Fixture" }, date);
  const bundle = createContextBundle(db, {
    source: "fixture", event_refs: [event.id], created_by: "system", trigger: "manual", reason: "fixture",
    window: { from: at, to: at }
  }, date);
  const run = createIntakeRun(db, { bundle_id: bundle.id, skill_id: "fixture", status: "succeeded" }, date);
  const item = createAttentionInboxItem(db, {
    source: "fixture", bundle_id: bundle.id, intake_run_id: run.id, title: "Fixture", summary: "Fixture",
    primary_intent: "bug_report", confidence: 1, evidence_refs: [`external_event:${event.id}`], suggested_actions: []
  }, date);
  return { bundleID: bundle.id, eventID: event.id, itemID: item.id, runID: run.id };
}

test("historical issue summaries filter both projection formats before the latest row limit", () => {
  const db = fixture();
  try {
    seedIssue(db);
    const insert = db.sqlite.query("insert into issue_events(issue_id,type,payload,created_at) values(967,'status', '{}',?)");
    insert.run("2026-01-01T00:00:00.000Z");
    for (let index = 0; index < 600; index++) insert.run("2026-09-29T00:00:00Z");
    projectPendingEventSummaries(db);
    projectPendingCompactEventSummaries(db);
    const window = { since: "2026-01-01T08:00:00+08:00", until: "2026-01-02T00:00:00Z" };
    for (const list of [listEventSummaryProjection, listCompactEventSummaryProjection]) {
      expect(list(db, { issueID: 967, limit: 500, ...window }).map(row => row.source_event_id)).toEqual([1]);
    }
    for (const version of ["v1", "v2"]) {
      db.sqlite.run("update event_summary_projection_switch set read_version=?", [version]);
      expect(listPiActivityTimeline(db, { issueId: 967, ...window }).items.map(item => item.id)).toContain("issue_event:1");
    }
  } finally { db.close(); }
});

test("issue run nodes remain bounded while historical windows can select an old run", () => {
  const db = fixture();
  try {
    seedIssue(db);
    const insert = db.sqlite.query("insert into issue_runs(id,issue_id,attempt,status,started_at) values(?,967,?,'completed',?)");
    for (let index = 0; index < 601; index++) insert.run(`run-${index}`, index + 1,
      index === 0 ? "2026-01-01T00:00:00Z" : "2026-09-29T00:00:00Z");
    const scope = emptyActivityScope("");
    scope.issueIds.add(967);
    const nodes = buildPiActivityNodes(db, loadPiActivityRows(db, { issueId: 967 }), scope);
    expect(nodes.filter(item => item.kind === "session").length).toBeLessThanOrEqual(500);
    const historical = listPiActivityTimeline(db, { issueId: 967, until: "2026-01-02T00:00:00Z" });
    expect(historical.items.map(item => item.id)).toContain("issue_run:run-0");
  } finally { db.close(); }
});

test("reverse issue references apply token boundaries before limiting related rows", () => {
  const db = fixture();
  try {
    seedIssue(db);
    db.sqlite.run(`insert into issues(id,project_id,title,status,source_excerpt,created_at,updated_at)
      values(968,'demo','Old true relation','triage','issue:9670 then issue:967','2026-01-01','2026-01-01')`);
    for (let index = 0; index < 600; index++) db.sqlite.run(`insert into issues
      (id,project_id,title,status,source_excerpt,created_at,updated_at)
      values(?,'demo','False prefix','triage','issue:9670','2026-09-29','2026-09-29')`, [index + 1]);
    const rows = loadPiActivityRows(db, { issueId: 967 });
    const scope = emptyActivityScope("");
    scope.issueIds.add(967);
    hydrateActivityEntities(db, rows, scope);
    expect(rows.issues.map(item => item.id)).toContain(968);
    expect(rows.issues.some(item => item.title.includes("False prefix"))).toBe(false);
  } finally { db.close(); }
});

function seedIssue(db: RunnerDatabase): void {
  db.sqlite.run("insert into projects(id,name,cwd,created_at,updated_at) values('demo','Demo','/tmp/demo','2026-01-01','2026-01-01')");
  db.sqlite.run("insert into issues(id,project_id,title,status,created_at,updated_at) values(967,'demo','Target','triage','2026-09-29','2026-09-29')");
}

function proposalActions(): string {
  return JSON.stringify([{ type: "issue.create", payload: { title: "Fixture", project_id: "demo" }, risk: "low", requires_approval: false }]);
}

function fixture(): RunnerDatabase {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite);
  const insert = sqlite.query(`insert into pi_actions
    (id, issue_id, conversation_id, action_type, status, payload_json, created_at, updated_at)
    values (?, ?, ?, 'issue.read', 'completed', ?, ?, ?)`);
  sqlite.transaction(() => {
    for (let i = 0; i < 700; i++) insert.run(`unrelated-${String(i).padStart(4, "0")}`, 10, "other", "{}", "2026-01-01", "2026-01-01");
    insert.run("target", 967, "target-conversation", "{}", "2026-09-29", "2026-09-29");
  })();
  return { sqlite, readonly: false, path: ":memory:", close: () => sqlite.close(), transaction: fn => sqlite.transaction(fn) };
}
