import {
  evaluateApprovalSafetyPolicy,
  type ApprovalSafetyDecision,
  type ApprovalSafetyInput,
  type ApprovalSafetyRuleID
} from "./approvalSafetyPolicy.ts";
import type { ApprovalDecision } from "../providers/types.ts";

export type ApprovalFastDecision =
  | { decision: "none" }
  | {
      decision: "deny-now";
      reason: string;
      resolver_decision: ApprovalDecision;
      rule_id: ApprovalSafetyRuleID;
    };

export type ApprovalFastInput = ApprovalSafetyInput;

export function evaluateApprovalFastPolicy(input: ApprovalFastInput): ApprovalFastDecision {
  return fastDenyDecision(evaluateApprovalSafetyPolicy(input));
}

function fastDenyDecision(decision: ApprovalSafetyDecision): ApprovalFastDecision {
  if (decision.decision !== "deny") return { decision: "none" };
  return {
    decision: "deny-now",
    reason: decision.reason,
    resolver_decision: { decision: "deny", scope: "turn" },
    rule_id: decision.rule_id
  };
}
