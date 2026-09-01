import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "./database.ts";
import { createPiAction, listRecentAttentionPiActions } from "./repositories/pi.ts";

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

    const attentionPlan = plan(db.sqlite, `
      select id, updated_at from pi_actions indexed by idx_pi_actions_attention_recent
      where status in ('candidate', 'pending', 'approved', 'changes_requested', 'snoozed')
        and updated_at>=?
      order by updated_at desc, id desc
      limit ?
    `, ["2026-08-25T00:00:00Z", 25]);
    expect(attentionPlan).toContain("idx_pi_actions_attention_recent");
    expect(attentionPlan).not.toContain("USE TEMP B-TREE");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Attention reads only the newest seven-day active Action window", async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-attention-actions-"));
  const db = await openDatabase({ stateDir: root });
  try {
    for (let index = 1; index <= 28; index += 1) {
      const id = `attention-${String(index).padStart(2, "0")}`;
      createPiAction(db, { action_type: "issue.retry", id, status: "pending" });
      db.sqlite.run("update pi_actions set updated_at=? where id=?", [
        `2026-09-${String(index).padStart(2, "0")}T00:00:00Z`,
        id
      ]);
    }
    createPiAction(db, { action_type: "issue.retry", id: "attention-completed", status: "completed" });
    db.sqlite.run("update pi_actions set updated_at=? where id='attention-completed'", ["2026-09-28T01:00:00Z"]);

    const actions = listRecentAttentionPiActions(db, {
      limit: 100,
      updatedAfter: "2026-09-21T00:00:00Z"
    });

    expect(actions).toHaveLength(8);
    expect(actions.map((action) => action.id)).toEqual([
      "attention-28", "attention-27", "attention-26", "attention-25",
      "attention-24", "attention-23", "attention-22", "attention-21"
    ]);
    expect(actions.every((action) => action.status === "pending")).toBe(true);

    const bounded = listRecentAttentionPiActions(db, {
      limit: 100,
      updatedAfter: "2026-09-01T00:00:00Z"
    });
    expect(bounded).toHaveLength(25);
    expect(bounded[0]?.id).toBe("attention-28");
    expect(bounded.at(-1)?.id).toBe("attention-04");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

function plan(
  sqlite: Database,
  sql: string,
  args: Array<string | number>
): string {
  return sqlite.query<{ detail: string }, Array<string | number>>(`explain query plan ${sql}`)
    .all(...args).map((row) => row.detail).join("\n");
}
