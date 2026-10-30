import { expect, test } from "bun:test";

import { openDatabase } from "../db/database.ts";

import { listAutomationRuns } from "../db/repositories/automations.ts";

import {
  trackDatabase,
  NOW,
  FixtureProvider,
  cycle,
  fixture,
  createFixture,
  insertProject,
  stateDirFor
} from "./automationRuntimeTestFixtures.ts";

export function registerAutomationRuntimeCommitmentsCases() {
  test("restores the standing-order cursor after restart and isolates project context", async () => {
    let db = await fixture();
    const provider = new FixtureProvider();
    const automation = createFixture(db, "restart", "execute_allowed");
    insertProject(db, "other", "/tmp/standing-order-other");
    const isolated = createFixture(db, "isolated", "execute_allowed", { commitment: false, projectID: "other" });
    const first = await cycle(db, provider, NOW);
    expect(first.automationCore).toMatchObject({ executed: 1, scanned: 2, skipped: 1 });
    expect(provider.inputs).toHaveLength(1);
    expect(provider.inputs[0]?.projectId).toBe("demo");
    expect(listAutomationRuns(db, isolated.id)[0]?.summary.detail).toContain("standing order no-op");

    const stateDir = stateDirFor(db);
    db.close();
    db = await openDatabase({ stateDir }).then(trackDatabase);
    const resumed = await cycle(db, provider, new Date("2026-07-18T10:01:00.000Z"));

    expect(resumed.automationCore).toMatchObject({ executed: 1, scanned: 2, skipped: 1 });
    expect(provider.inputs).toHaveLength(2);
    expect(listAutomationRuns(db, automation.id).map((run) => run.status).sort()).toEqual(["succeeded", "succeeded"]);
    expect(db.sqlite.query<{ count: number }, [string]>(`
        select count(*) as count from automation_execution_links where automation_id=?
      `).get(automation.id)?.count).toBe(2);
  });
}
