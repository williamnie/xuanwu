import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { recordHandoff } from "../db/repositories/handoffs.ts";
import { createAttentionInboxItem, createIntakeRun } from "../db/repositories/intakeRuns.ts";
import {
  createActionProposal,
  createPiAction,
  createPiApprovalRequest,
  upsertPiGuardianAlert
} from "../db/repositories/pi.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import {
  projectPendingCompactEventSummaries,
  updateEventSummaryProjectionSwitch
} from "../db/repositories/compactEventSummaryProjection.ts";
import type { HandoffRecord } from "../domain/handoff/contracts.ts";
import { issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { makeDomainID } from "../xuanwu/coreDomainContracts.ts";
import {
  commandCenterSectionReaders,
  registerCommandCenterRoutes
} from "./commandCenterApi.ts";
import { createRouter } from "./router.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const NOW = "2026-07-17T08:01:00.000Z";
const SOURCE_TIME = "2026-07-17T08:00:00.000Z";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { force: true, recursive: true });
  }
});

describe("Command Center aggregate API", () => {
  test("returns the versioned four-section summary with bounded items, counts, freshness, and links", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, {
        description: "Aggregate current product facts",
        project_id: "demo",
        status: "in_progress",
        title: "Command Center"
      });
      db.sqlite.run("update issues set created_at=?, updated_at=? where id=?", [SOURCE_TIME, SOURCE_TIME, issue.id]);
      db.sqlite.run("update issue_events set created_at=? where issue_id=?", [SOURCE_TIME, issue.id]);
      const runID = insertRun(db, issue.id);
      insertAttention(db);
      recordHandoff(db, issue.id, handoff(issue.id), {
        recorded_at: SOURCE_TIME,
        source: "command-center-test"
      });
      projectPendingCompactEventSummaries(db);
      updateEventSummaryProjectionSwitch(db, {
        cutover_at: "2026-07-17T08:00:01.000Z",
        expectedRevision: 0,
        observation_expires_at: "2026-07-17T08:00:01.000Z",
        observation_started_at: "2026-07-16T08:00:00.000Z",
        read_version: "v2",
        updatedAt: "2026-07-17T08:00:01.000Z"
      });
      const router = createRouter();
      registerCommandCenterRoutes(router, { database: db }, { now: () => new Date(NOW) });

      const response = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?limit=5`));
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body.contract).toBe("xw.command-center.summary.v1");
      expect(body.failed_sections).toEqual([]);
      expect(body.generated_at).toBe(NOW);
      expect(body.limits.maximum).toBe(25);
      expect(body.limits.requested).toBe(5);
      expect(body.partial).toBe(false);
      expect(body.requested_sections).toEqual(["attention", "active_work", "recent_deliveries", "system_health"]);
      expect(body.compatibility.attention_command_audit_authority)
        .toBe("attention_command_events-append-only-overlay");
      expect(body.compatibility.dual_write).toBe("none-legacy-facts-remain-single-writer");
      expect(body.compatibility.handoff_read_authority).toBe("issue_events:handoff.*.v1");
      expect(body.compatibility.work_read_authority).toBe("issues-via-Work-adapter");

      const activeWork = body.sections.active_work;
      expect(activeWork.status).toBe("ok");
      expect(activeWork.counts.returned).toBe(1);
      expect(activeWork.counts.total).toBe(1);
      expect(activeWork.freshness.queried_at).toBe(NOW);
      expect(activeWork.freshness.state).toBe("current");
      expect(activeWork.items).toHaveLength(1);
      expect(activeWork.items[0].id).toBe(issueIDToWorkID(issue.id));
      expect(activeWork.items[0].latest_run.id).toBe(runID);
      expect(activeWork.items[0].latest_run.phase).toBe("running");
      expect(activeWork.items[0].latest_run.status).toBe("running");
      expect(activeWork.items[0].links.self).toContain("/api/works/");
      expect(activeWork.items[0].readiness.status).toBe("not_required");
      expect(activeWork.items[0].status).toBe("in_progress");
      expect(activeWork.items[0].latest_run.progress).not.toHaveProperty("timeline");

      const attention = body.sections.attention;
      expect(attention.status).toBe("ok");
      expect(attention.counts.returned).toBe(1);
      expect(attention.counts.total).toBe(1);
      expect(attention.items).toHaveLength(1);
      expect(attention.items[0].id).toBe("xw:attention:attention_inbox_items:1");
      expect(attention.items[0].priority).toBe("p1");
      expect(attention.items[0].links.self).toBe("/api/pi/attention-inbox/items/1");
      expect(attention.items[0].status).toBe("open");

      const deliveries = body.sections.recent_deliveries;
      expect(deliveries.status).toBe("ok");
      expect(deliveries.counts.returned).toBe(1);
      expect(deliveries.counts.skipped_invalid).toBe(0);
      expect(deliveries.counts.total).toBe(1);
      expect(deliveries.items).toHaveLength(1);
      expect(deliveries.items[0].id).toBe(makeDomainID("handoff", "derived", `command-center-${issue.id}`));
      expect(deliveries.items[0].issue).toEqual({ id: issue.id, status: "in_progress", title: "Command Center" });
      expect(deliveries.items[0].links.view).toContain("#/work/");
      expect(deliveries.items[0].status).toBe("draft");

      const systemHealth = body.sections.system_health;
      expect(systemHealth.status).toBe("ok");
      expect(systemHealth.counts.running).toBe(1);
      expect(systemHealth.counts.total).toBe(1);
      expect(systemHealth.links.status).toBe("/api/system/status");
      expect(systemHealth.summary.database.status).toBe("ready");
      expect(systemHealth.summary.event_projection.lag_rows).toBe(0);
      expect(systemHealth.summary.event_projection.last_event_id).toBe(2);
      expect(systemHealth.summary.event_projection.status).toBe("ready");
      expect(systemHealth.summary.overall).toBe("healthy");
      expect(systemHealth.summary.run_progress.active_runs).toBe(1);
      expect(systemHealth.summary.run_progress.projection_mode).toBe("read_through_rebuild");
    } finally {
      db.close();
    }
  });

  test("isolates a failed section and still returns successful requested partitions", async () => {
    const db = await fixtureDatabase();
    try {
      insertAttention(db);
      const readers = commandCenterSectionReaders(db);
      const router = createRouter();
      registerCommandCenterRoutes(router, { database: db }, {
        now: () => new Date(NOW),
        readers: {
          recent_deliveries: () => {
            throw new Error("fixture repository unavailable");
          }
        }
      });

      const response = await router.handle(new Request(
        `${BASE_URL}/api/command-center/summary?sections=attention,recent_deliveries&limit=1`
      ));
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body).toMatchObject({
        failed_sections: ["recent_deliveries"],
        partial: true,
        requested_sections: ["attention", "recent_deliveries"],
        sections: {
          attention: { counts: { returned: 1 }, status: "ok" },
          recent_deliveries: {
            error: { code: "section_unavailable", message: "recent_deliveries query failed" },
            freshness: { state: "unknown" },
            status: "error"
          }
        }
      });
      expect(body.sections).not.toHaveProperty("active_work");
      expect(readers.attention({ limit: 1, now: new Date(NOW) }).counts.returned).toBe(1);
    } finally {
      db.close();
    }
  });

  test("projects multiple legacy Attention types and persists audited acknowledge/snooze commands", async () => {
    const db = await fixtureDatabase();
    try {
      insertAttention(db);
      upsertPiGuardianAlert(db, {
        alert_type: "provider_unavailable",
        id: "guardian-connection",
        issue_id: 0,
        message: "Provider connection is unavailable",
        project_id: "demo",
        severity: "critical"
      });
      createPiApprovalRequest(db, {
        approval_id: "approval-pending",
        issue_id: 0,
        project_id: "demo",
        request_type: "deploy",
        risk: "high",
        status: "pending",
        summary: "Approve the deployment"
      });
      const router = createDefaultRouter({ database: db });
      const before = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=attention&limit=10`));
      const beforeBody = await before.json() as Record<string, any>;
      const items = beforeBody.sections.attention.items as Array<Record<string, any>>;
      expect(before.status).toBe(200);
      expect(items.map((item) => item.type)).toEqual(expect.arrayContaining([
        "approval_required", "connection_issue"
      ]));
      expect(items.map((item) => item.priority)).toEqual(expect.arrayContaining(["p0", "p1"]));

      const target = items.find((item) => item.type === "connection_issue");
      const snooze = await router.handle(jsonRequest(
        `/api/command-center/attention/${encodeURIComponent(target.id)}/actions/snooze`,
        attentionCommand(target.revision, "snooze")
      ));
      const snoozed = await snooze.json() as Record<string, any>;
      expect(snooze.status).toBe(200);
      expect(snoozed).toMatchObject({
        attention: { id: target.id, revision: 1, status: "waiting", snoozed_until: "2026-07-17T09:00:00.000Z" },
        mutation: { audit_event: { operation: "snooze", gate: { decision: "allow" } } }
      });
      expect(db.sqlite.query<{ count: number }, []>("select count(*) as count from attention_command_events").get()?.count).toBe(1);

      const beforeReminderRouter = createRouter();
      registerCommandCenterRoutes(beforeReminderRouter, { database: db }, {
        now: () => new Date("2026-07-17T08:30:00.000Z")
      });
      const beforeReminder = await beforeReminderRouter.handle(new Request(
        `${BASE_URL}/api/command-center/summary?sections=attention&limit=10`
      ));
      const beforeReminderItems = ((await beforeReminder.json()) as Record<string, any>).sections.attention.items;
      expect(beforeReminderItems.find((item: Record<string, any>) => item.id === target.id)).toBeUndefined();

      const refreshed = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=attention&limit=10`));
      const refreshedItems = ((await refreshed.json()) as Record<string, any>).sections.attention.items;
      expect(refreshedItems.find((item: Record<string, any>) => item.id === target.id)).toMatchObject({ revision: 1, status: "waiting" });

      const stale = await router.handle(jsonRequest(
        `/api/command-center/attention/${encodeURIComponent(target.id)}/actions/acknowledge`,
        attentionCommand(0, "acknowledge")
      ));
      expect(stale.status).toBe(409);
      expect((await stale.json()) as Record<string, unknown>).toMatchObject({ message: expect.stringContaining("revision conflict") });

      const acknowledged = await router.handle(jsonRequest(
        `/api/command-center/attention/${encodeURIComponent(target.id)}/actions/acknowledge`,
        attentionCommand(1, "acknowledge")
      ));
      expect(acknowledged.status).toBe(200);
      expect(await acknowledged.json()).toMatchObject({ attention: { status: "acknowledged" } });
      const afterAck = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=attention&limit=10`));
      const afterAckItems = ((await afterAck.json()) as Record<string, any>).sections.attention.items;
      expect(afterAckItems.find((item: Record<string, any>) => item.id === target.id)).toBeUndefined();
    } finally {
      db.close();
    }
  });

  test("shows only user-owned incidents while PI-handled and recovered alerts become an operations summary", async () => {
    const db = await fixtureDatabase();
    try {
      upsertPiGuardianAlert(db, {
        alert_type: "outbox_stalled", id: "guardian-auto", message: "outbox stalled: 1 stale item(s)", project_id: "demo"
      });
      upsertPiGuardianAlert(db, {
        alert_type: "approval_fast_path_error", id: "guardian-user", message: "approval stalled", project_id: "demo"
      });
      upsertPiGuardianAlert(db, {
        alert_type: "coordinator_stalled", id: "guardian-acked", message: "coordinator stalled", project_id: "demo", status: "acked"
      });
      upsertPiGuardianAlert(db, {
        alert_type: "guardian_inbox_stalled", id: "guardian-history", message: "inbox stalled", project_id: "demo", status: "resolved"
      });
      db.sqlite.run("update pi_guardian_alerts set created_at=?, updated_at=?, watchdog_seen_at=?", [SOURCE_TIME, SOURCE_TIME, SOURCE_TIME]);
      const router = createRouter();
      registerCommandCenterRoutes(router, { database: db }, { now: () => new Date(NOW) });

      const response = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=attention&limit=10`));
      const section = ((await response.json()) as Record<string, any>).sections.attention;

      expect(section).toMatchObject({
        counts: { pi_handling: 1, returned: 1, resolved_24h: 1, source_total: 2, total: 1 },
        freshness: { is_stale: false, state: "current" },
        operations: {
          summary: { active_pi_handling: 1, active_user_action_required: 1, alerts_recovered: 1 }
        }
      });
      expect(section.items).toMatchObject([{
        details: {
          component: "审批解析器",
          handling: "user_action_required",
          location: "项目 demo",
          requires_user: true,
          title: "审批处理需要人工确认"
        },
        links: { self: "/api/pi/guardian/alerts/guardian-user" }
      }]);
      expect(section.operations.active).toHaveLength(1);
      expect(section.recent_history).toMatchObject([expect.objectContaining({
        alert_id: "guardian-history", historical: true, state_label: "历史记录 · 已恢复"
      })]);
      expect(JSON.stringify(section.items)).not.toContain("guardian-auto");
      expect(JSON.stringify(section.items)).not.toContain("guardian-acked");
    } finally {
      db.close();
    }
  });

  test("moves stale recovery actions for terminal issues into history instead of user Attention", async () => {
    const db = await fixtureDatabase();
    try {
      const issue = createIssue(db, { project_id: "demo", status: "done", title: "already finished" });
      createPiAction(db, {
        action_type: "session.steer",
        gate_decision: "ask",
        gate_reason: "risk requires user confirmation",
        id: "stale-session-steer",
        issue_id: issue.id,
        project_id: "demo",
        rationale: "steer an old session",
        status: "pending"
      });
      createPiAction(db, {
        action_type: "issue.retry",
        gate_decision: "snooze",
        gate_reason: "recovery cooldown has not elapsed",
        id: "stale-retry",
        issue_id: issue.id,
        project_id: "demo",
        rationale: "retry after cooldown",
        status: "snoozed"
      });
      const router = createRouter();
      registerCommandCenterRoutes(router, { database: db }, { now: () => new Date(NOW) });

      const response = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=attention`));
      const section = ((await response.json()) as Record<string, any>).sections.attention;

      expect(section.counts).toMatchObject({ historical_hidden: 2, returned: 0, source_total: 0, total: 0 });
      expect(section.items).toEqual([]);
      expect(section.recent_history).toHaveLength(2);
      expect(section.recent_history).toEqual(expect.arrayContaining([
        expect.objectContaining({ historical: true, state_label: "历史记录 · 目标已结束", title: "旧操作请求已失效" })
      ]));
    } finally {
      db.close();
    }
  });

  test("uses one Command Center decision seam for internal Actions and source-linked Proposals", async () => {
    const db = await fixtureDatabase();
    try {
      createPiAction(db, {
        action_type: "issue.enqueue",
        gate_decision: "ask",
        gate_reason: "risk requires user confirmation",
        id: "internal-action-pending",
        idempotency_key: "internal-action-pending",
        payload_json: JSON.stringify({ issue_id: 738 }),
        project_id: "demo",
        rationale: "Enqueue issue 738",
        requires_confirmation: 1,
        risk_level: "medium",
        status: "pending"
      });
      const itemID = insertAttention(db);
      createActionProposal(db, {
        actions: [{ payload: { reason: "duplicate" }, requires_approval: false, risk: "low", type: "no_action" }],
        id: "proposal-command-center",
        skill_run_id: "missing-legacy-skill-run",
        source_item_ids: [`attention_inbox_item:${itemID}`],
        status: "proposed",
        summary: "Ignore duplicate request"
      });
      const router = createDefaultRouter({ database: db });

      const summary = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=attention&limit=10`));
      const items = ((await summary.json()) as Record<string, any>).sections.attention.items;
      const internal = items.find((item: Record<string, any>) => item.source_refs.some((ref: Record<string, any>) => ref.authority === "pi_actions"));
      const proposalAttention = items.find((item: Record<string, any>) => item.source_refs.some((ref: Record<string, any>) => ref.authority === "attention_inbox_items"));
      expect(internal).toMatchObject({ type: "approval_required", status: "waiting" });

      const detail = await router.handle(new Request(`${BASE_URL}/api/command-center/attention/${encodeURIComponent(internal.id)}`));
      expect(await detail.json()).toMatchObject({
        decisions: [{ kind: "pi_action", ref: "pi_action:internal-action-pending", status: "pending" }]
      });
      const rejectedAction = await router.handle(jsonRequest(
        `/api/command-center/attention/${encodeURIComponent(internal.id)}/actions/reject`,
        { actor: "user:command-center", decision_ref: "pi_action:internal-action-pending", reason: "not authorized" }
      ));
      expect(rejectedAction.status).toBe(200);
      expect(await rejectedAction.json()).toMatchObject({ attention: null, decision: { decision_ref: "pi_action:internal-action-pending" } });

      const proposalDetail = await router.handle(new Request(
        `${BASE_URL}/api/command-center/attention/${encodeURIComponent(proposalAttention.id)}`
      ));
      expect(await proposalDetail.json()).toMatchObject({
        decisions: [{ kind: "proposal", ref: "proposal:proposal-command-center", status: "proposed" }]
      });
      const rejectedProposal = await router.handle(jsonRequest(
        `/api/command-center/attention/${encodeURIComponent(proposalAttention.id)}/actions/reject`,
        { actor: "user:command-center", decision_ref: "proposal:proposal-command-center", reason: "duplicate" }
      ));
      expect(rejectedProposal.status).toBe(200);
      expect(db.sqlite.query("select status from attention_inbox_items where id=?").get(itemID)).toEqual({ status: "ignored" });
      expect(db.sqlite.query("select status from pi_action_proposals where id='proposal-command-center'").get()).toEqual({ status: "rejected" });
    } finally {
      db.close();
    }
  });

  test("keeps the active Work partition bounded on a large library", async () => {
    const db = await fixtureDatabase();
    try {
      const insert = db.sqlite.prepare(`
        insert into issues (project_id, title, description, status, priority, created_at, updated_at)
        values ('demo', ?, '', 'todo', ?, ?, ?)
      `);
      db.transaction(() => {
        for (let index = 0; index < 12_000; index += 1) {
          insert.run(`Large Work ${index}`, index, SOURCE_TIME, SOURCE_TIME);
        }
      }).immediate();
      const router = createDefaultRouter({ database: db });

      const startedAt = performance.now();
      const response = await router.handle(new Request(
        `${BASE_URL}/api/command-center/summary?sections=active_work&limit=10`
      ));
      const elapsedMs = performance.now() - startedAt;
      const body = await response.json() as Record<string, any>;

      expect(response.status).toBe(200);
      expect(body.sections.active_work).toMatchObject({
        counts: { returned: 10, total: 12_000 },
        status: "ok"
      });
      expect(body.sections.active_work.items).toHaveLength(10);
      expect(elapsedMs).toBeLessThan(2_000);
    } finally {
      db.close();
    }
  });

  test("rejects unbounded limits and unknown sections with actionable errors", async () => {
    const db = await fixtureDatabase();
    try {
      const router = createDefaultRouter({ database: db });
      const limit = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?limit=26`));
      const section = await router.handle(new Request(`${BASE_URL}/api/command-center/summary?sections=unknown`));
      expect(limit.status).toBe(400);
      expect(await limit.json()).toEqual({ code: "invalid_limit", message: "limit must be an integer from 1 to 25" });
      expect(section.status).toBe(400);
      expect(await section.json()).toEqual({ code: "invalid_section", message: "unknown Command Center section: unknown" });
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-command-center-"));
  tempRoots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(`
    insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/command-center-demo', 'codex', ?, ?)
  `, [SOURCE_TIME, SOURCE_TIME]);
  return db;
}

function insertRun(db: RunnerDatabase, issueID: number): string {
  db.sqlite.run(`
    insert into issue_runs (id, issue_id, attempt, status, provider, started_at)
    values (?, ?, 1, 'in_progress', 'codex', ?)
  `, [`command-center-run-${issueID}`, issueID, SOURCE_TIME]);
  return makeDomainID("run", "issue_runs", `command-center-run-${issueID}`);
}

function insertAttention(db: RunnerDatabase): number {
  const bundle = createContextBundle(db, {
    created_by: "system",
    event_refs: [1],
    reason: "command-center-test",
    source: "fixture",
    trigger: "manual",
    window: { from: SOURCE_TIME, to: SOURCE_TIME }
  }, new Date(SOURCE_TIME));
  const run = createIntakeRun(db, {
    bundle_id: bundle.id,
    skill_id: "fixture-intake",
    status: "succeeded"
  }, new Date(SOURCE_TIME));
  return createAttentionInboxItem(db, {
    bundle_id: bundle.id,
    confidence: 0.9,
    evidence_refs: ["external_event:1"],
    intake_run_id: run.id,
    primary_intent: "approval",
    source: "fixture",
    status: "new",
    suggested_actions: ["review"],
    summary: "Review the pending action",
    title: "Approval needed",
    urgency: "high"
  }, new Date(SOURCE_TIME)).id;
}

function attentionCommand(revision: number, action: "acknowledge" | "snooze"): Record<string, unknown> {
  return {
    audit: {
      actor: { id: "user:fixture", kind: "user" },
      correlation_id: "command-center:fixture",
      event_id: `attention-${action}-${revision}`,
      gate: { authority: "human_approval", decision: "allow", policy_ref: "command-center:test" },
      occurred_at: NOW,
      reason: `Fixture Attention ${action}`
    },
    expected_revision: revision,
    ...(action === "snooze" ? { snoozed_until: "2026-07-17T09:00:00.000Z" } : {})
  };
}

function jsonRequest(path: string, body: Record<string, unknown>): Request {
  return new Request(`${BASE_URL}${path}`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

function handoff(issueID: number): HandoffRecord {
  return {
    baseline_revision: "git:base",
    changed_files: ["backend-ts/src/http/commandCenterApi.ts"],
    created_at: SOURCE_TIME,
    delivery: { mode: "local_changes", working_tree_ref: "git:tree-command-center" },
    delivery_actions: [],
    evidence_ids: [],
    final_revision: "git:tree-command-center",
    id: makeDomainID("handoff", "derived", `command-center-${issueID}`),
    review: { required: false, reviewer_refs: [], state: "not_requested" },
    review_ref: "git:tree-command-center",
    revision: 0,
    risks: [],
    rollback: { availability: "not_required", destructive: false, refs: [] },
    run_ids: [],
    schema_version: 1,
    status: "draft",
    summary: "Command Center aggregate delivery",
    updated_at: SOURCE_TIME,
    work_id: issueIDToWorkID(issueID)
  };
}
