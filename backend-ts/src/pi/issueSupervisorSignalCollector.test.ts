import { describe, expect, test } from "bun:test";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { supervisorCandidateReady } from "./issueSupervisorSignalCollector.ts";

const NOW = new Date("2026-06-18T02:00:00Z");

describe("PI issue supervisor signal collector", () => {
  test("uses deterministic diagnosis classes for readiness", () => {
    const context = recoveryContext(600);

    for (const diagnosis_code of ["provider_eof", "provider_timeout", "stream_disconnect"] as const) {
      expect(supervisorCandidateReady(context, {
        diagnosis_code,
        evidence_refs: ["provider_error"],
        reason: diagnosis_code
      }, NOW, { staleAfterSeconds: 300 })).toBe(true);
    }
    expect(supervisorCandidateReady(recoveryContext(10), {
      diagnosis_code: "provider_timeout",
      evidence_refs: ["provider_error"],
      reason: "timeout"
    }, NOW, { staleAfterSeconds: 300 })).toBe(false);
    expect(supervisorCandidateReady(context, {
      diagnosis_code: "missing_user_input",
      evidence_refs: ["provider_error"],
      reason: "missing context"
    }, NOW)).toBe(true);
    expect(supervisorCandidateReady(context, {
      diagnosis_code: "session_recovery_exhausted",
      evidence_refs: ["recovery_history"],
      exhausted: true,
      reason: "budget exhausted"
    }, NOW)).toBe(true);
  });
});

function recoveryContext(staleGapSeconds: number): IssueSupervisorRecoveryContext {
  return {
    candidates: [],
    issue: { id: 1 },
    latest_run: null,
    policy: {},
    project: { id: "demo" },
    provider_error: null,
    recent_events: [],
    recovery_history: {},
    session: { stale_gap_seconds: staleGapSeconds },
    workspace_snapshot: {}
  };
}
