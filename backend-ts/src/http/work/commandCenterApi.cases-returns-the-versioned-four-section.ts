import { expect, test } from "bun:test";
import { recordHandoff } from "../../db/repositories/handoffs.ts";
import { createPiApprovalRequest, upsertPiGuardianAlert } from "../../db/repositories/pi.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { projectPendingCompactEventSummaries, updateEventSummaryProjectionSwitch } from "../../db/repositories/compactEventSummaryProjection.ts";
import { issueIDToWorkID } from "../../domain/work/issueAdapter.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { commandCenterSectionReaders, registerCommandCenterRoutes } from "./commandCenterApi.ts";
import { createRouter } from "../router.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./commandCenterApi.testFixture.ts";

export function registerReturnsTheVersionedFourSectionCases(testScope: TestFixture) {
  const { BASE_URL, NOW, SOURCE_TIME, fixtureDatabase, insertRun, insertAttention, attentionCommand, jsonRequest, handoff } = testScope;
  test("returns the versioned four-section summary with bounded items, counts, freshness, and links", async () => {
      const db = await fixtureDatabase();
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
    });
  
  test("isolates a failed section and still returns successful requested partitions", async () => {
      const db = await fixtureDatabase();
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
    });
  
  test("projects multiple legacy Attention types and persists audited acknowledge/snooze commands", async () => {
      const db = await fixtureDatabase();
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
    });
}
