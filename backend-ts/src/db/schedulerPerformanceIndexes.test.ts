import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";

test("scheduler sweeps use bounded PI action and notification indexes", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-scheduler-indexes-"));
  const db = await openDatabase({ stateDir: root });
  try {
    expect(plan(db.sqlite, `
      select id from pi_actions indexed by idx_pi_actions_pending_mcp_expiry
      where action_type='mcp.tool.call' and status='pending'
        and lease_expires_at<>'' and lease_expires_at<=?
      order by lease_expires_at asc, id asc
    `, ["2026-08-12T00:00:00Z"])).toContain("idx_pi_actions_pending_mcp_expiry");

    expect(plan(db.sqlite, `
      select id, project_id, issue_id, conversation_id, action_type, status,
        payload_json, created_at
      from pi_actions indexed by idx_pi_actions_pending_notification
      where status='pending'
        and action_type in ('assistant.tool.call', 'mcp.tool.call')
        and created_at>=?
      order by created_at asc, id asc
    `, ["2026-08-12T00:00:00Z"])).toContain("idx_pi_actions_pending_notification");

    expect(plan(db.sqlite, `
      select source_event_id, state from pi_notification_intents indexed by idx_pi_notification_intents_kind_source
      where kind=? order by source_event_id asc, created_at asc, id asc
    `, ["pi_action_pending"])).toContain("idx_pi_notification_intents_kind_source");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

function plan(
  sqlite: Database,
  sql: string,
  args: string[]
): string {
  return sqlite.query<{ detail: string }, string[]>(`explain query plan ${sql}`)
    .all(...args).map((row) => row.detail).join("\n");
}
