import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const DELETED_SEMANTIC_PLANNERS = [
  "backend-ts/src/pi/supervisorIntentRouter.ts",
  "backend-ts/src/pi/supervisorWorkPlanner.ts",
  "backend-ts/src/pi/recoveryActionPlanner.ts",
  "backend-ts/src/pi/heartbeatPlanner.ts",
  "backend-ts/src/pi/heartbeatVerificationPlanner.ts",
  "backend-ts/src/pi/failurePatternCandidates.ts",
  "backend-ts/src/pi/projectFindingActions.ts",
  "backend-ts/src/integrations/feishuIssueCommand.ts",
  "backend-ts/src/integrations/feishuReviewCommand.ts",
  "backend-ts/src/integrations/feishuMemoryCommands.ts",
  "backend-ts/src/integrations/feishuProjectSwitch.ts",
  "backend-ts/src/integrations/feishuCompletionWatchCommand.ts",
  "backend-ts/src/integrations/feishuNotificationPreferenceBridge.ts"
];

describe("PI-first decision boundary", () => {
  test("does not restore pre-LLM semantic routers or hardcoded action planners", () => {
    for (const path of DELETED_SEMANTIC_PLANNERS) {
      expect(existsSync(resolve(REPO_ROOT, path))).toBe(false);
    }

    const production = [
      "backend-ts/src/http/piConversationApi.ts",
      "backend-ts/src/http/piRuntime.ts",
      "backend-ts/src/integrations/feishuAgentBridge.ts",
      "backend-ts/src/pi/attentionRouter.ts",
      "backend-ts/src/pi/guardianDecisionActionCandidates.ts",
      "backend-ts/src/pi/heartbeatOrchestrator.ts",
      "backend-ts/src/runner/piIssueSupervisorScheduler.ts"
    ].map(source).join("\n");
    for (const forbidden of [
      "supervisorIntentRouter",
      "supervisorWorkPlanner",
      "manualIntakeModel",
      "hardcoded-pi-runtime",
      "intent_route_denied",
      "REQUEST_KEYWORDS",
      "NON_TASK_QUESTIONS",
      "planHeartbeatActions",
      "gitDeliveryInstruction",
      "forbidsCommit",
      "requiresCommit"
    ]) {
      expect(production).not.toContain(forbidden);
    }
  });

  test("keeps semantic channel messages on the PI path and fails visibly when PI is unavailable", () => {
    const bridge = source("backend-ts/src/integrations/feishuAgentBridge.ts");
    expect(bridge).not.toContain("feishuIssueCommand");
    expect(bridge).not.toContain("feishuReviewCommand");
    expect(bridge).not.toContain("feishuMemoryCommands");
    expect(bridge).not.toContain("feishuProjectSwitch");
    expect(bridge).toContain("Xuanwu Supervisor conversation provider is unavailable");
    expect(bridge).toContain('eventType: "guardian.pi_supervisor.unavailable"');

    const scheduler = source("backend-ts/src/runner/piIssueSupervisorScheduler.ts");
    expect(scheduler).toContain("runPiSupervisorDecision");
    expect(scheduler).toContain('eventType: "guardian.pi_supervisor.unavailable"');
  });

  test("documents the LLM decision and deterministic exact-action gate boundary", () => {
    const adr = source("docs/architecture/xuanwu/0085-pi-first-decision-boundary.md");
    expect(adr).toContain("user message + stable conversation history + bounded entity context");
    expect(adr).toContain("PI Agent/LLM");
    expect(adr).toContain("exact tool call");
    expect(adr).toContain("Action Gate");
    expect(adr).toContain("alert-only");
    expect(adr).toContain("dirty working tree");
  });
});

function source(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), "utf8");
}
