import { describe, expect, test } from "bun:test";
import { hasPiActionDispatcher } from "../http/piActionDispatch.ts";
import { classifyPiActionRisk, decidePiAuthorization, type PiActionEnvelope } from "./actionGate.ts";
import { PI_ACTION_CONTRACTS, piActionContract } from "./actionContracts.ts";
import { hasPiActionFreshnessEvaluator } from "./actionFreshness.ts";
import { isRunnerChatSource, scopedRunnerChatActionContext } from "./runnerChatAuthorization.ts";

const CHANNELS = ["runner_chat", "feishu_runner_chat", "telegram_runner_chat", "matrix_runner_chat"];

describe("canonical PI Action contracts", () => {
  test("keeps risk, resolution and freshness mechanically complete", () => {
    const types = PI_ACTION_CONTRACTS.map((item) => item.action_type);
    expect(new Set(types).size).toBe(types.length);
    for (const contract of PI_ACTION_CONTRACTS) {
      expect(classifyPiActionRisk(contract.action_type).gate).toBe(contract.risk);
      expect(piActionContract(contract.action_type)).toEqual(contract);
      if (contract.resolution === "dispatch") expect(hasPiActionDispatcher(contract.action_type)).toBe(true);
      if (contract.freshness === "required") expect(hasPiActionFreshnessEvaluator(contract.action_type)).toBe(true);
    }
  });

  test("binds every Runner Chat mutation to the exact target on every IM channel", () => {
    for (const source of CHANNELS) {
      expect(isRunnerChatSource(source)).toBe(true);
      for (const contract of PI_ACTION_CONTRACTS.filter((item) => item.runner_chat_authorization === "exact_target")) {
        const target = contract.target === "issue_batch"
          ? { issueIDs: [7, 8], projectID: "demo" }
          : contract.target === "project"
            ? { projectID: "demo" }
            : { issueID: 7, projectID: "demo" };
        const context = scopedRunnerChatActionContext({
          authorization: {
            allowedActions: [contract.action_type],
            askOnMissingAuthorization: true,
            authorizedActions: [],
            mode: "delegated",
            scopes: [{ runner_resource: "issues" }]
          },
          source
        }, contract.action_type, target);
        const decision = decidePiAuthorization(envelope(contract.action_type), context.authorization);
        expect(decision.decision).toBe(contract.risk === "high" ? "ask" : "execute");
      }
    }
  });

  test("fails closed for inline-only mutations without current-turn authorization", () => {
    for (const contract of PI_ACTION_CONTRACTS.filter((item) => item.resolution === "inline_current_turn")) {
      expect(decidePiAuthorization(envelope(contract.action_type), {
        allowedActions: [contract.action_type],
        askOnMissingAuthorization: true,
        authorizedActions: [],
        mode: "delegated",
        scope: { project_id: "demo" }
      })).toMatchObject({
        decision: "deny",
        reason: "action requires exact current-turn authorization"
      });
    }
  });
});

function envelope(actionType: string): PiActionEnvelope {
  const classification = classifyPiActionRisk(actionType);
  return {
    action_type: actionType,
    issue_id: 7,
    payload: { issue_id: 7, issue_ids: [7, 8] },
    project_id: "demo",
    requires_confirmation: classification.requiresConfirmation,
    risk_level: classification.riskLevel,
    source: "feishu_runner_chat"
  };
}
