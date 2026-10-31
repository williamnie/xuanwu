import { expect, test } from "bun:test";

import { getIssue } from "../db/repositories/issues.ts";
import { runProjectLoopOnce } from "./projectLoop.ts";
import { cancelIssueWithInterrupt } from "./interrupt.ts";

import {
  openFixtureDatabase,
  ImmediatelyInterruptedProvider,
  insertProject,
  insertIssue,
  latestRun,
  waitFor
} from "./interruptTestFixtures.ts";

export function registerInterruptRestartCases() {
  test("an immediate Pi interrupt cannot race the cancelled Run back to failed", async () => {
    const db = await openFixtureDatabase();
    const provider = new ImmediatelyInterruptedProvider();
    insertProject(db, "demo");
    db.sqlite.run("update projects set provider='pi-coding-agent' where id='demo'");
    const issueId = insertIssue(db, "demo", "todo", "", "");
    const running = runProjectLoopOnce({
      database: db,
      projectId: "demo",
      providers: { "pi-coding-agent": provider }
    });
    await waitFor(() => latestRun(db, issueId)?.provider_session_id === "pi-running");

    const cancelled = await cancelIssueWithInterrupt(db, issueId, {
      providers: { "pi-coding-agent": provider }
    });
    await running;

    expect(cancelled.status).toBe("cancelled");
    expect(getIssue(db, issueId)).toMatchObject({ status: "cancelled" });
    expect(latestRun(db, issueId)).toMatchObject({
      status: "cancelled",
      exit_reason: "issue_cancel",
      error: ""
    });
  });
}
