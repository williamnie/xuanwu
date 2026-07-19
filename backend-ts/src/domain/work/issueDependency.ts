import type { RunnerDatabase } from "../../db/database.ts";
import { issueIDToWorkID, workIDToIssueID } from "./issueAdapter.ts";
import { readIssueReadiness, readinessNotRequired, type ReadinessProjection } from "../readiness/contracts.ts";

export const ISSUE_DEPENDENCY_COMPATIBILITY = {
  readiness_authority: "append-only-structured-Evidence-request-time-projection",
  relation_authority: "work_relations(kind=depends_on)",
  status_authority: "issues",
  work_id_adapter: "xw:work:issues:<issue_id>"
} as const;

export type IssueDependencyReason =
  | "ready"
  | "waiting_dependency"
  | "failed_dependency"
  | "missing_dependency"
  | "dependency_cycle"
  | "waiting_readiness";

export type IssueDependencyRef = {
  issue_id: number | null;
  status: string;
  title: string;
  work_id: string;
};

export type IssueDependencyDiagnostic = {
  compatibility: typeof ISSUE_DEPENDENCY_COMPATIBILITY;
  cycle_work_ids: string[];
  direct_dependencies: IssueDependencyRef[];
  ready: boolean;
  readiness: ReadinessProjection;
  reason: IssueDependencyReason;
  root_blockers: IssueDependencyRef[];
  waiting_reason: string;
};

type IssueRow = { id: number; project_id: string; status: string; title: string };
type RelationRow = { source_work_id: string; target_work_id: string };
type DependencyGraph = {
  db: RunnerDatabase;
  issuesByWorkID: Map<string, IssueRow>;
  targetsBySource: Map<string, string[]>;
};

export function readIssueDependency(
  db: RunnerDatabase,
  issueID: number
): IssueDependencyDiagnostic | null {
  const issue = db.sqlite.query<IssueRow, [number]>(
    "select id, project_id, status, title from issues where id=?"
  ).get(issueID);
  if (!issue) return null;
  return readProjectIssueDependencies(db, issue.project_id).get(issueID) ?? null;
}

/**
 * Queue 和 API 共用的唯一 dependency read path：Issue 提供兼容状态，
 * work_relations(kind='depends_on') 提供硬依赖边。
 */
export function readProjectIssueDependencies(
  db: RunnerDatabase,
  projectID: string
): Map<number, IssueDependencyDiagnostic> {
  const cleanProjectID = projectID.trim();
  if (!cleanProjectID) return new Map();
  const issues = db.sqlite.query<IssueRow, [string]>(
    "select id, project_id, status, title from issues where project_id=? order by id"
  ).all(cleanProjectID);
  const graph = dependencyGraph(db, cleanProjectID, issues);
  return new Map(issues.map((issue) => [issue.id, evaluateIssueDependency(graph, issue)]));
}

function dependencyGraph(db: RunnerDatabase, projectID: string, issues: IssueRow[]): DependencyGraph {
  const issuesByWorkID = new Map(issues.map((issue) => [issueIDToWorkID(issue.id), issue]));
  const rows = db.sqlite.query<RelationRow, [string]>(`
    select source_work_id, target_work_id from work_relations
    where project_id=? and kind='depends_on'
    order by source_work_id, target_work_id
  `).all(projectID);
  const targetsBySource = new Map<string, string[]>();
  for (const row of rows) {
    const targets = targetsBySource.get(row.source_work_id) ?? [];
    if (!targets.includes(row.target_work_id)) targets.push(row.target_work_id);
    targetsBySource.set(row.source_work_id, targets);
  }
  return { db, issuesByWorkID, targetsBySource };
}

function evaluateIssueDependency(graph: DependencyGraph, issue: IssueRow): IssueDependencyDiagnostic {
  const workID = issueIDToWorkID(issue.id);
  const directWorkIDs = graph.targetsBySource.get(workID) ?? [];
  const directDependencies = directWorkIDs.map((id) => dependencyRef(graph, id));
  const cycleWorkIDs = findReachableCycle(graph, workID);
  const rootBlockers = cycleWorkIDs.length > 0
    ? uniqueRefs(cycleWorkIDs.map((id) => dependencyRef(graph, id)))
    : uniqueRefs(directWorkIDs.flatMap((id) => collectRootBlockers(graph, id, new Set([workID]))));
  const dependencyStatus = dependencyReason(directDependencies, rootBlockers, cycleWorkIDs);
  const readiness = directWorkIDs.length === 0
    ? readinessNotRequired(workID)
    : readIssueReadiness(graph.db, issue.id);
  if (!readiness) throw new Error(`missing readiness projection for Issue ${issue.id}`);
  const reason = dependencyStatus === "ready" && !readiness.ready ? "waiting_readiness" : dependencyStatus;
  return {
    compatibility: ISSUE_DEPENDENCY_COMPATIBILITY,
    cycle_work_ids: cycleWorkIDs,
    direct_dependencies: directDependencies,
    ready: reason === "ready",
    readiness,
    reason,
    root_blockers: rootBlockers,
    waiting_reason: reason === "waiting_readiness"
      ? readiness.next_step
      : waitingReason(reason, directDependencies, rootBlockers, cycleWorkIDs)
  };
}

function collectRootBlockers(graph: DependencyGraph, workID: string, path: Set<string>): IssueDependencyRef[] {
  const ref = dependencyRef(graph, workID);
  if (ref.status === "missing" || ref.status === "failed") return [ref];
  if (ref.status === "done") return [];
  if (path.has(workID)) return [ref];
  const targets = graph.targetsBySource.get(workID) ?? [];
  if (targets.length === 0) return [ref];
  const nextPath = new Set(path).add(workID);
  const nested = targets.flatMap((target) => collectRootBlockers(graph, target, nextPath));
  return nested.length > 0 ? nested : [ref];
}

function findReachableCycle(graph: DependencyGraph, startWorkID: string): string[] {
  const visited = new Set<string>();
  const active: string[] = [];
  const activeIndexes = new Map<string, number>();
  const visit = (workID: string): string[] => {
    const activeIndex = activeIndexes.get(workID);
    if (activeIndex !== undefined) return [...active.slice(activeIndex), workID];
    if (visited.has(workID)) return [];
    visited.add(workID);
    activeIndexes.set(workID, active.length);
    active.push(workID);
    for (const target of graph.targetsBySource.get(workID) ?? []) {
      const cycle = visit(target);
      if (cycle.length > 0) return cycle;
    }
    active.pop();
    activeIndexes.delete(workID);
    return [];
  };
  return visit(startWorkID);
}

function dependencyReason(
  direct: IssueDependencyRef[],
  roots: IssueDependencyRef[],
  cycle: string[]
): IssueDependencyReason {
  if (cycle.length > 0) return "dependency_cycle";
  if ([...direct, ...roots].some((ref) => ref.status === "missing")) return "missing_dependency";
  if ([...direct, ...roots].some((ref) => ref.status === "failed")) return "failed_dependency";
  if (direct.some((ref) => ref.status !== "done")) return "waiting_dependency";
  return "ready";
}

function dependencyRef(graph: DependencyGraph, workID: string): IssueDependencyRef {
  const issue = graph.issuesByWorkID.get(workID);
  if (issue) return { issue_id: issue.id, status: issue.status, title: issue.title, work_id: workID };
  return { issue_id: canonicalIssueID(workID), status: "missing", title: "", work_id: workID };
}

function canonicalIssueID(workID: string): number | null {
  try {
    return workIDToIssueID(workID);
  } catch {
    return null;
  }
}

function uniqueRefs(refs: IssueDependencyRef[]): IssueDependencyRef[] {
  return [...new Map(refs.map((ref) => [ref.work_id, ref])).values()]
    .sort((left, right) => left.work_id.localeCompare(right.work_id));
}

function waitingReason(
  reason: IssueDependencyReason,
  direct: IssueDependencyRef[],
  roots: IssueDependencyRef[],
  cycle: string[]
): string {
  if (reason === "ready") return direct.length === 0 ? "No hard dependencies." : "All hard dependencies are done.";
  if (reason === "waiting_readiness") return "Waiting for declared delivery readiness Evidence.";
  if (reason === "dependency_cycle") return `Dependency cycle detected: ${cycle.map(refLabelFromWorkID).join(" -> ")}.`;
  const labels = (roots.length > 0 ? roots : direct).map(refLabel).join(", ");
  if (reason === "missing_dependency") return `Missing dependency reference: ${labels}.`;
  if (reason === "failed_dependency") return `Blocked by failed dependency: ${labels}.`;
  return `Waiting for dependency: ${labels}.`;
}

function refLabel(ref: IssueDependencyRef): string {
  return ref.issue_id ? `#${ref.issue_id} (${ref.status})` : `${ref.work_id} (${ref.status})`;
}

function refLabelFromWorkID(workID: string): string {
  const issueID = canonicalIssueID(workID);
  return issueID ? `#${issueID}` : workID;
}
