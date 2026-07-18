import { describe, expect, test } from "bun:test";
import { supervisorRecoveryActionCandidates } from "./recoveryActionPlanner.ts";

describe("supervisor recovery action planner", () => {
  test("plans resume follow-up with a concise continue prompt for idle sessions", () => {
    expect(supervisorRecoveryActionCandidates({
      eventID: "event-idle",
      issueID: 519,
      payload: {
        allowed_actions: ["session.resume_followup"],
        diagnosis_code: "session_no_recent_progress",
        issue_status: "in_progress",
        issue_updated_at: "2026-06-22T08:35:07Z",
        provider: "codex",
        provider_session_id: "thread-519",
        provider_turn_id: "turn-519",
        ready: true,
        run_id: "issue-519-attempt-1",
        signal_type: "supervisor.candidate",
        supervisor_mode: "autonomous"
      },
      projectID: "movo-mobile"
    })).toContainEqual(expect.objectContaining({
      action_type: "session.resume_followup",
      payload: expect.objectContaining({
        prompt: expect.stringContaining("继续"),
        provider_session_id: "thread-519"
      })
    }));
  });

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

  test("retries a stale active turn instead of sending a follow-up into a disconnected session", () => {
    expect(supervisorRecoveryActionCandidates({
      eventID: "event-stale-active",
      issueID: 741,
      payload: {
        allowed_actions: ["session.resume_followup", "issue.retry"],
        diagnosis_code: "session_no_recent_progress",
        issue_status: "in_progress",
        issue_updated_at: "2026-07-18T16:27:16Z",
        provider: "codex",
        provider_session_id: "thread-741",
        provider_turn_id: "turn-741",
        ready: true,
        run_id: "issue-741-attempt-4",
        session_status: "disconnected",
        signal_type: "supervisor.candidate",
        supervisor_mode: "autonomous"
      },
      projectID: "codex-issue-runner"
    })).toContainEqual(expect.objectContaining({ action_type: "issue.retry" }));
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

  test("retries immediately when a provider reconnect window is already due", () => {
    expect(supervisorRecoveryActionCandidates({
      eventID: "event-reconnect-ready",
      issueID: 743,
      payload: {
        allowed_actions: ["issue.retry_after", "issue.retry"],
        diagnosis_code: "executor_stream_disconnected",
        issue_status: "in_progress",
        issue_updated_at: "2026-07-18T16:18:52Z",
        ready: true,
        retry_after_ready: "true",
        run_id: "issue-743-attempt-1",
        signal_type: "supervisor.candidate",
        supervisor_mode: "autonomous",
        wait_until: "2026-07-18T16:18:57Z"
      },
      projectID: "codex-issue-runner"
    })).toContainEqual(expect.objectContaining({ action_type: "issue.retry" }));
  });

  test("plans a fresh issue retry for the first transient startup timeout without a session", () => {
    expect(supervisorRecoveryActionCandidates({
      eventID: "event-startup-timeout",
      issueID: 670,
      payload: {
        allowed_actions: ["issue.retry", "needs_user.escalate"],
        budget_remaining: 2,
        diagnosis_code: "provider_transient_network_error",
        issue_status: "in_progress",
        issue_updated_at: "2026-07-16T11:40:21Z",
        provider: "codex",
        provider_error_category: "network",
        ready: true,
        reason: "codex app-server request timed out after 90000ms: thread/start",
        run_id: "issue-670-attempt-1",
        run_status: "in_progress",
        signal_type: "supervisor.candidate",
        supervisor_mode: "autonomous"
      },
      projectID: "codex-issue-runner"
    })).toContainEqual(expect.objectContaining({
      action_type: "issue.retry",
      payload: expect.objectContaining({
        diagnosis_code: "provider_transient_network_error",
        issue_id: 670,
        provider: "codex"
      })
    }));
  });

  test("plans provider runtime unavailable as user escalation despite resume-only policy", () => {
    const [candidate] = supervisorRecoveryActionCandidates({
      eventID: "event-provider-outage",
      issueID: 524,
      payload: {
        allowed_actions: ["session.resume_followup"],
        budget_remaining: 0,
        cooldown_until: "2026-06-22T08:45:00Z",
        diagnosis_code: "provider_runtime_unavailable",
        issue_status: "in_progress",
        issue_updated_at: "2026-06-22T08:35:07Z",
        provider: "claude",
        ready: true,
        reason: "latest provider error has no recoverable provider session",
        run_id: "issue-524-attempt-1",
        signal_type: "supervisor.candidate",
        supervisor_mode: "autonomous"
      },
      projectID: "demo"
    });

    const gatePolicy = candidate?.gate_policy as Record<string, unknown>;
    const payload = candidate?.payload as Record<string, unknown>;

    expect(candidate).toMatchObject({
      action_type: "needs_user.escalate",
      gate_policy: expect.objectContaining({
        hard_outage_escalation: true,
        policy_override_reason: "provider_runtime_unavailable_requires_user_escalation"
      })
    });
    expect(gatePolicy.allowed_actions).toEqual(["session.resume_followup", "needs_user.escalate"]);
    expect(gatePolicy.authorizedActions).toContainEqual({
      action_type: "needs_user.escalate",
      issue_id: 524,
      project_id: "demo"
    });
    expect(String(payload.message)).toContain("provider：claude");
    expect(String(payload.message)).toContain("issue id：524");
    expect(String(payload.message)).toContain("诊断码：provider_runtime_unavailable");
    expect(String(payload.message)).toContain("错误摘要：latest provider error has no recoverable provider session");
    expect(String(payload.message)).toContain("请检查/重启 Codex app-server 或 Claude Code provider 后再 retry");
    expect(payload.next_step).toBe("请检查/重启 Codex app-server 或 Claude Code provider 后再 retry。");
    expect(payload.provider).toBe("claude");
  });
});
