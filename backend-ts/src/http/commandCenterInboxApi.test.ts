import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { ATTENTION_INBOX_SEED_SQL, ATTENTION_RELATED_INBOX_SQL, createAttentionInboxItem, createIntakeRun, type AttentionInboxItemInput } from "../db/repositories/intakeRuns.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createActionProposal, createPiAction, createPiApprovalRequest, upsertPiGuardianAlert } from "../db/repositories/pi.ts";
import { getPersistedAttention, listPersistedAttention, persistAttentionCommand } from "../domain/attention/persistence.ts";
import { createHumanReviewRequest } from "../domain/review/humanReview.ts";
import { issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { attentionHandling, attentionIsVisible, readInboxAttention, registerCommandCenterRoutes } from "./commandCenterApi.ts";
import { createRouter } from "./router.ts";
import { registerWorkRoutes } from "./workApi.ts";
import type { InboxItem, InboxReaders } from "./commandCenterInbox.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture(inboxReaders?: Partial<InboxReaders>) {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-inbox-api-")); roots.push(root);
  const db = await openDatabase({ stateDir: root });
  const now = new Date();
  db.sqlite.run("insert into projects (id,name,cwd,provider,created_at,updated_at) values ('fixture','Fixture','/tmp/fixture','codex',?,?)", [now.toISOString(), now.toISOString()]);
  const bundle = createContextBundle(db, { created_by: "system", event_refs: [1], reason: "fixture", source: "fixture", trigger: "manual", window: { from: now.toISOString(), to: now.toISOString() } });
  const run = createIntakeRun(db, { bundle_id: bundle.id, skill_id: "fixture", status: "succeeded" });
  const inbox = (overrides: Partial<AttentionInboxItemInput> = {}) => createAttentionInboxItem(db, {
    bundle_id: bundle.id, intake_run_id: run.id, confidence: 1, evidence_refs: ["fixture:1"], primary_intent: "input",
    suggested_actions: [], source: "fixture", title: "Fixture", summary: "Fixture input", status: "new", ...overrides
  });
  const oldAction = (id: string, overrides = {}) => {
    createPiAction(db, { id, action_type: "no_action", status: "pending", gate_decision: "ask", rationale: "Old fixture", ...overrides });
    db.sqlite.run("update pi_actions set updated_at=? where id=?", [new Date(now.getTime() - 8 * 86400000).toISOString(), id]);
  };
  // A poisoned write handle proves GET uses the read handle; query_only additionally
  // catches indirect writes through repositories and projection replays.
  const router = createRouter();
  registerCommandCenterRoutes(router, { database: {} as RunnerDatabase, readDatabase: db }, { now: () => now, inboxReaders });
  registerWorkRoutes(router, { database: {} as RunnerDatabase, readDatabase: db });
  const get = (path = "/api/command-center/inbox") => router.handle(new Request(`http://fixture${path}`));
  return { db, now, inbox, oldAction, get };
}
function summaryFields(item: Record<string, any>) {
  return { id: item.id, status: item.status, revision: item.revision, source_refs: item.source_refs };
}
function byID(a: { id: string }, b: { id: string }) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

test("Inbox preserves review fields, Work list serialization/revision, associations and preparing semantics without writes", async () => {
  const { db, inbox, get } = await fixture();
  try {
    const human = createIssue(db, { project_id: "fixture", title: "Human", status: "needs_user" });
    createHumanReviewRequest(db, human.id, { question: "Old request" });
    const request = createHumanReviewRequest(db, human.id, {
      kind: "risk_acceptance", question: "Proceed?", recommendation: "Inspect evidence", consequences: "Possible failure",
      acceptance_summary: ["Summary"], evidence_refs: ["fixture:evidence"], excluded_scope: ["Deployment"]
    });
    const preparing = createIssue(db, { project_id: "fixture", title: "Preparing", status: "needs_user" });
    const failed = createIssue(db, { project_id: "fixture", title: "Failed", status: "failed" });
    inbox({ schema_item: { issue_id: human.id, project_id: "fixture" } });
    const changes = db.sqlite.query("select total_changes() as count").get();
    db.sqlite.run("pragma query_only=on");
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ complete: true, failed_sources: [], total: 4, counts: { human_review: 1, preparing: 1, failed_work: 1, attention: 1 }, next_cursor: null });
    const review = body.items.find((item: InboxItem) => item.source === "human_review");
    expect(review).toMatchObject({ key: `human_review:${request.id}`, work_id: issueIDToWorkID(human.id), project_id: "fixture", attention_id: null, review_request_id: request.id, review_revision: 2, occurred_at: request.created_at, actionable: true });
    expect(review.request).toEqual(request);
    expect(body.items.at(-1)).toMatchObject({ key: `preparing:${issueIDToWorkID(preparing.id)}`, actionable: false });
    expect(body.items.at(-1).occurred_at).toBe(body.items.at(-1).work.updated_at);
    const failedItem = body.items.find((item: InboxItem) => item.source === "failed_work");
    const works = await (await get("/api/works?status=failed")).json();
    expect(failedItem.work).toEqual(works.items[0]);
    expect(failedItem.work.revision).toBeGreaterThan(0);
    expect(failedItem).toMatchObject({ work_id: issueIDToWorkID(failed.id), occurred_at: works.items[0].updated_at });
    expect(body.items.find((item: InboxItem) => item.source === "attention")).toMatchObject({ work_id: review.work_id, project_id: "fixture" });
    expect(db.sqlite.query("select total_changes() as count").get()).toEqual(changes);
  } finally { db.close(); }
});

test("Inbox HTTP errors validate before reads and one failed source cannot hide successful sources", async () => {
  const { db, inbox, get } = await fixture({ human_review: () => { throw new Error("private failure details"); } });
  try {
    inbox(); db.sqlite.run("pragma query_only=on");
    for (const query of ["limit=0", "limit=51", "limit=1&limit=2", "cursor=e30", "unknown=1"]) {
      expect((await get(`/api/command-center/inbox?${query}`)).status).toBe(400);
    }
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ complete: false, failed_sources: ["human_review"], total: 1, counts: { human_review: 0, attention: 1 } });
    expect(JSON.stringify(body)).not.toContain("private failure details");
    const invalid = createRouter(); registerCommandCenterRoutes(invalid, { database: {} as RunnerDatabase });
    expect((await invalid.handle(new Request("http://fixture/api/command-center/inbox?unknown=1"))).status).toBe(400);
  } finally { db.close(); }
});

test("mixed Inbox projection equals full consolidation, preserving canonical IDs and command overlays beyond both windows", async () => {
  const { db, now, inbox, oldAction, get } = await fixture();
  try {
    const expectedOpen = new Set<string>();
    db.transaction(() => {
      for (let i = 0; i < 600; i++) {
        const row = inbox({ status: i % 2 ? "new" : "proposal_created", schema_item: { issue_id: 900000 + i } });
        expectedOpen.add(`xw:attention:attention_inbox_items:${row.id}`);
      }
      for (let i = 0; i < 80; i++) inbox({ status: ["ignored", "actioned", "triaged"][i % 3], schema_item: { issue_id: 800000 + i } });
      for (let i = 0; i < 30; i++) oldAction(`old-${i}`);
    }).immediate();
    const merged: string[] = [];
    for (const state of ["visible", "acknowledged", "snoozed", "elapsed"]) {
      const action = `merge-${state}`;
      const row = inbox({ status: "ignored", primary_intent: "approval", schema_item: { approval_id: `\u00a0${action}\t` } });
      // Also exercise evidence-based correlation and exact owner/type filtering.
      inbox({ status: "actioned", primary_intent: "approval", evidence_refs: [` approval:${action} `] });
      inbox({ status: "ignored", primary_intent: "approval", schema_item: { approval_id: action, project_id: "different" } });
      inbox({ status: "ignored", primary_intent: "input", schema_item: { approval_id: action } });
      oldAction(action);
      const id = `xw:attention:attention_inbox_items:${row.id}`; merged.push(id);
      if (state === "visible") continue;
      persistAttentionCommand(db, id, {
        action: state === "acknowledged" ? "acknowledge" : "snooze", expected_revision: 0,
        ...(state === "acknowledged" ? {} : { snoozed_until: new Date(now.getTime() + (state === "elapsed" ? -1000 : 3600000)).toISOString() }),
        audit: { actor: { id: "fixture", kind: "user" }, correlation_id: "fixture", event_id: state, gate: { authority: "human_approval", decision: "allow", policy_ref: "fixture" }, occurred_at: new Date(now.getTime() - 2000).toISOString(), reason: "Fixture overlay" }
      });
    }
    createPiApprovalRequest(db, { approval_id: "provider-request", status: "pending", summary: "Provider approval" });
    upsertPiGuardianAlert(db, { id: "guardian", alert_type: "provider_unavailable", severity: "critical", message: "Connection needs attention" });
    const terminal = createIssue(db, { project_id: "fixture", status: "done", title: "Historical" });
    oldAction("historical", { action_type: "issue.retry", issue_id: terminal.id });
    // Existing consolidation does not merge solely by proposal. Preserve both cards.
    const proposalRows = [inbox(), inbox()];
    createActionProposal(db, { id: "same-proposal", skill_run_id: "fixture", source_item_ids: proposalRows.map(row => `attention_inbox_item:${row.id}`), actions: [{ type: "no_action", payload: { reason: "fixture" }, requires_approval: false, risk: "low" }], status: "proposed", summary: "Fixture" });
    const summaryBefore = await (await get("/api/command-center/summary?sections=attention&limit=25")).json();
    db.sqlite.run("pragma query_only=on");
    const full = listPersistedAttention(db, { unbounded: true, now })
      .filter(item => attentionIsVisible(item, now) && attentionHandling(db, item, now) === "user_action_required");
    const actual: Record<string, any>[] = [];
    let cursor: string | null = null;
    do {
      const response = await get(`/api/command-center/inbox?limit=50${cursor ? `&cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({ complete: true, failed_sources: [], total: full.length });
      actual.push(...body.items.map((item: InboxItem) => item.attention)); cursor = body.next_cursor;
    } while (cursor);
    expect(actual.map(summaryFields).sort(byID)).toEqual(full.map(summaryFields).sort(byID));
    const ids = new Set(actual.map(item => item.id));
    expect(ids.size).toBe(actual.length);
    expect([...expectedOpen].every(id => ids.has(id))).toBe(true);
    expect(ids.has(merged[0])).toBe(true);
    expect(actual.find(item => item.id === merged[0]).source_refs).toHaveLength(3);
    expect(ids.has(merged[1])).toBe(false);
    expect(ids.has(merged[2])).toBe(false);
    expect(actual.find(item => item.id === merged[3])).toMatchObject({ revision: 1, status: "waiting" });
    expect(ids.has("xw:attention:pi_actions:historical")).toBe(false);
    for (const row of proposalRows) expect(ids.has(`xw:attention:attention_inbox_items:${row.id}`)).toBe(true);
    expect(ids.has("xw:attention:pi_actions:old-0")).toBe(true);
    expect((await get("/api/command-center/attention/xw%3Aattention%3Api_actions%3Aold-0")).status).toBe(200);
    expect(await (await get("/api/command-center/summary?sections=attention&limit=25")).json()).toEqual(summaryBefore);
    expect(summaryBefore.sections.attention.items.length).toBeLessThanOrEqual(25);
    expect(JSON.stringify(summaryBefore)).not.toContain("pi_actions:old-0");
  } finally { db.close(); }
});

test("related carrier SQL is conservative for every supported correlation while consolidation remains authoritative", async () => {
  const { db, now, inbox } = await fixture();
  try {
    const values = { approval_id: "approval", run_id: "run", issue_id: 123, work_id: "xw:work:issues:456", conversation_id: "conversation" };
    for (const [key, value] of Object.entries(values)) {
      inbox({ status: "ignored", schema_item: { [key]: value } });
      inbox({ schema_item: { [key]: value } });
    }
    for (const value of [1e-7, 1e21, 123.456]) {
      inbox({ status: "ignored", schema_item: { issue_id: value } });
      inbox({ schema_item: { issue_id: value } });
    }
    inbox({ status: "ignored", evidence_refs: ["run_group:one"] });
    inbox({ evidence_refs: ["run_group:one"] });
    // Matching a weaker correlation must not merge different strongest identities.
    inbox({ status: "ignored", evidence_refs: ["approval:other", "issue:123"] });
    db.sqlite.run("pragma query_only=on");
    const full = listPersistedAttention(db, { unbounded: true, now })
      .filter(item => attentionIsVisible(item, now) && attentionHandling(db, item, now) === "user_action_required");
    expect(readInboxAttention(db, now).map(item => summaryFields(item.attention!)).sort(byID)).toEqual(full.map(summaryFields).sort(byID));
    expect(full).toHaveLength(9);
    expect(full.every(item => item.source_refs.length === 2)).toBe(true);
  } finally { db.close(); }
});

test("elapsed reminders on triaged carriers retain the full projection identity", async () => {
  const { db, now, inbox } = await fixture();
  try {
    const old = new Date(now.getTime() - 2000).toISOString();
    for (const merged of [false, true]) {
      const schema = { issue_id: merged ? 778 : 777 };
      const carrier = inbox({ status: merged ? "ignored" : "triaged", schema_item: schema });
      if (merged) inbox({ status: "triaged", schema_item: schema });
      persistAttentionCommand(db, `xw:attention:attention_inbox_items:${carrier.id}`, {
        action: "snooze", expected_revision: 0, snoozed_until: new Date(now.getTime() - 1000).toISOString(),
        audit: { actor: { id: "fixture", kind: "user" }, correlation_id: "fixture", event_id: `triaged-${merged}`, gate: { authority: "human_approval", decision: "allow", policy_ref: "fixture" }, occurred_at: old, reason: "Fixture reminder" }
      });
    }
    db.sqlite.run("pragma query_only=on");
    const full = listPersistedAttention(db, { unbounded: true, now })
      .filter(item => attentionIsVisible(item, now) && attentionHandling(db, item, now) === "user_action_required");
    expect(full).toHaveLength(2);
    expect(readInboxAttention(db, now).map(item => summaryFields(item.attention!)).sort(byID)).toEqual(full.map(summaryFields).sort(byID));
  } finally { db.close(); }
});

test("complete Inbox with 200 reviews, 600 open, 30 old actions and 5000 inactive rows stays below the regression ceiling", async () => {
  const { db, inbox, oldAction, get } = await fixture();
  try {
    db.transaction(() => {
      for (let i = 0; i < 200; i++) {
        const issue = createIssue(db, { project_id: "fixture", status: "needs_user", title: `Review ${i}` });
        createHumanReviewRequest(db, issue.id, { question: "Fixture question" });
      }
      for (let i = 0; i < 5600; i++) inbox({ status: i < 600 ? "new" : i % 2 ? "ignored" : "actioned", schema_item: { issue_id: 900000 + i }, evidence_refs: [`issue:${900000 + i}`] });
      for (let i = 0; i < 30; i++) oldAction(`old-${i}`);
    }).immediate();
    db.sqlite.run("pragma query_only=on");
    const elapsed: number[] = [];
    for (let i = 0; i < 6; i++) {
      const start = performance.now();
      const response = await get(); const body = await response.json();
      elapsed.push(performance.now() - start);
      expect(response.status).toBe(200);
      expect(body).toMatchObject({ complete: true, total: 830, counts: { human_review: 200, preparing: 0, attention: 630, failed_work: 0 } });
    }
    // Warm median, deliberately generous for CI; catches order-of-magnitude regressions.
    expect(elapsed.slice(1).sort((a, b) => a - b)[2]).toBeLessThanOrEqual(500);
    const plan = (sql: string, args: string[] = []) => JSON.stringify(db.sqlite.query(`explain query plan ${sql}`).all(...args));
    expect(plan(ATTENTION_INBOX_SEED_SQL)).toContain("idx_attention_inbox_items_status");
    expect(plan(ATTENTION_RELATED_INBOX_SQL, [JSON.stringify(["issue:900000"])])).toContain("SCAN i");
  } finally { db.close(); }
});


test("Attention fast lookup equals full projection field-for-field for visible, overlaid, terminal and non-canonical IDs", async () => {
  const { db, now, inbox, oldAction } = await fixture();
  try {
    const ids: string[] = [];
    for (const state of ["visible", "acknowledged", "paused", "terminal", "merged"]) {
      const row = inbox({ status: state === "terminal" ? "ignored" : state === "merged" ? "ignored" : "new", primary_intent: "approval", schema_item: { approval_id: state } });
      const id = `xw:attention:attention_inbox_items:${row.id}`; ids.push(id);
      if (state === "merged") {
        oldAction(state);
        ids.push(`xw:attention:pi_actions:${state}`);
      }
      if (state === "acknowledged" || state === "paused") persistAttentionCommand(db, id, {
        action: state === "paused" ? "snooze" : "acknowledge", expected_revision: 0,
        ...(state === "paused" ? { snoozed_until: new Date(now.getTime() + 3600000).toISOString() } : {}),
        audit: { actor: { id: "fixture", kind: "user" }, correlation_id: "fixture", event_id: `lookup-${state}`, gate: { authority: "human_approval", decision: "allow", policy_ref: "fixture" }, occurred_at: now.toISOString(), reason: "Fixture lookup" }
      });
    }
    const group = [inbox({ status: "actioned", schema_item: { issue_id: 778 } }), inbox({ status: "ignored", schema_item: { issue_id: 778 } })];
    ids.push(...group.map(row => `xw:attention:attention_inbox_items:${row.id}`));
    // A terminal non-inbox target must also pull in its earlier canonical carrier.
    const guardianCarrier = inbox({ status: "ignored", primary_intent: "error", schema_item: { issue_id: 779 } });
    upsertPiGuardianAlert(db, { id: "terminal-guardian", alert_type: "failure", status: "resolved", issue_id: 779, severity: "high", message: "Terminal fixture" });
    ids.push(`xw:attention:attention_inbox_items:${guardianCarrier.id}`, "xw:attention:pi_guardian_alerts:terminal-guardian");
    const completed = createIssue(db, { project_id: "fixture", status: "done", title: "Historical" });
    oldAction("historical-lookup", { action_type: "issue.retry", issue_id: completed.id });
    oldAction("completed-action", { status: "completed" });
    ids.push("xw:attention:pi_actions:historical-lookup", "xw:attention:pi_actions:completed-action", "xw:attention:attention_inbox_items:99999", "malformed");
    for (let i = 0; i < 80; i++) inbox({ status: "ignored", schema_item: { issue_id: 900000 + i } });
    db.sqlite.run("pragma query_only=on");
    const full = listPersistedAttention(db, { unbounded: true });
    for (const id of ids) expect(getPersistedAttention(db, id)).toEqual(full.find(item => item.id === id) ?? null);
    expect(getPersistedAttention(db, ids[0])?.status).toBe("open");
    expect(getPersistedAttention(db, ids[1])?.status).toBe("acknowledged");
    expect(getPersistedAttention(db, ids[2])?.snoozed_until).toBeDefined();
    expect(getPersistedAttention(db, ids[3])?.status).toBe("dismissed");
    expect(getPersistedAttention(db, "xw:attention:pi_actions:merged")).toBeNull();
  } finally { db.close(); }
});
