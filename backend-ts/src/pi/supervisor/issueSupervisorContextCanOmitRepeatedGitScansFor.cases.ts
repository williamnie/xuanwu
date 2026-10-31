import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssueSupervisorEvent, upsertProjectPiPolicy } from "../../db/repositories/pi.ts";
import { recordPiRecoveryAttempt } from "../../db/repositories/pi/recoveryAttempts.ts";
import { buildIssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { latestProviderError } from "./issueSupervisorContextSupport.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, NOW, tempRoots, fixtureDb, tempRoot, insertProject, insertIssue, insertRun, insertSession, insertEvent } from "./issueSupervisorContextTestFixtures.ts";

export function registerCanOmitRepeatedGitScansFor() {
test("can omit repeated Git scans for the scheduler while retaining progress markers", async () => {
    const db = await fixtureDb();
    insertProject(db, "runner", "/path/that/must/not/be-scanned");
    insertIssue(db, {
      id: 418,
      projectID: "runner",
      title: "Scheduler scan",
      status: "in_progress",
      updatedAt: "2026-06-10T07:59:00Z"
    });
    insertEvent(db, {
      issueID: 418,
      type: "issue.log",
      payload: { command: "bun test focused.test.ts", type: "tool" },
      createdAt: "2026-06-10T07:59:30Z"
    });

    const context = buildIssueSupervisorRecoveryContext(db, 418, {
      includeWorkspaceGit: false,
      now: NOW
    });

    expect(context.workspace_snapshot).toMatchObject({
      git_diff_hash: "",
      git_status_summary: "omitted_for_scheduler_scan",
      last_commands: ["bun test focused.test.ts"]
    });
  });
}
