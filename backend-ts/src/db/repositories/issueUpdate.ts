import type { RunnerDatabase } from "../database.ts";
import { getIssue, type Issue } from "./issues.ts";
import {
  cleanString,
  ensureIssueWorkShadow,
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
import {
  assertIssueDependencyDeclarationMatches,
  normalizeIssueDependencyDeclaration,
  parseIssueDependencyDeclaration
} from "../../domain/work/issueDependencyDeclaration.ts";

export type UpdateIssueInput = Partial<Record<keyof NormalizedIssuePatch, unknown>> & {
  depends_on_issue_ids?: unknown;
};

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
  const write = db.transaction(() => {
    const current = getIssue(db, id);
    if (!current) throw new ProjectNotFoundError();
    const patch = normalizeIssuePatch(input);
    const next = { ...issueToPatchShape(current), ...patch };
    validateIssuePatch(db, current, patch, next);
    const dependencyRequested = Object.hasOwn(input, "depends_on_issue_ids");
    const dependencyState = readIssueDependencyState(db, current.id);
    const dependencyIssueIDs = dependencyRequested
      ? normalizeIssueDependencyDeclaration(input.depends_on_issue_ids, next.description).issue_ids
      : dependencyState.issue_ids;
    if (Object.hasOwn(patch, "description") || dependencyRequested) {
      assertIssueDependencyDeclarationMatches(next.description, dependencyIssueIDs);
    }
    if (Object.hasOwn(patch, "description") && !dependencyRequested
      && parseIssueDependencyDeclaration(next.description).present
      && !sameIssueDependencies(dependencyState, dependencyIssueIDs)) {
      throw new Error("现有结构化依赖快照与硬依赖边不一致；请同时提供 depends_on_issue_ids 以原子修复");
    }
    const dependencyNeedsSync = dependencyRequested && !sameIssueDependencies(dependencyState, dependencyIssueIDs);
    const changedFields = PATCH_FIELDS.filter((field) => (
      Object.hasOwn(patch, field) && next[field] !== issueToPatchShape(current)[field]
    ));
    const planningFields = changedFields.filter((field) => field === "title" || field === "description");
    const planningRequested = Object.hasOwn(patch, "title")
      || Object.hasOwn(patch, "description")
      || dependencyRequested;
    if (planningFields.length > 0 || dependencyNeedsSync) {
      assertUnstartedPlanningUpdate(db, current);
    }
    if (dependencyRequested) validateIssueDependencies(db, current.id, next.project_id, dependencyIssueIDs);
    if (planningRequested && changedFields.length === 0 && !dependencyNeedsSync) return current;
    const timestamp = issueTimestamp();
    db.sqlite.run(`update issues set project_id=?, title=?, description=?, status=?, priority=?,
      required_skill_intents_json=?, recommended_skill_intents_json=?,
      required_mcp_capabilities_json=?, recommended_mcp_capabilities_json=?,
      agent_profile_id=?, service_tier=?, source_session_id=?, source_turn_id=?, source_excerpt=?,
      codex_thread_id=?, codex_turn_id=?, auto_retry_next_at=?, auto_retry_reason=?,
      error=?, issue_log_mode=?,
      dependency_issue_ids_json=case when ? then ? else dependency_issue_ids_json end,
      dependency_declaration_error=case when ? then '' else dependency_declaration_error end,
      updated_at=? where id=?`,
      [next.project_id, next.title, next.description, next.status, next.priority,
        next.required_skill_intents, next.recommended_skill_intents,
        next.required_mcp_capabilities, next.recommended_mcp_capabilities,
        next.agent_profile_id, next.service_tier, next.source_session_id, next.source_turn_id,
        next.source_excerpt, next.codex_thread_id, next.codex_turn_id,
        next.auto_retry_next_at, next.auto_retry_reason, next.error, next.issue_log_mode,
        dependencyNeedsSync ? 1 : 0, JSON.stringify(dependencyIssueIDs), dependencyNeedsSync ? 1 : 0,
        timestamp, current.id]);
    if (dependencyNeedsSync) syncIssueDependencies(db, next.project_id, current.id, dependencyIssueIDs, timestamp);
    if (Object.hasOwn(patch, "status")) {
      if (current.status !== next.status) {
        if (next.status !== "in_progress") closeOpenIssueRun(db, next, timestamp);
        db.sqlite.run(
          `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
          [current.id, "issue.status_changed", JSON.stringify({ status: next.status }), timestamp]
        );
      }
      syncPiRunGroupItems(db, next, timestamp);
    }
    const metadataFields = [
      ...planningFields,
      ...(dependencyNeedsSync ? ["depends_on_issue_ids"] : [])
    ];
    if (metadataFields.length > 0) {
      db.sqlite.run(
        `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
        [current.id, "issue.planning_metadata_updated.v1", JSON.stringify({
          contract: "unstarted-issue-planning-update-v1",
          fields: metadataFields,
          ...(dependencyNeedsSync ? { depends_on_issue_ids: dependencyIssueIDs } : {})
        }), timestamp]
      );
    }
    return mustGetIssue(db, current.id);
  });
  return write.immediate();
}

type IssueDependencyState = {
  declaration_error: string;
  issue_ids: number[];
  raw_json: string;
  relation_targets: string[];
};

function readIssueDependencyState(db: RunnerDatabase, issueID: number): IssueDependencyState {
  const row = db.sqlite.query<{
    dependency_declaration_error: string;
    dependency_issue_ids_json: string;
  }, [number]>(`
    select dependency_issue_ids_json, dependency_declaration_error from issues where id=?
  `).get(issueID);
  if (!row) throw new ProjectNotFoundError();
  const sourceWorkID = issueWorkID(issueID);
  const relationTargets = db.sqlite.query<{ target_work_id: string }, [string]>(`
    select target_work_id from work_relations
    where kind='depends_on' and source_work_id=? order by target_work_id
  `).all(sourceWorkID).map((relation) => relation.target_work_id);
  return {
    declaration_error: row.dependency_declaration_error,
    issue_ids: dependencyIDsFromJSON(row.dependency_issue_ids_json),
    raw_json: row.dependency_issue_ids_json,
    relation_targets: relationTargets
  };
}

function sameIssueDependencies(state: IssueDependencyState, issueIDs: number[]): boolean {
  const expectedTargets = issueIDs.map(issueWorkID).sort();
  return state.declaration_error === ""
    && state.raw_json === JSON.stringify(issueIDs)
    && JSON.stringify(state.relation_targets) === JSON.stringify(expectedTargets);
}

function assertUnstartedPlanningUpdate(db: RunnerDatabase, issue: Issue): void {
  if (issue.status !== "triage" && issue.status !== "todo") {
    throw new Error("title、description 和 depends_on_issue_ids 只能在未开始的 triage 或 todo Issue 上更新");
  }
  const runCount = db.sqlite.query<{ count: number }, [number]>(
    "select count(*) as count from issue_runs where issue_id=?"
  ).get(issue.id)?.count ?? 0;
  if (issue.attempt_count > 0 || runCount > 0) {
    throw new Error("Issue 已存在 Run 历史，禁止更新 title、description 或 depends_on_issue_ids");
  }
}

function validateIssueDependencies(
  db: RunnerDatabase,
  issueID: number,
  projectID: string,
  dependencyIssueIDs: number[]
): void {
  for (const dependencyID of dependencyIssueIDs) {
    if (dependencyID === issueID) throw new Error(`Issue #${issueID} 不能依赖自身`);
    const dependency = getIssue(db, dependencyID);
    if (!dependency) throw new Error(`依赖 Issue #${dependencyID} 不存在`);
    if (dependency.project_id !== projectID) {
      throw new Error(`依赖 Issue #${dependencyID} 不属于项目 ${projectID}`);
    }
  }
  const sourceWorkID = issueWorkID(issueID);
  const adjacency = projectDependencyAdjacency(db, projectID);
  adjacency.set(sourceWorkID, dependencyIssueIDs.map(issueWorkID));
  for (const dependencyID of dependencyIssueIDs) {
    if (canReach(adjacency, issueWorkID(dependencyID), sourceWorkID)) {
      throw new Error(`depends_on_issue_ids 会形成依赖环：Issue #${issueID} -> Issue #${dependencyID}`);
    }
  }
}

function projectDependencyAdjacency(db: RunnerDatabase, projectID: string): Map<string, string[]> {
  const adjacency = new Map<string, Set<string>>();
  const issues = db.sqlite.query<{ dependency_issue_ids_json: string; id: number }, [string]>(`
    select id, dependency_issue_ids_json from issues where project_id=?
  `).all(projectID);
  for (const issue of issues) {
    adjacency.set(issueWorkID(issue.id), new Set(dependencyIDsFromJSON(issue.dependency_issue_ids_json).map(issueWorkID)));
  }
  const relations = db.sqlite.query<{ source_work_id: string; target_work_id: string }, [string]>(`
    select source_work_id, target_work_id from work_relations
    where project_id=? and kind='depends_on'
  `).all(projectID);
  for (const relation of relations) {
    const targets = adjacency.get(relation.source_work_id) ?? new Set<string>();
    targets.add(relation.target_work_id);
    adjacency.set(relation.source_work_id, targets);
  }
  return new Map([...adjacency].map(([source, targets]) => [source, [...targets]]));
}

function canReach(adjacency: Map<string, string[]>, start: string, target: string): boolean {
  const pending = [start];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

function syncIssueDependencies(
  db: RunnerDatabase,
  projectID: string,
  issueID: number,
  dependencyIssueIDs: number[],
  timestamp: string
): void {
  ensureIssueWorkShadow(db, issueID);
  for (const dependencyID of dependencyIssueIDs) ensureIssueWorkShadow(db, dependencyID);
  db.sqlite.run("delete from work_relations where kind='depends_on' and source_work_id=?", [issueWorkID(issueID)]);
  for (const dependencyID of dependencyIssueIDs) {
    const relationID = `issue-dependency:${issueID}:${dependencyID}`;
    db.sqlite.run(`
      insert into work_relations (
        relation_id, project_id, kind, source_work_id, target_work_id, actor_json,
        reason, correlation_id, audit_event_ref, occurred_at, created_at, updated_at
      ) values (?, ?, 'depends_on', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      relationID,
      projectID,
      issueWorkID(issueID),
      issueWorkID(dependencyID),
      '{"id":"issue-update","kind":"runner"}',
      "Replace dependencies for an unstarted Issue",
      relationID,
      `issue-planning-update:${issueID}:${dependencyID}`,
      timestamp,
      timestamp,
      timestamp
    ]);
  }
}

function dependencyIDsFromJSON(value: string): number[] {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((item): item is number => (
      typeof item === "number" && Number.isSafeInteger(item) && item > 0
    )))].sort((left, right) => left - right);
  } catch {
    return [];
  }
}

function issueWorkID(issueID: number): string {
  return `xw:work:issues:${issueID}`;
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
  if (status === "done" || status === "needs_user") return "pi_semantic_decision";
  if (status === "failed" || status === "cancelled") return status;
  return "status_changed";
}

function isTerminalStatus(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled" || status === "needs_user";
}
