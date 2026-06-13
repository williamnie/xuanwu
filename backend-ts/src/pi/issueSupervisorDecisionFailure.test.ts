import { describe, expect, test } from "bun:test";
import { decisionFailurePayload, schemaDecisionFailure } from "./issueSupervisorDecisionFailure.ts";
import { rateLimitContext } from "./issueSupervisorDecisionTestSupport.ts";

describe("PI supervisor decision failure diagnostics", () => {
  test("summarizes schema mismatch without creating a user-facing fallback", () => {
    const failure = schemaDecisionFailure({
      confidence: 0,
      decision: "wait",
      evidence_refs: ["provider_error"],
      expected_outcome: "provider retry window is respected",
      fallback_if_no_progress: "ask the user to review the malformed supervisor response",
      rationale: "HTTP 429 includes a future retry-after timestamp",
      risk_level: "low",
      wait_until: null
    });
    const context = rateLimitContext();
    context.latest_run = { ...(context.latest_run ?? {}), id: "issue-301-attempt-1" };
    const raw = `${JSON.stringify({ decision: "wait" })}\n${"x".repeat(2_100)}`;

    const payload = decisionFailurePayload({
      context,
      failure,
      fallback: {
        confidence: "low",
        decision: "noop",
        evidence_refs: ["supervisor_decision_invalid"],
        expected_outcome: "PI records invalid decision internally",
        fallback_if_no_progress: "blocked",
        rationale: failure.error,
        recovery_message: "",
        risk_level: "low"
      },
      raw
    });

    expect(failure.error_summary).toContain("schema validation");
    expect(JSON.stringify(failure.schema_errors)).toContain("/confidence");
    expect(JSON.stringify(failure.schema_errors)).toContain("/fallback_if_no_progress");
    expect(JSON.stringify(failure.schema_errors)).toContain("/wait_until");
    expect(payload).toMatchObject({
      context: { issue_id: 301, project_id: "demo", run_id: "issue-301-attempt-1" },
      fallback_decision: "noop",
      raw_text_truncated: true,
      valid: false
    });
    expect(String(payload.raw_text).length).toBeLessThanOrEqual(2_000);
  });
});
