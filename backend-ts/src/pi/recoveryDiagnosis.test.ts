import { describe, expect, test } from "bun:test";
import {
  classifyRecoveryDiagnosis,
  isAutomaticRecoveryBlockedDiagnosis,
  isTransientRecoveryDiagnosis
} from "./recoveryDiagnosis.ts";

describe("recovery diagnosis classifier", () => {
  test("classifies provider runtime unavailable as transient until the recovery budget is exhausted", () => {
    expect(classifyRecoveryDiagnosis({ diagnosisCode: "provider_runtime_unavailable" })).toMatchObject({
      failure_class: "transient",
      severity: "watch"
    });
    expect(isAutomaticRecoveryBlockedDiagnosis("provider_runtime_unavailable")).toBe(false);
    expect(isTransientRecoveryDiagnosis("provider_runtime_unavailable")).toBe(true);
  });
});
