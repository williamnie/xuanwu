import { describe } from "bun:test";
import { registerPolicySchemaCases } from "./policySchemaCases.ts";
import { registerPolicyEvaluationCases } from "./policyEvaluationCases.ts";
import { registerPolicyTrustCases } from "./policyTrustCases.ts";
import { registerPolicyOverridesCases } from "./policyOverridesCases.ts";

describe("Workflow Verification Policy schema", () => {
  registerPolicySchemaCases();
});

describe("registry-neutral evaluator", () => {
  registerPolicyEvaluationCases();
});

describe("skip, risk and project overrides", () => {
  registerPolicyTrustCases();
  registerPolicyOverridesCases();
});
