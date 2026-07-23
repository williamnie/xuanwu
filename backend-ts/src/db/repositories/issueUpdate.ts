import type { RunnerDatabase } from "../database.ts";
import { getIssue, type Issue } from "./issues.ts";
import {
  cleanString,
  deriveIssueTitle,
  integerInput,
  issueTimestamp,
  normalizeIdentifier,
  normalizeSourceSessionID,
  VALID_ISSUE_STATUSES
} from "./issueCreate.ts";
import { normalizeMcpCapabilityList } from "../../mcp/policy.ts";
import { normalizeSkillIntentList } from "../../skills/intents.ts";
import { getProject, ProjectNotFoundError } from "./projects.ts";
import { syncPiRunGroupsForIssueStatus } from "./pi/runGroups.ts";

export type UpdateIssueInput = Partial<Record<keyof NormalizedIssuePatch, unknown>>;

type NormalizedIssuePatch = {
  id: number;
  agent_profile_id: string;
  auto_retry_next_at: string;
  auto_retry_reason: string;
  codex_thread_id: string;
  codex_turn_id: string;
  description: string;
  error: string;
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
};

const PATCH_FIELDS = [
  "project_id",
  "title",
  "description",
  "status",
  "priority",
  "required_skill_intents",
  "recommended_skill_intents",
  "required_mcp_capabilities",
  "recommended_mcp_capabilities",
  "service_tier",
  "error",
  "issue_log_mode",
  "source_session_id",
  "source_turn_id",
  "source_excerpt",
  "agent_profile_id",
  "codex_thread_id",
  "codex_turn_id",
  "auto_retry_next_at",
  "auto_retry_reason"
] as const satisfies ReadonlyArray<keyof NormalizedIssuePatch>;

export function updateIssue(db: RunnerDatabase, id: number, input: UpdateIssueInput): Issue {
  const current = getIssue(db, id);
  if (!current) throw new ProjectNotFoundError();
  const patch = normalizeIssuePatch(input);
  const next = { ...issueToPatchShape(current), ...patch };
  if (Object.hasOwn(patch, "description") && !Object.hasOwn(patch, "title")) {
    next.title = deriveIssueTitle(next.description);
  }
  validateIssuePatch(db, current, patch, next);
  const timestamp = issueTimestamp();
  const write = db.transaction((record: NormalizedIssuePatch) => {
    db.sqlite.run(`update issues set project_id=?, title=?, description=?, status=?, priority=?,
      required_skill_intents_json=?, recommended_skill_intents_json=?,
      required_mcp_capabilities_json=?, recommended_mcp_capabilities_json=?,
      agent_profile_id=?, service_tier=?, source_session_id=?, source_turn_id=?, source_excerpt=?,
      codex_thread_id=?, codex_turn_id=?, auto_retry_next_at=?, auto_retry_reason=?,
      error=?, issue_log_mode=?, updated_at=? where id=?`,
      [record.project_id, record.title, record.description, record.status, record.priority,
        record.required_skill_intents, record.recommended_skill_intents,
        record.required_mcp_capabilities, record.recommended_mcp_capabilities,
        record.agent_profile_id, record.service_tier, record.source_session_id, record.source_turn_id,
        record.source_excerpt, record.codex_thread_id, record.codex_turn_id,
        record.auto_retry_next_at, record.auto_retry_reason, record.error, record.issue_log_mode,
        timestamp, current.id]);
    if (Object.hasOwn(patch, "status")) {
      closeOpenIssueRun(db, record, timestamp);
      if (current.status !== record.status) {
        db.sqlite.run(
          `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
          [current.id, "issue.status_changed", JSON.stringify({ status: record.status }), timestamp]
        );
      }
      syncPiRunGroupItems(db, record, timestamp);
    }
  });
  write(next);
  return mustGetIssue(db, current.id);
}

function syncPiRunGroupItems(db: RunnerDatabase, issue: NormalizedIssuePatch, timestamp: string): void {
  syncPiRunGroupsForIssueStatus(db, {
    completedAt: timestamp,
    issueID: issue.id,
    reason: issue.error,
    status: issue.status
  });
}

function normalizeIssuePatch(input: UpdateIssueInput): Partial<NormalizedIssuePatch> {
  const patch: Partial<NormalizedIssuePatch> = {};
  for (const field of PATCH_FIELDS) {
    if (!hasPatchValue(input, field)) continue;
    patch[field] = normalizePatchField(field, input[field]) as never;
  }
  return patch;
}

function normalizePatchField(field: keyof NormalizedIssuePatch, value: unknown): string | number {
  switch (field) {
    case "agent_profile_id":
      return normalizeIdentifier(value);
    case "priority":
      return integerInput(value);
    case "required_skill_intents":
    case "recommended_skill_intents":
      return normalizeSkillIntentList(value);
    case "required_mcp_capabilities":
    case "recommended_mcp_capabilities":
      return normalizeMcpCapabilityList(value);
    case "source_session_id":
      return normalizeSourceSessionID(value);
    case "issue_log_mode":
      return normalizeIssueLogMode(value);
    default:
      return cleanString(value);
  }
}

function validateIssuePatch(
  db: RunnerDatabase,
  current: Issue,
  patch: Partial<NormalizedIssuePatch>,
  issue: NormalizedIssuePatch
): void {
  if (Object.hasOwn(patch, "project_id")) {
    if (current.status !== "triage") throw new Error("只有 Triage 状态的 Issue 可以更换所属项目");
    if (issue.project_id === "" || !getProject(db, issue.project_id)) throw new ProjectNotFoundError();
    if (issue.project_id !== current.project_id && issueHasStructuralRelations(db, current.id)) {
      throw new Error("存在结构化依赖关系的 Issue 不能更换所属项目");
    }
  }
  if (Object.hasOwn(patch, "status") && current.status === "in_progress" && issue.status === "todo") {
    throw new Error("运行中的 Issue 请使用 retry 操作，避免重复创建 Session");
  }
  if (!VALID_ISSUE_STATUSES.has(issue.status)) throw new Error("status 不合法");
  if (issue.issue_log_mode !== "normal" && issue.issue_log_mode !== "debug") {
    throw new Error("issue_log_mode 只支持 normal 或 debug");
  }
  if (issue.title === "") throw new Error("issue 内容不能为空");
}

function issueHasStructuralRelations(db: RunnerDatabase, issueID: number): boolean {
  const workID = `xw:work:issues:${issueID}`;
  const row = db.sqlite.query<{ count: number }, [string, string]>(`
    select count(*) as count from work_relations
    where source_work_id=? or target_work_id=?
  `).get(workID, workID);
  return (row?.count ?? 0) > 0;
}

function issueToPatchShape(issue: Issue): NormalizedIssuePatch {
  return {
    id: issue.id,
    project_id: issue.project_id,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    priority: issue.priority,
    required_skill_intents: issue.required_skill_intents,
    recommended_skill_intents: issue.recommended_skill_intents,
    required_mcp_capabilities: issue.required_mcp_capabilities,
    recommended_mcp_capabilities: issue.recommended_mcp_capabilities,
    service_tier: issue.service_tier,
    error: issue.error,
    issue_log_mode: issue.issue_log_mode,
    source_session_id: issue.source_session_id,
    source_turn_id: issue.source_turn_id,
    source_excerpt: issue.source_excerpt,
    agent_profile_id: issue.agent_profile_id,
    codex_thread_id: issue.codex_thread_id,
    codex_turn_id: issue.codex_turn_id,
    auto_retry_next_at: issue.auto_retry_next_at,
    auto_retry_reason: issue.auto_retry_reason
  };
}

function normalizeIssueLogMode(value: unknown): "debug" | "normal" {
  const mode = cleanString(value);
  if (mode === "normal" || mode === "debug") return mode;
  throw new Error("issue_log_mode 只支持 normal 或 debug");
}

function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new Error("updated issue missing");
  return issue;
}

function hasPatchValue(input: UpdateIssueInput, key: keyof NormalizedIssuePatch): boolean {
  return Object.hasOwn(input, key) && input[key] !== null && input[key] !== undefined;
}

function closeOpenIssueRun(db: RunnerDatabase, issue: NormalizedIssuePatch & { id?: number }, timestamp: string): void {
  const issueID = typeof issue.id === "number" ? issue.id : undefined;
  if (!issueID) return;
  db.sqlite.run(`update issue_runs set status=?,
    provider_session_id=case when provider_session_id='' then ? else provider_session_id end,
    provider_turn_id=case when provider_turn_id='' then ? else provider_turn_id end,
    codex_thread_id=?, codex_turn_id=?, ended_at=?, exit_reason=?, error=?
    where id=(select id from issue_runs where issue_id=? and ended_at='' order by attempt desc limit 1)`,
    [issue.status, issue.codex_thread_id, issue.codex_turn_id, issue.codex_thread_id,
      issue.codex_turn_id, timestamp, patchStatusExitReason(issue.status), issue.error, issueID]);
}

function patchStatusExitReason(status: string): string {
  if (status === "done" || status === "pending_verification") return "explicit_status_update";
  if (status === "failed" || status === "cancelled") return status;
  return "status_changed";
}

function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "pending_verification";
}
