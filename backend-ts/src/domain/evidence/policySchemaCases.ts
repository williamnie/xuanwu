import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { Value } from "@sinclair/typebox/value";

import { VERIFICATION_POLICY_SCHEMA, validateWorkflowVerificationPolicy } from "./policy.ts";
import { ADR_PATH, policy, group, requirement } from "./policyTestFixtures.ts";

export function registerPolicySchemaCases() {
  test("accepts a closed registry-neutral policy and rejects undeclared fields", () => {
    const value = policy();
    expect(Value.Check(VERIFICATION_POLICY_SCHEMA, value)).toBe(true);
    expect(validateWorkflowVerificationPolicy(value)).toEqual({ errors: [], ok: true });
    expect(Value.Check(VERIFICATION_POLICY_SCHEMA, { ...value, workflow_registry_id: "coupled" })).toBe(false);
  });

  test("requires explicit trust rules before a future Evidence kind can gate completion", () => {
    const unknown = policy({
      required_groups: [group("custom", "all", [requirement("custom", ["device_attestation"])])]
    });
    expect(validateWorkflowVerificationPolicy(unknown)).toMatchObject({
      ok: false,
      errors: [expect.stringContaining("unregistered Evidence kind device_attestation")]
    });

    unknown.kind_rules = [{
      kind: "device_attestation",
      allowed_assertion_origins: ["system_observation"],
      allowed_source_kinds: ["command_execution"]
    }];
    expect(validateWorkflowVerificationPolicy(unknown)).toEqual({ errors: [], ok: true });
  });

  test("rejects duplicate requirement ids and forbidden-risk manual bypass", () => {
    const value = policy({
      optional_requirements: [requirement("test", ["browser"])],
      risk_overrides: [{
        risk: "forbidden",
        additional_required_groups: [],
        manual_override: "allow_with_human_evidence"
      }]
    });
    const validation = validateWorkflowVerificationPolicy(value);
    expect(validation.ok).toBe(false);
    expect(validation.errors).toContain("duplicate optional requirement test");
    expect(validation.errors).toContain("forbidden risk cannot allow manual verification override");
  });

  test("documents authority, migration windows, rollback and deletion gates", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    expect(adr).toContain("Registry-neutral");
    expect(adr).toContain("本期双写窗口为 0");
    expect(adr).toContain("最多两个正式 release window");
    expect(adr).toContain("回滚");
    expect(adr).toContain("P11.03/P11.06");
    expect(adr).toContain("P04.07 才能把 evaluator 结果接入 `done`");
    expect(adr).toContain("LLM 不能通过生成 reason");
  });
}
