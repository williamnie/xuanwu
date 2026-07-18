import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunnerDatabase } from "./database.ts";
import { createActionProposal, createPiAction } from "./repositories/pi.ts";
import { runMigrations } from "./migrations.ts";
import { migrations } from "./schema/index.ts";

const roots: string[] = [];
const MIGRATION_ID = "052_consolidate_pi_decision_layers";

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("PI decision layer consolidation migration", () => {
  test("backfills stable Proposal to Action links and append-only migration events idempotently", async () => {
    const root = await mkdtemp(join(tmpdir(), "runner-consolidate-pi-decisions-"));
    roots.push(root);
    const db = new Database(join(root, "runner.db"), { strict: true });
    try {
      const index = migrations.findIndex((migration) => migration.id === MIGRATION_ID);
      runMigrations(db, migrations.slice(0, index));
      const runnerDB = { sqlite: db } as RunnerDatabase;
      createPiAction(runnerDB, action("skill-run-1", "skill-runtime:1", "completed"));
      createPiAction(runnerDB, action("child-action-1", "action-proposal:proposal-1:action-1", "completed"));
      createActionProposal(runnerDB, {
        actions: [{
          id: "action-1",
          payload: { query: "#738" },
          requires_approval: false,
          risk: "low",
          type: "issue.status_lookup"
        }],
        id: "proposal-1",
        skill_run_id: "skill-run-1",
        source_item_ids: ["attention_inbox_item:42"],
        status: "approved",
        summary: "Inspect issue 738"
      });

      runMigrations(db, migrations);
      migrations[index]!.apply!(db);

      const proposal = db.query<{ actions_json: string }, []>(
        "select actions_json from pi_action_proposals where id='proposal-1'"
      ).get();
      expect(JSON.parse(proposal?.actions_json ?? "[]")[0]).toMatchObject({
        execution_status: "completed",
        pi_action_id: "child-action-1",
        result: { ok: true }
      });
      const events = db.query<{ action_id: string; event_type: string; payload_json: string }, []>(
        `select action_id, event_type, payload_json from pi_action_events
         where event_type like 'action_proposal.%' order by action_id, event_type`
      ).all();
      expect(events).toHaveLength(2);
      expect(events.map((event) => [event.action_id, event.event_type])).toEqual([
        ["child-action-1", "action_proposal.action_mapped"],
        ["skill-run-1", "action_proposal.migrated"]
      ]);
      expect(events.every((event) => JSON.parse(event.payload_json).proposal_id === "proposal-1")).toBe(true);
      expect(db.query("select id from schema_migrations where id=?").get(MIGRATION_ID)).toEqual({ id: MIGRATION_ID });
    } finally {
      db.close();
    }
  });
});

function action(id: string, idempotencyKey: string, status: string) {
  return {
    action_type: "issue.status_lookup",
    gate_decision: "execute",
    id,
    idempotency_key: idempotencyKey,
    payload_json: JSON.stringify({ query: "#738" }),
    result_json: JSON.stringify({ ok: true }),
    source: "action_proposal",
    status
  };
}
