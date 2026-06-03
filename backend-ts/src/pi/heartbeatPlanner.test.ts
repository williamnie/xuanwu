import { describe, expect, test } from "bun:test";
import { planHeartbeatActions } from "./heartbeatPlanner.ts";
import type { HeartbeatSignals } from "./heartbeatTypes.ts";

const NOW = new Date("2026-06-02T10:00:00Z");

describe("PI heartbeat planner", () => {
  test("plans candidates for todo without session, retryable failures, and verification timeouts", () => {
    const signals = baseSignals({
      project: {
        ...baseSignals().project!,
        findings: [
          {
            category: "transient",
            issue_id: 2,
            message: "Issue #2 failed: network error",
            project_id: "demo",
            reason: "transient_retry_waiting",
            severity: "needs_review",
            status: "failed",
            title: "Retryable failure",
            updated_at: "2026-06-02T09:00:00Z"
          },
          {
            category: "verification_needed",
            issue_id: 3,
            message: "Issue #3 is pending verification",
            project_id: "demo",
            reason: "pending_verification",
            severity: "needs_review",
            status: "pending_verification",
            title: "Pending acceptance",
            updated_at: "2026-06-01T09:00:00Z"
          }
        ],
        latest_issues: [
          { id: 1, status: "todo", title: "No session", updated_at: "2026-06-02T09:00:00Z" },
          { id: 2, status: "failed", title: "Retryable failure", updated_at: "2026-06-02T09:00:00Z" },
          { id: 3, status: "pending_verification", title: "Pending acceptance", updated_at: "2026-06-01T09:00:00Z" }
        ]
      }
    });

    const candidates = planHeartbeatActions(signals, { now: NOW, projectID: "demo" });

    expect(candidates).toContainEqual(expect.objectContaining({
      action_type: "issue.enqueue",
      issue_id: 1,
      payload: { issue_id: 1 },
      project_id: "demo",
      source: "pi_heartbeat"
    }));
    expect(candidates).toContainEqual(expect.objectContaining({
      action_type: "issue.retry_proposal",
      issue_id: 2,
      payload: { issue_id: 2 },
      project_id: "demo"
    }));
    expect(candidates).toContainEqual(expect.objectContaining({
      action_type: "needs_user.escalate",
      issue_id: 3,
      payload: expect.objectContaining({ issue_id: 3, reason: "pending_verification_timeout" }),
      project_id: "demo"
    }));
    expect(candidates.every((candidate) => candidate.rationale && candidate.rationale.length > 0)).toBe(true);
  });

  test("does not plan actions when signals show no actionable issue state", () => {
    const signals = baseSignals({
      agent_sessions: {
        recent: [{
          agent_role: "executor",
          issue_id: 1,
          provider: "codex",
          provider_session_id: "thread-1",
          raw_ref: {},
          session_key: "codex:thread-1",
          status: "running",
          title: "Todo with session",
          updated_at: "2026-06-02T09:30:00Z"
        }],
        status_counts: { running: 1 },
        total: 1
      },
      project: {
        ...baseSignals().project!,
        latest_issues: [
          { id: 1, status: "todo", title: "Todo with session", updated_at: "2026-06-02T09:00:00Z" },
          { id: 2, status: "pending_verification", title: "Recent verification", updated_at: "2026-06-02T09:30:00Z" },
          { id: 3, status: "done", title: "Done", updated_at: "2026-06-02T09:40:00Z" }
        ]
      }
    });

    expect(planHeartbeatActions(signals, { now: NOW, projectID: "demo" })).toEqual([]);
  });
});

function baseSignals(overrides: Partial<HeartbeatSignals> = {}): HeartbeatSignals {
  return {
    agent_sessions: { recent: [], status_counts: {}, total: 0 },
    cron: { active: 0, due: 0, total: 0 },
    delegations: { active: 0, due: 0 },
    issues: { status_counts: {}, total: 0 },
    issue_runs: { open: 0, recent: [], status_counts: {}, total: 0 },
    memory: { active: 0, pinned: 0 },
    pi_conversations: { active: 0, total: 0 },
    project: {
      active_holds: [],
      compact_summary: "project demo",
      cwd: "[redacted-path]/demo",
      findings: [],
      id: "demo",
      issue_status_counts: {},
      latest_issues: [],
      name: "demo",
      provider: "codex",
      recent_errors: [],
      recent_runs: [],
      recent_sessions: [],
      run_status_counts: {},
      session_progress: [],
      session_status_counts: {},
      total_issues: 0
    },
    project_settings: {
      pi_settings: null,
      project: {
        approval_policy: "default",
        auto_run: 1,
        cwd: "[redacted-path]/demo",
        default_agent_profile_id: "",
        default_mcp_policy: {},
        default_skill_policy: {},
        id: "demo",
        model: "",
        name: "demo",
        provider: "codex",
        provider_config: {},
        sandbox: "workspace-write"
      }
    },
    provider_health: { provider: "codex", status: "configured" },
    usage_cost: { status: "not_configured", total_tokens: 0 },
    ...overrides
  };
}
