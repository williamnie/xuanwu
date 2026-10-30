import { expect, test } from "bun:test";

import { createIssueRun } from "../../db/repositories/issueRuns.ts";

import { RUN_LIFECYCLE_EVENT_TYPES } from "./lifecycleStore.ts";
import { pendingRunCreation, recordRunMaterialized, requestNewRun } from "./service.ts";

import { openFixture, activeRun, newRunCommand, terminalRun, eventCount, runState } from "./serviceTestFixtures.ts";

export function registerServiceRecoveryCases() {
  test("deduplicates retry requests and materializes their new Run once", async () => {
    const fixture = await openFixture("retry-materialize");
    const run = activeRun(fixture.db, "thread-failed", "turn-failed");
    terminalRun(fixture.db, run.issue_run_id, "failed");
    const retry = newRunCommand(fixture.db, run, "retry", "retry-1");

    expect(requestNewRun(fixture.db, retry)).toMatchObject({ applied: true, replayed: false, requested_sequence: 2 });
    expect(requestNewRun(fixture.db, retry)).toMatchObject({ applied: true, replayed: true, requested_sequence: 2 });
    const pending = pendingRunCreation(fixture.db, run.issue_id, 2);
    expect(pending).toMatchObject({ event_id: "retry-1", operation: "retry", supersedes_run_id: run.run_id });

    const next = createIssueRun(fixture.db, run.issue_id);
    if (!pending) throw new Error("pending Run request missing");
    recordRunMaterialized(fixture.db, pending, next.id);
    recordRunMaterialized(fixture.db, pending, next.id);
    expect(pendingRunCreation(fixture.db, run.issue_id, 2)).toBeNull();
    expect(eventCount(fixture.db, "retry-1", RUN_LIFECYCLE_EVENT_TYPES.runRequested)).toBe(1);
    expect(eventCount(fixture.db, "retry-1", RUN_LIFECYCLE_EVENT_TYPES.runMaterialized)).toBe(1);
    expect(runState(fixture.db, next.id)).toMatchObject({ attempt: 2, status: "in_progress" });
  });
}
