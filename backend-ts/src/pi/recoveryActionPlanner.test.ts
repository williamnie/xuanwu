import { describe, expect, test } from "bun:test";
import { supervisorRecoveryActionCandidates } from "./recoveryActionPlanner.ts";

describe("supervisor recovery action planner", () => {
  test("plans retry-after for rate limit wait windows", () => {
    expect(supervisorRecoveryActionCandidates({
      eventID: "event-retry-after",
      issueID: 504,
      payload: {
        allowed_actions: ["issue.retry_after", "issue.retry"],
        diagnosis_code: "provider_retry_after_waiting",
        issue_status: "in_progress",
        issue_updated_at: "2026-06-10T08:00:00Z",
        ready: true,
        run_id: "issue-504-attempt-1",
        signal_type: "supervisor.candidate",
        supervisor_mode: "autonomous",
        wait_until: "2026-06-10T08:10:00Z"
      },
      projectID: "demo"
    })).toContainEqual(expect.objectContaining({
      action_type: "issue.retry_after",
      payload: expect.objectContaining({ retry_after_at: "2026-06-10T08:10:00Z" })
    }));
  });

  test("plans issue retry when scheduled retry-after is ready", () => {
    expect(supervisorRecoveryActionCandidates({
      eventID: "event-retry-after-ready",
      issueID: 504,
      payload: {
        allowed_actions: ["issue.retry_after", "issue.retry"],
        diagnosis_code: "provider_retry_after_ready",
        issue_status: "in_progress",
        issue_updated_at: "2026-06-10T08:00:00Z",
        ready: true,
        retry_after_ready: "true",
        run_id: "issue-504-attempt-1",
        signal_type: "supervisor.candidate",
        supervisor_mode: "autonomous",
        wait_until: "2026-06-10T08:10:00Z"
      },
      projectID: "demo"
    })).toContainEqual(expect.objectContaining({
      action_type: "issue.retry",
      payload: expect.objectContaining({ issue_id: 504 })
    }));
  });
});
