import { describe, expect, test } from "bun:test";
import {
  classifyRecoveryDiagnosis,
  isAutomaticRecoveryBlockedDiagnosis,
  isTransientRecoveryDiagnosis
} from "./recoveryDiagnosis.ts";

describe("recovery diagnosis classifier", () => {
  test("classifies provider runtime unavailable as user-actionable hard outage", () => {
    expect(classifyRecoveryDiagnosis({ diagnosisCode: "provider_runtime_unavailable" })).toMatchObject({
      failure_class: "needs_context",
      severity: "actionable"
    });
    expect(isAutomaticRecoveryBlockedDiagnosis("provider_runtime_unavailable")).toBe(true);
    expect(isTransientRecoveryDiagnosis("provider_runtime_unavailable")).toBe(false);
  });
});
