import { describe, expect, test } from "bun:test";
import {
  normalizeVerificationEvidence,
  redactVerificationEvidence,
  serializeVerificationEvidence,
  validateVerificationEvidence
} from "./verificationEvidence.ts";

describe("Verification Evidence v0", () => {
  test("normalizes shell test and http smoke evidence with deterministic timestamps", () => {
    const shell = normalizeVerificationEvidence({
      version: 0,
      kind: "shell_test",
      status: "passed",
      summary: "  bun test src/pi/verificationEvidence.test.ts passed  ",
      command: " bun test src/pi/verificationEvidence.test.ts ",
      artifact_refs: [" log:verificationEvidence ", "", " screenshot:unused "]
    }, { now: "2026-06-30T00:00:00.000Z" });

    expect(shell).toEqual({
      version: 0,
      kind: "shell_test",
      status: "passed",
      summary: "bun test src/pi/verificationEvidence.test.ts passed",
      command: "bun test src/pi/verificationEvidence.test.ts",
      artifact_refs: ["log:verificationEvidence", "screenshot:unused"],
      created_at: "2026-06-30T00:00:00.000Z"
    });

    expect(normalizeVerificationEvidence({
      version: 0,
      kind: "http_smoke",
      status: "failed",
      summary: "Browser smoke failed with 500",
      url: " http://127.0.0.1:3008/health ",
      artifact_refs: ["screenshot:health-500"]
    }, { now: new Date("2026-06-30T00:01:00.000Z") })).toMatchObject({
      version: 0,
      kind: "http_smoke",
      status: "failed",
      summary: "Browser smoke failed with 500",
      url: "http://127.0.0.1:3008/health",
      created_at: "2026-06-30T00:01:00.000Z"
    });
  });

  test("validates human pending and independent checker failure shapes", () => {
    expect(validateVerificationEvidence({
      kind: "human_verification",
      status: "pending",
      summary: "Waiting for App Store Connect manual check",
      artifact_refs: [],
      created_at: "2026-06-30T00:02:00.000Z"
    })).toEqual({ ok: true, errors: [] });

    const checker = normalizeVerificationEvidence({
      version: 0,
      kind: "independent_checker",
      status: "failed",
      summary: "Checker found blocking regressions",
      checker: "codex-verifier",
      blocking_issues: ["missing focused test", "UI smoke failed"]
    }, { now: "2026-06-30T00:03:00.000Z" });

    expect(checker).toMatchObject({
      version: 0,
      kind: "independent_checker",
      status: "failed",
      checker: "codex-verifier",
      blocking_issues: ["missing focused test", "UI smoke failed"]
    });
    expect(validateVerificationEvidence(checker)).toEqual({ ok: true, errors: [] });
  });

  test("reports validation errors without mutating unknown input", () => {
    const input = {
      kind: "browser",
      status: "ok",
      summary: " ",
      artifact_refs: "not-an-array",
      created_at: "not-a-date"
    };

    expect(validateVerificationEvidence(input)).toEqual({
      ok: false,
      errors: [
        "kind must be one of shell_test, http_smoke, human_verification, independent_checker",
        "status must be one of passed, failed, pending, blocked",
        "summary is required",
        "artifact_refs must be an array of strings",
        "created_at must be an ISO timestamp"
      ]
    });
    expect(input).toEqual({
      kind: "browser",
      status: "ok",
      summary: " ",
      artifact_refs: "not-an-array",
      created_at: "not-a-date"
    });
  });

  test("redacts secret-like values before serialize", () => {
    const evidence = redactVerificationEvidence({
      version: 0,
      kind: "shell_test",
      status: "passed",
      summary: "token super-secret\nbun test passed",
      command: "CODEX_RUNNER_AUTH_TOKEN=secret bun test",
      url: "https://example.test/callback?access_token=secret-value",
      checker: "checker SECRET=secret-value",
      artifact_refs: ["log:/tmp/run?api_key=secret-value"],
      blocking_issues: ["failed with Bearer abc.def.ghi"]
    }, { now: "2026-06-30T00:04:00.000Z" });

    const serialized = serializeVerificationEvidence(evidence);

    expect(evidence.summary).toContain("[redacted");
    expect(serialized).not.toContain("super-secret");
    expect(serialized).not.toContain("secret-value");
    expect(serialized).not.toContain("abc.def.ghi");
    expect(JSON.parse(serialized)).toMatchObject({
      version: 0,
      kind: "shell_test",
      status: "passed",
      summary: "token [redacted] bun test passed"
    });
  });
});
