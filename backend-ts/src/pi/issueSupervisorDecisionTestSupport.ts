import type { PiAgent } from "../db/repositories/pi.ts";
import type { Project } from "../db/repositories/projects.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { IssueSupervisorRecoveryContext } from "./issueSupervisorContext.ts";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempRoots: string[] = [];

export async function cleanupDecisionFixtures(): Promise<void> {
  while (tempRoots.length > 0) await rm(tempRoots.pop() ?? "", { recursive: true, force: true });
}

export async function openDecisionFixture(prefix: string): Promise<{ agent: PiAgent; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  const projectCwd = join(root, "project");
  mkdirSync(projectCwd, { recursive: true });
  writeFileSync(join(projectCwd, "README.md"), "# Demo\n");
  const db = await openDatabase({ stateDir: join(root, "state") });
  insertProject(db, "demo", projectCwd);
  insertAgent(db);
  writeFauxModelsConfig(db);
  return { agent: agentRecord(), db, project: projectRecord(projectCwd) };
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

function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, sort_order, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?)`, [id, id, cwd, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
}

function insertAgent(db: RunnerDatabase): void {
  db.sqlite.run(`insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)`,
  ["pi-supervisor", "PI Supervisor", "pi-supervisor", "faux-1", "off", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
}

function agentRecord(): PiAgent {
  return {
    id: "pi-supervisor", name: "PI Supervisor", provider: "pi-sdk", model_provider: "pi-supervisor", model_id: "faux-1",
    thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
  };
}

function projectRecord(cwd: string): Project {
  return {
    id: "demo", name: "demo", cwd, provider: "codex", provider_config_json: "{}", auto_run: 1,
    model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
    sort_order: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    default_mcp_policy: "{}", default_skill_policy: "{}", loop_status: "stopped", provider_capabilities: []
  };
}

function writeFauxModelsConfig(db: RunnerDatabase): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: { "pi-supervisor": { api: "pi-supervisor-api", apiKey: "test", baseUrl: "http://localhost:0", models: [{ id: "faux-1" }] } }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}
