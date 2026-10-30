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
import { registerScheduledWaitsDoNotInventRate } from "./issueSupervisorContextScheduledWaitsDoNotInventRate.cases.ts";
import { registerMarksExhaustedCandidateAfterTwoRecoveries } from "./issueSupervisorContextMarksExhaustedCandidateAfterTwoRecoveries.cases.ts";
import { registerKeepsTheFirstThreadStartTimeout } from "./issueSupervisorContextKeepsTheFirstThreadStartTimeout.cases.ts";
import { registerCanOmitRepeatedGitScansFor } from "./issueSupervisorContextCanOmitRepeatedGitScansFor.cases.ts";

afterEach(async () => {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
});

describe("PI issue supervisor context builder", () => {
  registerScheduledWaitsDoNotInventRate();
  registerMarksExhaustedCandidateAfterTwoRecoveries();
  registerKeepsTheFirstThreadStartTimeout();
  registerCanOmitRepeatedGitScansFor();
});
