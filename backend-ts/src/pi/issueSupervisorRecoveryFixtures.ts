import type { IssueSupervisorEventInput } from "../db/repositories/pi.ts";
import type { PiSupervisorDecisionJson } from "./issueSupervisorRecovery.ts";

export type IssueSupervisorRecoveryFixture = {
  decisions: PiSupervisorDecisionJson[];
  events: IssueSupervisorEventInput[];
  id: string;
};

export const issueSupervisorRecoveryFixtures: IssueSupervisorRecoveryFixture[] = [
  {
    id: "issue-298-stream-disconnect",
    events: [
      {
        diagnosis_code: "executor_stream_disconnected",
        event_type: "signal",
        issue_id: 298,
        payload_json: {
          recent_events: [{ at: "2026-06-10T01:58:00Z", summary: "Reconnecting... 1/5", type: "error" }]
        },
        project_id: "xuanwu",
        provider: "codex",
        provider_session_id: "thread-298",
        run_id: "issue-298-attempt-1"
      }
    ],
    decisions: [
      {
        confidence: "high",
        decision: "resume_session",
        evidence_refs: ["event:157762", "run:issue-298-attempt-1"],
        expected_outcome: "session resumes and emits new progress events",
        fallback_if_no_progress: "needs_user",
        rationale: "stream disconnected after reconnect attempts while issue stayed in_progress",
        recovery_message: "Inspect current state, avoid duplicate work, then continue the issue if safe.",
        risk_level: "medium"
      }
    ]
  },
  {
    id: "provider-429-retry-after",
    events: [
      {
        diagnosis_code: "provider_rate_limited",
        event_type: "signal",
        issue_id: 301,
        payload_json: { retry_after_seconds: 600, status_code: 429 },
        project_id: "xuanwu",
        provider: "codex",
        provider_error_category: "rate_limit",
        retry_after_at: "2026-06-10T02:10:00Z"
      }
    ],
    decisions: [
      {
        confidence: "high",
        decision: "wait",
        evidence_refs: ["event:429", "issue:301"],
        expected_outcome: "provider retry window opens before any recovery action is attempted",
        fallback_if_no_progress: "retry_issue",
        rationale: "provider returned 429 with an explicit retry-after window",
        risk_level: "low",
        wait_until: "2026-06-10T02:10:00Z"
      }
    ]
  },
  {
    id: "provider-429-no-retry-after",
    events: [
      {
        diagnosis_code: "provider_rate_limited",
        event_type: "signal",
        issue_id: 302,
        payload_json: { status_code: 429, summary: "HTTP 429 too many requests without retry-after" },
        project_id: "xuanwu",
        provider: "codex",
        provider_error_category: "rate_limit"
      }
    ],
    decisions: [
      {
        confidence: "medium",
        decision: "wait",
        evidence_refs: ["event:429-no-retry-after", "issue:302"],
        expected_outcome: "supervisor waits for policy cooldown before asking PI to recover again",
        fallback_if_no_progress: "retry_issue",
        rationale: "provider returned 429 without retry-after, so policy cooldown is safer than immediate recovery",
        risk_level: "low",
        wait_until: "2026-06-10T02:05:00Z"
      }
    ]
  },
  {
    id: "provider-401-auth",
    events: [
      {
        diagnosis_code: "requires_human_decision",
        event_type: "signal",
        issue_id: 303,
        payload_json: { status_code: 401, summary: "HTTP 401 unauthorized" },
        project_id: "xuanwu",
        provider: "codex",
        provider_error_category: "auth"
      }
    ],
    decisions: [
      {
        confidence: "high",
        decision: "needs_user",
        evidence_refs: ["event:401", "issue:303"],
        expected_outcome: "human refreshes provider credentials before any recovery action is attempted",
        fallback_if_no_progress: "blocked",
        rationale: "provider authentication failed and automatic recovery cannot fix credentials safely",
        recovery_message: "Codex provider authentication failed; refresh credentials or explicitly approve the next recovery step.",
        risk_level: "medium"
      }
    ]
  },
  {
    id: "business-test-failure",
    events: [
      {
        diagnosis_code: "requires_human_decision",
        event_type: "signal",
        issue_id: 304,
        payload_json: { summary: "focused test failed with assertion error" },
        project_id: "xuanwu",
        provider: "codex",
        provider_error_category: "business_failure"
      }
    ],
    decisions: [
      {
        confidence: "high",
        decision: "needs_user",
        evidence_refs: ["event:test-failure", "issue:304"],
        expected_outcome: "executor or human fixes the test failure rather than supervisor retrying the same session",
        fallback_if_no_progress: "blocked",
        rationale: "the issue failed because a test/business assertion failed, not because the provider stream was transient",
        recovery_message: "Tests failed in the executor; inspect the failure and fix the underlying issue before retrying.",
        risk_level: "medium"
      }
    ]
  },
  {
    id: "consecutive-recovery-no-progress",
    events: [
      {
        diagnosis_code: "session_recovery_exhausted",
        event_type: "signal",
        issue_id: 298,
        payload_json: { attempts_24h: 2, last_outcome: "no_progress" },
        project_id: "xuanwu",
        provider: "codex",
        provider_session_id: "thread-298"
      }
    ],
    decisions: [
      {
        confidence: "medium",
        decision: "needs_user",
        evidence_refs: ["issue:298", "supervisor_event:2"],
        expected_outcome: "human decides whether to retry, cancel, or provide extra instructions",
        fallback_if_no_progress: "blocked",
        rationale: "two recovery attempts produced no meaningful progress",
        recovery_message: "Supervisor recovery budget is exhausted; human input is needed before another attempt.",
        risk_level: "medium"
      }
    ]
  }
];
