import type { RunnerDatabase } from "../database.ts";
import { getIssue, type Issue } from "./issues.ts";
import { ensureIssueWorkShadow } from "./issueCreate.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { syncPiRunGroupsForIssueStatus } from "./pi/runGroups.ts";
import { type NormalizedIssuePatch } from "./issueUpdatePatch.ts";

type IssueDependencyState = {
  declaration_error: string;
  issue_ids: number[];
  raw_json: string;
  relation_targets: string[];
};

export function readIssueDependencyState(db: RunnerDatabase, issueID: number): IssueDependencyState {
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

export function sameIssueDependencies(state: IssueDependencyState, issueIDs: number[]): boolean {
  const expectedTargets = issueIDs.map(issueWorkID).sort();
  return state.declaration_error === ""
    && state.raw_json === JSON.stringify(issueIDs)
    && JSON.stringify(state.relation_targets) === JSON.stringify(expectedTargets);
}

export function assertUnstartedPlanningUpdate(db: RunnerDatabase, issue: Issue): void {
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

export function validateIssueDependencies(
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

export function syncIssueDependencies(
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

export function syncPiRunGroupItems(db: RunnerDatabase, issue: NormalizedIssuePatch, timestamp: string): void {
  syncPiRunGroupsForIssueStatus(db, {
    completedAt: timestamp,
    issueID: issue.id,
    reason: issue.error,
    status: issue.status
  });
}
