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

export function registerLetsRecoveryGateDenyExhaustedBudget() {
test("lets recovery gate deny exhausted budget and snooze cooldown candidates", async () => {
    const db = await openFixtureDatabase();
    supervisorCandidateEvent(db, "supervisor-budget-exhausted", {
      allowed_actions: ["session.resume_followup"],
      budget_remaining: 0,
      diagnosis_code: "provider_timeout",
      provider: "codex",
      provider_session_id: "thread-603",
      provider_turn_id: "turn-old",
      reason: "provider timed out",
    }, 603, "session.resume_followup");
    supervisorCandidateEvent(db, "supervisor-cooldown", {
      allowed_actions: ["session.resume_followup"],
      budget_remaining: 1,
      cooldown_until: "2026-06-18T00:05:00Z",
      diagnosis_code: "provider_timeout",
      provider: "codex",
      provider_session_id: "thread-604",
      provider_turn_id: "turn-old",
      reason: "provider timed out",
    }, 604, "session.resume_followup");

    runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:02:00Z") });
    runGuardianDecisionOrchestratorOnce(db, { now: new Date("2026-06-18T00:02:31Z") });

    expect(listPiActions(db, { issueId: 603 })[0]).toMatchObject({
      action_type: "session.resume_followup",
      gate_decision: "deny",
      gate_reason: expect.stringContaining("budget"),
      status: "denied"
    });
    expect(listPiActions(db, { issueId: 604 })[0]).toMatchObject({
      action_type: "session.resume_followup",
      gate_decision: "snooze",
      gate_reason: expect.stringContaining("cooldown"),
      status: "snoozed"
    });
  });
}
