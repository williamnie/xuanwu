import type { RunnerDatabase } from "../database.ts";
import { getIssue, type Issue } from "./issues.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { normalizeMcpCapabilityList } from "../../mcp/policy.ts";
import { normalizeSkillIntentList } from "../../skills/intents.ts";
import { normalizeIssueDependencyDeclaration } from "../../domain/work/issueDependencyDeclaration.ts";

export type CreateIssueInput = Partial<Record<keyof NormalizedIssueWrite, unknown>> & {
  depends_on_issue_ids?: unknown;
};

export type CreateIssueOptions = {
  createdEventPayload?: Record<string, unknown>;
};

type NormalizedIssueWrite = {
  agent_profile_id: string;
  description: string;
  dependency_declaration_error: string;
  dependency_issue_ids: number[];
  issue_log_mode: "debug" | "normal";
  priority: number;
  project_id: string;
  recommended_mcp_capabilities: string;
  recommended_skill_intents: string;
  required_mcp_capabilities: string;
  required_skill_intents: string;
  service_tier: string;
  source_excerpt: string;
  source_session_id: string;
  source_turn_id: string;
  status: string;
  title: string;
  workflow_snapshot_json: string;
};

export const ISSUE_TITLE_MAX_RUNES = 50;
export const VALID_ISSUE_STATUSES = new Set([
  "triage",
  "todo",
  "in_progress",
  "needs_user",
  "done",
  "failed",
  "cancelled"
]);
export function createIssue(
  db: RunnerDatabase,
  input: CreateIssueInput,
  options: CreateIssueOptions = {}
): Issue {
  const issue = normalizeIssueForWrite(input);
  validateIssueForCreate(db, issue);
  const timestamp = issueTimestamp();
  const insertIssue = db.transaction((record: NormalizedIssueWrite) => {
    db.sqlite.run(`insert into issues
      (project_id, title, description, dependency_issue_ids_json, dependency_declaration_error,
       status, priority, required_skill_intents_json, recommended_skill_intents_json,
       required_mcp_capabilities_json, recommended_mcp_capabilities_json, agent_profile_id,
       service_tier, source_session_id, source_turn_id, source_excerpt, workflow_snapshot_json,
       issue_log_mode, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.project_id, record.title, record.description, JSON.stringify(record.dependency_issue_ids),
        record.dependency_declaration_error, record.status, record.priority,
        record.required_skill_intents, record.recommended_skill_intents, record.required_mcp_capabilities,
        record.recommended_mcp_capabilities, record.agent_profile_id, record.service_tier, record.source_session_id,
        record.source_turn_id, record.source_excerpt, record.workflow_snapshot_json,
        record.issue_log_mode, timestamp, timestamp]);
    const id = lastInsertID(db);
    if (record.dependency_issue_ids.length > 0) {
      ensureIssueWorkShadow(db, id);
      for (const dependencyID of record.dependency_issue_ids) {
        ensureIssueWorkShadow(db, dependencyID);
        insertIssueDependency(db, record.project_id, id, dependencyID, timestamp);
      }
    }
    db.sqlite.run(
      `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
      [id, "issue.created", createdEventPayload(options, record.dependency_issue_ids), timestamp]
    );
    return id;
  });
  return mustGetIssue(db, insertIssue(issue));
}

function createdEventPayload(options: CreateIssueOptions, dependencyIssueIDs: number[]): string {
  if (options.createdEventPayload === undefined && dependencyIssueIDs.length === 0) return "";
  return JSON.stringify({
    ...(options.createdEventPayload ?? {}),
    ...(dependencyIssueIDs.length > 0 ? { depends_on_issue_ids: dependencyIssueIDs } : {})
  });
}

function validateIssueForCreate(db: RunnerDatabase, issue: NormalizedIssueWrite): void {
  if (!projectExists(db, issue.project_id)) throw new ProjectNotFoundError();
  if (!VALID_ISSUE_STATUSES.has(issue.status)) throw new Error("status 不合法");
  if (issue.title === "") throw new Error("issue 内容不能为空");
  if (issue.dependency_declaration_error !== "") throw new Error(issue.dependency_declaration_error);
  for (const dependencyID of issue.dependency_issue_ids) {
    const dependency = getIssue(db, dependencyID);
    if (!dependency) throw new Error(`依赖 Issue #${dependencyID} 不存在`);
    if (dependency.project_id !== issue.project_id) {
      throw new Error(`依赖 Issue #${dependencyID} 不属于项目 ${issue.project_id}`);
    }
  }
}

function projectExists(db: RunnerDatabase, id: string): boolean {
  const row = db.sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from projects where id = ?"
  ).get(id);
  return (row?.count ?? 0) > 0;
}

function normalizeIssueForWrite(input: CreateIssueInput): NormalizedIssueWrite {
  const description = cleanString(input.description);
  const title = cleanString(input.title) || deriveIssueTitle(description);
  const dependency = normalizeIssueDependencyDeclaration(input.depends_on_issue_ids, description);
  return {
    project_id: cleanString(input.project_id),
    title,
    description,
    dependency_declaration_error: dependency.error,
    dependency_issue_ids: dependency.issue_ids,
    status: cleanString(input.status) || "triage",
    priority: integerInput(input.priority),
    required_skill_intents: normalizeSkillIntentList(input.required_skill_intents),
    recommended_skill_intents: normalizeSkillIntentList(input.recommended_skill_intents),
    required_mcp_capabilities: normalizeMcpCapabilityList(input.required_mcp_capabilities),
    recommended_mcp_capabilities: normalizeMcpCapabilityList(input.recommended_mcp_capabilities),
    service_tier: cleanString(input.service_tier),
    agent_profile_id: normalizeIdentifier(input.agent_profile_id),
    source_session_id: normalizeSourceSessionID(input.source_session_id),
    source_turn_id: cleanString(input.source_turn_id),
    source_excerpt: cleanString(input.source_excerpt),
    workflow_snapshot_json: cleanString(input.workflow_snapshot_json),
    issue_log_mode: normalizeIssueLogMode(input.issue_log_mode)
  };
}

function ensureIssueWorkShadow(db: RunnerDatabase, issueID: number): void {
  db.sqlite.run(`
    insert or ignore into works (
      id, project_id, type, title, goal, status, acceptance_json, provenance_json,
      workflow_ref, revision, created_at, updated_at
    )
    select
      'xw:work:issues:' || id,
      project_id,
      'engineering_task',
      title,
      case when trim(description)<>'' then description else title end,
      status,
      '{"criteria":[{"description":"Satisfy the authoritative Issue goal; PI judges the actual Provider Session and workspace facts.","id":"issue-delivery","required":true}],"version":1}',
      json_object(
        'causes', json_array(),
        'origin', json_object(
          'authority', 'issues',
          'completeness', 'legacy_incomplete',
          'external_id', cast(id as text),
          'kind', 'issue',
          'missing_fields', json_array('actor','correlation_id'),
          'occurred_at', created_at
        )
      ),
      'issues:' || id || ':workflow:compatibility',
      0,
      created_at,
      updated_at
    from issues where id=?
  `, [issueID]);
}

function insertIssueDependency(
  db: RunnerDatabase,
  projectID: string,
  issueID: number,
  dependencyID: number,
  timestamp: string
): void {
  const relationID = `issue-dependency:${issueID}:${dependencyID}`;
  db.sqlite.run(`
    insert into work_relations (
      relation_id, project_id, kind, source_work_id, target_work_id, actor_json,
      reason, correlation_id, audit_event_ref, occurred_at, created_at, updated_at
    ) values (?, ?, 'depends_on', ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    relationID,
    projectID,
    `xw:work:issues:${issueID}`,
    `xw:work:issues:${dependencyID}`,
    '{"id":"issue-create","kind":"runner"}',
    "Materialize dependency declared during Issue creation",
    relationID,
    `issue-created:${issueID}:${dependencyID}`,
    timestamp,
    timestamp,
    timestamp
  ]);
}

function normalizeIssueLogMode(value: unknown): "debug" | "normal" {
  const mode = cleanString(value);
  if (mode === "" || mode === "normal") return "normal";
  if (mode === "debug") return "debug";
  throw new Error("issue_log_mode 只支持 normal 或 debug");
}

function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new Error("created issue missing");
  return issue;
}

function lastInsertID(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (typeof row?.id !== "number" || !Number.isInteger(row.id) || row.id <= 0) {
    throw new Error("inserted issue id must be positive");
  }
  return row.id;
}

export function normalizeSourceSessionID(value: unknown): string {
  const text = cleanString(value);
  if (!text) return "";
  const separator = text.indexOf(":");
  if (separator < 0) return text;
  const provider = text.slice(0, separator).trim().toLowerCase();
  const sessionID = text.slice(separator + 1).trim();
  return provider === "codex" ? sessionID : text;
}

export function normalizeIdentifier(value: unknown): string {
  let out = "";
  let lastDash = false;
  for (const char of cleanString(value).toLowerCase()) {
    if (/^[a-z0-9_-]$/.test(char)) {
      out += char;
      lastDash = char === "-";
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

export function deriveIssueTitle(content: string): string {
  const line = content.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  return truncateRunes(line, ISSUE_TITLE_MAX_RUNES);
}

function truncateRunes(value: string, maxRunes: number): string {
  const runes = [...value];
  return runes.length <= maxRunes ? value : `${runes.slice(0, maxRunes - 1).join("")}…`;
}

export function integerInput(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function issueTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
