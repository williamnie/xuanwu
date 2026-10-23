import type { PiAgent } from "../../db/repositories/pi.ts";
import type { Project } from "../../db/repositories/projects.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_TIME, insertProject, insertRow, useTestDatabase } from "../../testing/harness.ts";
import { useFauxPi, type FauxPi } from "../../testing/fauxPi.ts";

export type DecisionFixture = { agent: PiAgent; db: RunnerDatabase; faux: FauxPi; project: Project };

const AGENT: PiAgent = {
  id: "pi-supervisor", name: "PI Supervisor", provider: "pi-sdk", model_provider: "pi-supervisor", model_id: "faux-1",
  thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
  created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME
};

/**
 * Returns `open()`: project "demo" checked out in a temp dir and a "pi-supervisor" agent whose model is the returned
 * faux provider. Databases close and providers unregister after each test of the calling file.
 */
export function useDecisionFixture(): () => Promise<DecisionFixture> {
  const openTestDatabase = useTestDatabase("xuanwu-supervisor-decision-");
  const fauxPi = useFauxPi();
  return async () => {
    const db = await openTestDatabase();
    const projectCwd = join(db.path, "..", "..", "project");
    mkdirSync(projectCwd, { recursive: true });
    writeFileSync(join(projectCwd, "README.md"), "# Demo\n");
    insertProject(db, "demo", { cwd: projectCwd, sort_order: 1 });
    insertRow(db, "pi_agents", { id: AGENT.id, name: AGENT.name, created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME });
    const faux = fauxPi(db, { agentId: AGENT.id, provider: AGENT.model_provider });
    const project: Project = {
      id: "demo", name: "demo", cwd: projectCwd, provider: "codex", provider_config_json: "{}", auto_run: 1,
      model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
      sort_order: 1, created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME,
      default_mcp_policy: "{}", default_skill_policy: "{}", loop_status: "stopped", provider_capabilities: []
    };
    return { agent: AGENT, db, faux, project };
  };
}

export function streamDisconnectContext(): IssueSupervisorRecoveryContext {
  return {
    candidates: [{
      diagnosis_code: "executor_stream_disconnected",
      evidence_refs: ["provider_error"],
      reason: "Reconnecting... 1/5"
    }],
    issue: { attempt_count: 1, id: 298, status: "in_progress", title: "Stream disconnected" },
    latest_run: {
      ended_at: "", id: "issue-298-attempt-1", provider: "codex",
      provider_session_id: "thread-298", provider_turn_id: "turn-298", started_at: "2026-06-10T07:50:00Z", status: "in_progress"
    },
    policy: { allowed_actions: ["session.resume_followup"], budget_remaining: 2 },
    project: { auto_run: true, cwd: "/tmp/demo", id: "demo", provider: "codex" },
    provider_error: {
      category: "stream_disconnect",
      diagnosis_code: "executor_stream_disconnected",
      provider: "codex",
      raw_summary: "Reconnecting... 1/5"
    },
    recent_events: [{ at: "2026-06-10T07:59:00Z", id: 1, markers: [], summary: "Reconnecting... 1/5", type: "issue.log" }],
    recovery_history: { attempts_24h: 0, budget_remaining: 2, last_outcome: "unknown" },
    session: {
      provider: "codex", provider_session_id: "thread-298", provider_turn_id: "turn-298",
      raw_status: "running", run_state: "open", status: "disconnected"
    },
    workspace_snapshot: { git_status_summary: "clean", last_commands: [], progress_markers: [] }
  };
}

export function rateLimitContext(): IssueSupervisorRecoveryContext {
  return {
    ...streamDisconnectContext(),
    candidates: [{
      diagnosis_code: "provider_retry_after_waiting",
      evidence_refs: ["provider_error"],
      reason: "HTTP 429 too many requests",
      wait_until: "2026-06-10T08:10:00Z"
    }],
    issue: { attempt_count: 1, id: 301, status: "in_progress", title: "Rate limited" },
    provider_error: {
      category: "rate_limit",
      diagnosis_code: "provider_retry_after_waiting",
      raw_summary: "HTTP 429 too many requests",
      retry_after_at: "2026-06-10T08:10:00Z",
      retry_after_seconds: 600,
      status_code: 429
    }
  };
}

export function authContext(): IssueSupervisorRecoveryContext {
  return {
    ...streamDisconnectContext(),
    candidates: [{ diagnosis_code: "requires_human_decision", evidence_refs: ["provider_error"], reason: "HTTP 401 unauthorized" }],
    issue: { attempt_count: 1, id: 303, status: "in_progress", title: "Auth failed" },
    provider_error: {
      category: "auth",
      diagnosis_code: "requires_human_decision",
      raw_summary: "HTTP 401 unauthorized",
      status_code: 401
    }
  };
}

export function providerRuntimeUnavailableContext(): IssueSupervisorRecoveryContext {
  return {
    ...streamDisconnectContext(),
    candidates: [{
      diagnosis_code: "executor_stream_disconnected",
      evidence_refs: ["provider_error"],
      reason: "stream disconnected before completion"
    }, {
      diagnosis_code: "provider_runtime_unavailable",
      evidence_refs: ["provider_error", "latest_run", "session"],
      reason: "latest provider error has no recoverable provider session"
    }],
    issue: { attempt_count: 1, id: 526, status: "in_progress", title: "Provider runtime unavailable" },
    latest_run: {
      ended_at: "", id: "issue-526-attempt-1", provider: "claude",
      provider_session_id: "", provider_turn_id: "", started_at: "2026-06-10T07:50:00Z", status: "in_progress"
    },
    policy: { allowed_actions: ["session.resume_followup"], budget_remaining: 1 },
    project: { auto_run: true, cwd: "/tmp/demo", id: "demo", provider: "claude" },
    provider_error: {
      category: "network",
      diagnosis_code: "provider_transient_network_error",
      provider: "claude",
      raw_summary: "Claude Code run timed out after 10000ms: initialize"
    },
    recovery_history: { attempts_24h: 1, budget_remaining: 1, last_outcome: "deferred" },
    session: {
      provider: "claude", provider_session_id: "", provider_turn_id: "",
      raw_status: "", run_state: "open", status: "unknown"
    }
  };
}

export function businessFailureContext(): IssueSupervisorRecoveryContext {
  return {
    ...streamDisconnectContext(),
    candidates: [{ diagnosis_code: "requires_human_decision", evidence_refs: ["provider_error"], reason: "focused test failed" }],
    issue: { attempt_count: 1, id: 304, status: "in_progress", title: "Tests failed" },
    provider_error: {
      category: "business_failure",
      diagnosis_code: "requires_human_decision",
      raw_summary: "focused test failed: expected status 200"
    },
    recent_events: [{ at: "2026-06-10T07:59:00Z", id: 4, markers: ["verification"], summary: "focused test failed: expected status 200", type: "issue.log" }]
  };
}

export function insertIssueFixture(db: RunnerDatabase, input: { issueID: number; projectID: string; sessionID: string }): void {
  db.sqlite.run(`insert into issues (id, project_id, title, status, attempt_count, created_at, updated_at)
    values (?, ?, 'Stream disconnected', 'in_progress', 1, ?, ?)`,
  [input.issueID, input.projectID, "2026-06-10T07:00:00Z", "2026-06-10T07:59:00Z"]);
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, 'turn-298', '2026-06-10T07:50:00Z', '')`,
  [`issue-${input.issueID}-attempt-1`, input.issueID, input.sessionID]);
  db.sqlite.run(`insert into agent_sessions
    (session_key, provider, provider_session_id, project_id, issue_id, status, raw_ref, created_at, updated_at)
    values (?, 'codex', ?, ?, ?, 'running', '{}', ?, ?)`,
  [`codex:${input.sessionID}`, input.sessionID, input.projectID, input.issueID, "2026-06-10T07:50:00Z", "2026-06-10T07:59:00Z"]);
}
