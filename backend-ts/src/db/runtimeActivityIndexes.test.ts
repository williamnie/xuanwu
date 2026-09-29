import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";

test("issue actions and conversation observations avoid full history scans", () => {
  const sqlite = new Database(":memory:");
  try {
    runMigrations(sqlite);
    for (const [sql, args] of [
      ["select id from pi_actions where issue_id=? order by created_at desc, id desc limit 1", [967]],
      ["select id from pi_actions where conversation_id=? order by created_at desc, id desc limit 500", ["conversation"]],
      ["select count(*) from pi_action_events where conversation_id=? and event_type='im_context_policy_observed'", ["conversation"]],
      ["select id from pi_action_events where issue_id=? order by id desc limit 500", [967]]
    ] as const) {
      const plan = sqlite.query(`explain query plan ${sql}`).all(...args) as Array<{ detail: string }>;
      expect(plan.some(({ detail }) => detail.startsWith("SEARCH "))).toBe(true);
      expect(plan.some(({ detail }) => /SCAN pi_|USE TEMP B-TREE/.test(detail))).toBe(false);
    }
    runMigrations(sqlite);
    expect(sqlite.query("pragma quick_check").get()).toEqual({ quick_check: "ok" });
  } finally { sqlite.close(); }
});
