import { expect, test } from "bun:test";
import { createActionProposal, createPiAction, upsertPiGuardianAlert } from "../../db/repositories/pi.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { registerCommandCenterRoutes } from "./commandCenterApi.ts";
import { createRouter } from "../router.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./commandCenterApi.testFixture.ts";

export function registerShowsOnlyUserOwnedIncidentsCases(testScope: TestFixture) {
  const { BASE_URL, NOW, SOURCE_TIME, fixtureDatabase, insertAttention, jsonRequest } = testScope;
  test("shows only user-owned incidents while PI-handled and recovered alerts become an operations summary", async () => {
      const db = await fixtureDatabase();
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
    });
  
  test("moves stale recovery actions for terminal issues into history instead of user Attention", async () => {
      const db = await fixtureDatabase();
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
    });
  
  test("bounds PI Action Attention to active records updated within seven days", async () => {
      const db = await fixtureDatabase();
      createPiAction(db, {
        action_type: "issue.retry",
        gate_decision: "ask",
        id: "recent-active-action",
        rationale: "recent approval",
        status: "pending"
      });
      createPiAction(db, {
        action_type: "issue.retry",
        gate_decision: "ask",
        id: "old-active-action",
        rationale: "expired approval",
        status: "pending"
      });
      createPiAction(db, {
        action_type: "issue.retry",
        gate_decision: "ask",
        id: "recent-completed-action",
        rationale: "completed approval",
        status: "completed"
      });
      db.sqlite.run("update pi_actions set updated_at=? where id=?", [SOURCE_TIME, "recent-active-action"]);
      db.sqlite.run("update pi_actions set updated_at=? where id=?", ["2026-07-09T08:00:00.000Z", "old-active-action"]);
      db.sqlite.run("update pi_actions set updated_at=? where id=?", [SOURCE_TIME, "recent-completed-action"]);
      const router = createRouter();
      registerCommandCenterRoutes(router, { database: db }, { now: () => new Date(NOW) });
  
      const response = await router.handle(new Request(
        `${BASE_URL}/api/command-center/summary?sections=attention&limit=10`
      ));
      const section = ((await response.json()) as Record<string, any>).sections.attention;
      const serialized = JSON.stringify(section.items);
  
      expect(response.status).toBe(200);
      expect(serialized).toContain("recent-active-action");
      expect(serialized).not.toContain("old-active-action");
      expect(serialized).not.toContain("recent-completed-action");
    });
  
  test("uses one Command Center decision seam for internal Actions and source-linked Proposals", async () => {
      const db = await fixtureDatabase();
      db.sqlite.run(`insert into issues
        (id,project_id,title,status,created_at,updated_at)
        values (738,'demo','Issue 738','triage',?,?)`, [SOURCE_TIME, SOURCE_TIME]);
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
        decisions: [{
          gate: {
            authorization_source: "deterministic_policy",
            blocked_layer: "action_gate",
            can_approve: true,
            decision: "ask",
            freshness: "current",
            reason_code: "risk_confirmation_required",
            scope: { issue_ids: [738], project_id: "demo" }
          },
          kind: "pi_action",
          ref: "pi_action:internal-action-pending",
          status: "pending"
        }]
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
    });
}
