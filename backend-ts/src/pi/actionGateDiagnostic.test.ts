import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createPiAction } from "../db/repositories/pi.ts";
import { piActionGateDiagnostic } from "./actionGateDiagnostic.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop() ?? "", { recursive: true, force: true });
});

describe("PI Action Gate diagnostic projection", () => {
  test("projects a current exact-target approval with stable layer, code and scope", async () => {
    const db = await fixture();
    try {
      const action = createPiAction(db, {
        action_type: "issue.enqueue",
        gate_decision: "ask",
        gate_reason: "risk requires user confirmation",
        id: "diagnostic-current",
        issue_id: 42,
        payload_json: JSON.stringify({ issue_id: 42 }),
        project_id: "demo",
        risk_level: "medium",
        source: "feishu_runner_chat",
        status: "pending"
      });

      expect(piActionGateDiagnostic(db, action, new Date("2026-01-01T01:00:00Z"))).toMatchObject({
        authorization_source: "current_runner_chat_turn",
        blocked_layer: "action_gate",
        can_approve: true,
        freshness: "current",
        reason_code: "risk_confirmation_required",
        scope: { issue_ids: [42], project_id: "demo" }
      });
    } finally {
      db.close();
    }
  });

  test("disables approval for stale and expired targets", async () => {
    const db = await fixture();
    try {
      const stale = createPiAction(db, {
        action_type: "issue.enqueue",
        expected_state_json: JSON.stringify({
          issue_id: 42,
          project_id: "demo",
          status: "triage",
          updated_at: "2026-01-01T00:00:00Z"
        }),
        gate_decision: "ask",
        id: "diagnostic-stale",
        issue_id: 42,
        payload_json: JSON.stringify({ issue_id: 42 }),
        project_id: "demo",
        status: "pending"
      });
      const expired = createPiAction(db, {
        action_type: "mcp.tool.call",
        gate_decision: "ask",
        id: "diagnostic-expired",
        lease_expires_at: "2026-01-01T00:30:00Z",
        payload_json: JSON.stringify({ capability_id: "docs:tool:write" }),
        project_id: "demo",
        status: "pending"
      });
      db.sqlite.run("update issues set status='done', updated_at=? where id=42", ["2026-01-01T02:00:00Z"]);

      expect(piActionGateDiagnostic(db, stale, new Date("2026-01-01T01:00:00Z"))).toMatchObject({
        can_approve: false,
        freshness: "stale",
        reason_code: "stale_target_state"
      });
      expect(piActionGateDiagnostic(db, expired, new Date("2026-01-01T01:00:00Z"))).toMatchObject({
        blocked_layer: "mcp_policy",
        can_approve: false,
        freshness: "expired",
        reason_code: "approval_expired"
      });
    } finally {
      db.close();
    }
  });
});

async function fixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-action-gate-diagnostic-"));
  roots.push(root);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run("insert into projects (id,name,cwd,created_at,updated_at) values ('demo','Demo','/tmp/demo',?,?)", [
    "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
  ]);
  db.sqlite.run(`insert into issues
    (id,project_id,title,status,created_at,updated_at)
    values (42,'demo','Issue 42','triage',?,?)`, ["2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
  return db;
}
