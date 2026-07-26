import type { RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { getProjectPiSettings, readProjectPiPolicy } from "../db/repositories/pi.ts";
import { redactAuditJsonText } from "../db/repositories/pi/auditRedaction.ts";
import { collectPiMemoryContextItems } from "./memoryContext.ts";
import { collectIssueSupervisorSignals } from "./issueSupervisorSignalCollector.ts";
import { createProjectStatusSnapshot } from "./projectSnapshot.ts";
import type {
  HeartbeatAgentSessionSignal,
  HeartbeatIssueRunSignal,
  HeartbeatProjectSettingsSignal,
  HeartbeatSignals
} from "./heartbeatTypes.ts";
import { iso } from "./heartbeatOrchestratorSupport.ts";

const SIGNAL_LIMIT = 8;
export type HeartbeatSignalScope = { issueIDs?: number[] };

export function collectProjectHeartbeatSignals(
  db: RunnerDatabase,
  projectID: string,
  now: Date,
  scope: HeartbeatSignalScope = {}
): HeartbeatSignals {
  const snapshot = createProjectStatusSnapshot(db, projectID);
  const nowText = iso(now);
  return {
    agent_sessions: agentSessionSignals(db, projectID),
    cron: cronSignals(db, projectID, nowText),
    delegations: delegationSignals(db, projectID, nowText),
    issues: { status_counts: snapshot.issue_status_counts, total: snapshot.total_issues },
    issue_runs: issueRunSignals(db, projectID),
    memory: memorySignals(db, projectID),
    memory_items: memoryItems(db, projectID, scope),
    pi_conversations: conversationSignals(db, projectID),
    project: snapshot,
    project_settings: projectSettings(db, projectID),
    provider_health: providerHealth(db, projectID),
    supervisor: collectIssueSupervisorSignals(db, projectID, now, { issueIDs: scope.issueIDs }),
    usage_cost: usageCost()
  };
}

function issueRunSignals(db: RunnerDatabase, projectID: string) {
  const rows = db.sqlite.query<Record<string, unknown>, [string]>(`
    select ir.id, ir.issue_id, ir.attempt, ir.status, ir.provider, ir.provider_session_id,
      ir.started_at, ir.ended_at, ir.exit_reason, ir.error, ir.runtime_metadata_json
    from issue_runs ir join issues i on i.id=ir.issue_id
    where i.project_id=?
    order by coalesce(nullif(ir.ended_at, ''), ir.started_at) desc, ir.attempt desc, ir.id asc
  `).all(projectID);
  return {
    open: rows.filter((row) => text(row.ended_at) === "").length,
    recent: rows.slice(0, SIGNAL_LIMIT).map(mapIssueRunSignal),
    status_counts: countStatuses(rows),
    total: rows.length
  };
}

function mapIssueRunSignal(row: Record<string, unknown>): HeartbeatIssueRunSignal {
  return {
    attempt: integer(row.attempt),
    ended_at: text(row.ended_at),
    error: safeText(row.error),
    exit_reason: safeText(row.exit_reason),
    issue_id: integer(row.issue_id),
    provider: text(row.provider, "codex"),
    provider_session_id: text(row.provider_session_id),
    run_id: text(row.id),
    runtime_metadata: safeJson(row.runtime_metadata_json),
    started_at: text(row.started_at),
    status: text(row.status, "unknown")
  };
}

function agentSessionSignals(db: RunnerDatabase, projectID: string) {
  const rows = db.sqlite.query<Record<string, unknown>, [string]>(`
    select session_key, provider, provider_session_id, agent_role, project_id, issue_id,
      title, status, raw_ref, updated_at
    from agent_sessions where project_id=? order by updated_at desc, session_key asc
  `).all(projectID);
  return {
    recent: rows.slice(0, SIGNAL_LIMIT).map(mapAgentSessionSignal),
    status_counts: countStatuses(rows),
    total: rows.length
  };
}

function mapAgentSessionSignal(row: Record<string, unknown>): HeartbeatAgentSessionSignal {
  return {
    agent_role: text(row.agent_role),
    issue_id: integer(row.issue_id),
    provider: text(row.provider),
    provider_session_id: text(row.provider_session_id),
    raw_ref: safeJson(row.raw_ref),
    session_key: text(row.session_key),
    status: text(row.status, "unknown"),
    title: safeText(row.title),
    updated_at: text(row.updated_at)
  };
}

function projectSettings(db: RunnerDatabase, projectID: string): HeartbeatProjectSettingsSignal {
  const project = getProject(db, projectID);
  if (!project) throw new Error("project not found");
  const settings = getProjectPiSettings(db, projectID);
  return {
    pi_policy: projectPiPolicy(db, projectID),
    pi_settings: settings ? { managed: true } : null,
    project: {
      approval_policy: project.approval_policy,
      auto_run: project.auto_run,
      cwd: project.cwd === "" ? "" : snapshotPath(project.cwd),
      default_agent_profile_id: project.default_agent_profile_id,
      default_mcp_policy: safeJson(project.default_mcp_policy),
      default_skill_policy: safeJson(project.default_skill_policy),
      id: project.id,
      model: project.model,
      name: safeText(project.name),
      provider: project.provider,
      provider_config: safeJson(project.provider_config_json),
      sandbox: project.sandbox
    }
  };
}

function projectPiPolicy(db: RunnerDatabase, projectID: string) {
  const policy = readProjectPiPolicy(db, projectID);
  return {
    allowed_actions: safeJson(policy.allowed_actions_json) as string[],
    allowed_mcp_capabilities: safeJson(policy.allowed_mcp_capabilities_json) as string[],
    allowed_skill_intents: safeJson(policy.allowed_skill_intents_json) as string[],
    allowed_supervisor_actions: safeJson(policy.allowed_supervisor_actions_json) as string[],
    concurrency_policy: safeJson(policy.concurrency_policy_json) as Record<string, unknown>,
    quiet_hours: safeJson(policy.quiet_hours_json) as Record<string, unknown>,
    retry_policy: safeJson(policy.retry_policy_json) as Record<string, unknown>,
    supervisor_cooldown_seconds: policy.supervisor_cooldown_seconds,
    supervisor_max_recoveries_per_issue: policy.supervisor_max_recoveries_per_issue,
    supervisor_max_recoveries_per_project_per_hour: policy.supervisor_max_recoveries_per_project_per_hour,
    supervisor_rate_limit_wait_policy: policy.supervisor_rate_limit_wait_policy,
    timezone: policy.timezone,
    verification_policy: safeJson(policy.verification_policy_json) as Record<string, unknown>,
    working_hours: safeJson(policy.working_hours_json) as Record<string, unknown>
  };
}

function cronSignals(db: RunnerDatabase, projectID: string, nowText: string) {
  return {
    active: countRows(db, `select count(*) as count from automation_definitions d
      join automation_trigger_configs c on c.automation_id=d.id and c.version=d.active_trigger_version
      where d.scope_kind='project' and d.scope_id=? and d.status='active' and c.trigger_type in ('cron','manual')`, [projectID]),
    due: countRows(db, `select count(*) as count from automation_definitions d
      join automation_trigger_configs c on c.automation_id=d.id and c.version=d.active_trigger_version
      where d.scope_kind='project' and d.scope_id=? and d.status='active'
        and c.trigger_type in ('cron','manual') and d.next_run_at is not null and d.next_run_at<=?`, [projectID, nowText]),
    total: countRows(db, `select count(*) as count from automation_definitions d
      join automation_trigger_configs c on c.automation_id=d.id and c.version=d.active_trigger_version
      where d.scope_kind='project' and d.scope_id=? and c.trigger_type in ('cron','manual')`, [projectID])
  };
}

function delegationSignals(db: RunnerDatabase, projectID: string, nowText: string) {
  return {
    active: countRows(db, `select count(*) as count from automation_definitions d
      join automation_trigger_configs c on c.automation_id=d.id and c.version=d.active_trigger_version
      where d.scope_kind='project' and d.scope_id=? and d.status='active' and c.trigger_type='continuous'`, [projectID]),
    due: countRows(db, `select count(*) as count from automation_definitions d
      join automation_trigger_configs c on c.automation_id=d.id and c.version=d.active_trigger_version
      where d.scope_kind='project' and d.scope_id=? and d.status='active' and c.trigger_type='continuous'
        and d.next_run_at is not null and d.next_run_at<=?`, [projectID, nowText])
  };
}

function memorySignals(db: RunnerDatabase, projectID: string) {
  return {
    active: countRows(db, "select count(*) as count from pi_memory_items where scope='project' and scope_id=? and disabled=0", [projectID]),
    pinned: countRows(db, "select count(*) as count from pi_memory_items where scope='project' and scope_id=? and disabled=0 and pinned=1", [projectID])
  };
}

function memoryItems(db: RunnerDatabase, projectID: string, scope: HeartbeatSignalScope) {
  return collectPiMemoryContextItems(db, { issueIDs: scope.issueIDs, limit: SIGNAL_LIMIT, projectID });
}

function conversationSignals(db: RunnerDatabase, projectID: string) {
  return {
    active: countRows(db, "select count(*) as count from pi_conversations where project_id=? and status='active'", [projectID]),
    total: countRows(db, "select count(*) as count from pi_conversations where project_id=?", [projectID])
  };
}

function providerHealth(db: RunnerDatabase, projectID: string) {
  const row = db.sqlite.query<{ provider: string }, [string]>("select provider from projects where id=?").get(projectID);
  return { provider: row?.provider ?? "", status: row?.provider ? "configured" : "missing" };
}

function usageCost() {
  return { status: "not_configured", total_tokens: 0 };
}

function countRows(db: RunnerDatabase, sql: string, params: string[]): number {
  return db.sqlite.query<{ count: number }, string[]>(sql).get(...params)?.count ?? 0;
}

function countStatuses(rows: Array<Record<string, unknown>>): Record<string, number> {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const status = text(row.status, "unknown");
    counts[status] = (counts[status] ?? 0) + 1;
    return counts;
  }, {});
}

function safeJson(value: unknown): unknown {
  const redacted = redactAuditJsonText(text(value) || "{}");
  try {
    return JSON.parse(redacted) as unknown;
  } catch {
    return "[redacted]";
  }
}

function safeText(value: unknown): string {
  const redacted = redactAuditJsonText(JSON.stringify(text(value)));
  const parsed = JSON.parse(redacted) as unknown;
  return typeof parsed === "string" ? parsed : "";
}

function snapshotPath(value: string): string {
  const parts = value.trim().split(/[\\/]+/).filter(Boolean);
  return parts.length === 0 ? "[redacted-path]" : `[redacted-path]/${safeText(parts.at(-1))}`;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
