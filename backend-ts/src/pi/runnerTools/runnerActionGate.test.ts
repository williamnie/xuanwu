import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getPiAction, getPiIssueCompletionWatch, listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createHumanReviewRequest } from "../../domain/review/humanReview.ts";
import { createPiRunnerActions } from "./runnerActions.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, openFixture, insertIssue, insertAgentSession } from "./runnerActionGateTestFixtures.ts";
import { registerDelegatedModeOnlyAutoExecutesActions } from "./runnerActionGateDelegatedModeOnlyAutoExecutesActions.cases.ts";
import { registerAllIMRunnerChatSourcesAuthorize } from "./runnerActionGateAllIMRunnerChatSourcesAuthorize.cases.ts";
import { registerDelegatedPICanMoveExplicitIssues } from "./runnerActionGateDelegatedPICanMoveExplicitIssues.cases.ts";
import { registerDelegatedAuthorizationDoesNotAutoExecute } from "./runnerActionGateDelegatedAuthorizationDoesNotAutoExecute.cases.ts";



describe("PI runner action gate", () => {
  registerDelegatedModeOnlyAutoExecutesActions();
  registerAllIMRunnerChatSourcesAuthorize();
  registerDelegatedPICanMoveExplicitIssues();
  registerDelegatedAuthorizationDoesNotAutoExecute();
});
