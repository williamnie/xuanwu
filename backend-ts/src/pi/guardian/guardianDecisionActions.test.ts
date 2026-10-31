import { describe, expect, test } from "bun:test";
import { type RunnerDatabase } from "../../db/database.ts";
import {
  createPiAction,
  createPiGuardianEvent,
  listPiActions,
  listPiGuardianDecisions,
  type PiGuardianDecision
} from "../../db/repositories/pi.ts";
import { runGuardianDecisionOrchestratorOnce } from "./guardianDecisionOrchestrator.ts";
import { useTestDatabase } from "../../testing/harness.ts";

import { openFixtureDatabase, heartbeatActionEvent, supervisorCandidateEvent, needsUserFixtureMessage, mergeMeta } from "./guardianDecisionActionsTestFixtures.ts";
import { registerCreatesOneGatedPIActionFor } from "./guardianDecisionActionsCreatesOneGatedPIActionFor.cases.ts";
import { registerLetsRecoveryGateDenyExhaustedBudget } from "./guardianDecisionActionsLetsRecoveryGateDenyExhaustedBudget.cases.ts";



describe("PI Guardian decision action outlet", () => {
  registerCreatesOneGatedPIActionFor();
  registerLetsRecoveryGateDenyExhaustedBudget();
});
