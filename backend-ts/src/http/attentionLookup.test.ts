import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../db/database.ts";
import { createPiAction, getPiAction } from "../db/repositories/pi.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createAttentionInboxItem, createIntakeRun } from "../db/repositories/intakeRuns.ts";
import { registerCommandCenterRoutes } from "./commandCenterApi.ts";
import { createRouter } from "./router.ts";
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-attention-lookup-")); roots.push(root);
  const db = await openDatabase({ stateDir: root });
  const router = createRouter(); registerCommandCenterRoutes(router, { database: db });
  const request = (path: string, body?: object) => router.handle(new Request(`http://fixture/api/command-center/${path}`, body ? {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  } : undefined));
  const action = (id: string, overrides = {}) => {
    createPiAction(db, { id, action_type: "no_action", rationale: "Fixture approval", status: "pending", gate_decision: "ask", payload_json: JSON.stringify({ reason: "Fixture no-op" }), ...overrides });
    db.sqlite.run("update pi_actions set updated_at=? where id=?", [new Date(Date.now() - 8 * 86400000).toISOString(), id]);
    return `attention/${encodeURIComponent(`xw:attention:pi_actions:${id}`)}`;
  };
  return { db, request, action };
}
test("window-excluded pending details resolve and approval still executes through the existing Gate and audit", async () => {
  const { db, request, action } = await fixture();
  try {
    const path = action("old-pending");
    for (let i = 0; i < 30; i++) createPiAction(db, { id: `new-${i}`, action_type: "no_action", rationale: "Recent", status: "pending" });
    const before = await (await request("summary?sections=attention&limit=25")).json();
    expect(before.sections.attention.items).toHaveLength(25);
    expect(JSON.stringify(before)).not.toContain("old-pending");
    const excluded = Array.from({ length: 30 }, (_, i) => `new-${i}`).find(id =>
      !before.sections.attention.items.some((item: { id: string }) => item.id === `xw:attention:pi_actions:${id}`));
    expect(excluded).toBeDefined();
    expect((await request(`attention/${encodeURIComponent(`xw:attention:pi_actions:${excluded}`)}`)).status).toBe(200);
    const details = await request(path);
    expect(details.status).toBe(200);
    expect(await details.json()).toMatchObject({ decisions: [{ ref: "pi_action:old-pending", gate: { can_approve: true } }] });
    const approved = await request(`${path}/actions/approve`, { actor: "fixture:user", decision_ref: "pi_action:old-pending" });
    expect(approved.status).toBe(200);
    expect(getPiAction(db, "old-pending")).toMatchObject({ status: "completed", approved_by: "fixture:user" });
    const events = db.sqlite.query<{ event_type: string }, []>("select event_type from pi_action_events where action_id='old-pending'").all().map(row => row.event_type);
    expect(events).toEqual(expect.arrayContaining(["approval_decision", "execution_started", "execution_result"]));
    expect((await request(path)).status).toBe(404);
  } finally { db.close(); }
});
test("window removal does not bypass deny or expiry gates or admit terminal actions", async () => {
  const { db, request, action } = await fixture();
  try {
    const denied = action("denied", { gate_decision: "deny" });
    expect((await request(`${denied}/actions/approve`, { decision_ref: "pi_action:denied" })).status).toBe(409);
    expect(getPiAction(db, "denied")?.status).toBe("pending");
    const expired = action("expired", { lease_expires_at: new Date(Date.now() - 1000).toISOString() });
    const response = await request(`${expired}/actions/approve`, { decision_ref: "pi_action:expired" });
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain("expired");
    for (const status of ["completed", "rejected", "failed", "executing"]) {
      const path = action(`terminal-${status}`, { status });
      expect((await request(path)).status).toBe(404);
      expect((await request(`${path}/actions/approve`, { decision_ref: `pi_action:terminal-${status}` })).status).toBe(404);
    }
  } finally { db.close(); }
});
test("window-excluded acknowledgement keeps revision and append-only command audit", async () => {
  const { db, request, action } = await fixture();
  try {
    const path = action("old-ack");
    const command = { expected_revision: 0, audit: {
      actor: { kind: "user", id: "fixture:user" }, correlation_id: "fixture", event_id: "fixture-ack",
      gate: { authority: "human_approval", decision: "allow", policy_ref: "fixture" },
      occurred_at: new Date().toISOString(), reason: "Fixture acknowledgement"
    } };
    expect((await request(`${path}/actions/acknowledge`, command)).status).toBe(200);
    expect(await (await request(path)).json()).toMatchObject({ attention: { revision: 1, status: "acknowledged" } });
    expect((await request(`${path}/actions/acknowledge`, command)).status).toBe(409);
    expect(db.sqlite.query("select count(*) as count from attention_command_events").get()).toEqual({ count: 1 });
    expect(getPiAction(db, "old-ack")?.status).toBe("pending");
  } finally { db.close(); }
});
test("inbox detail removes the collection cap while preserving terminal carrier behavior", async () => {
  const { db, request } = await fixture();
  try {
    const date = new Date();
    const bundle = createContextBundle(db, { created_by: "system", event_refs: [1], reason: "fixture", source: "fixture", trigger: "manual", window: { from: date.toISOString(), to: date.toISOString() } });
    const run = createIntakeRun(db, { bundle_id: bundle.id, skill_id: "fixture", status: "succeeded" });
    for (let i = 0; i < 102; i++) createAttentionInboxItem(db, {
      bundle_id: bundle.id, intake_run_id: run.id, evidence_refs: ["external_event:1"], primary_intent: "input", source: "fixture", title: "Fixture", summary: "Fixture input", status: i === 101 ? "ignored" : "new"
    }, date);
    expect((await request("attention/xw%3Aattention%3Aattention_inbox_items%3A1")).status).toBe(200);
    const terminal = await request("attention/xw%3Aattention%3Aattention_inbox_items%3A102");
    expect(terminal.status).toBe(200);
    expect(await terminal.json()).toMatchObject({ attention: { status: "dismissed" } });
    const summary = await (await request("summary?sections=attention&limit=25")).json();
    expect(summary.sections.attention.counts.total).toBe(99);
  } finally { db.close(); }
});
