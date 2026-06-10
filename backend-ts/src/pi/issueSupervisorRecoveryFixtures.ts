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
        project_id: "codex-issue-runner",
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
        project_id: "codex-issue-runner",
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
    id: "consecutive-recovery-no-progress",
    events: [
      {
        diagnosis_code: "session_recovery_exhausted",
        event_type: "signal",
        issue_id: 298,
        payload_json: { attempts_24h: 2, last_outcome: "no_progress" },
        project_id: "codex-issue-runner",
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
