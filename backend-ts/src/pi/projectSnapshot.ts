import type { RunnerDatabase } from "../db/database.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";

export type ProjectStatusSnapshot = {
  cwd: string;
  id: string;
  issue_status_counts: Record<string, number>;
  latest_issues: Array<{ id: number; status: string; title: string; updated_at: string }>;
  name: string;
  provider: string;
  total_issues: number;
};

const PROJECT_STATUS_LIMIT = 8;

export function createProjectStatusSnapshot(db: RunnerDatabase, projectID: string): ProjectStatusSnapshot {
  const project = requireProject(db, projectID);
  const issues = listIssues(db, { projectId: project.id });
  return {
    cwd: project.cwd,
    id: project.id,
    issue_status_counts: countIssueStatuses(issues),
    latest_issues: latestIssues(issues),
    name: project.name,
    provider: project.provider,
    total_issues: issues.length
  };
}

function requireProject(db: RunnerDatabase, id: string): Project {
  const project = getProject(db, id);
  if (!project) throw new Error("project not found");
  return project;
}

function countIssueStatuses(issues: ReturnType<typeof listIssues>): Record<string, number> {
  return issues.reduce<Record<string, number>>((counts, issue) => {
    counts[issue.status] = (counts[issue.status] ?? 0) + 1;
    return counts;
  }, {});
}

function latestIssues(issues: ReturnType<typeof listIssues>): ProjectStatusSnapshot["latest_issues"] {
  return [...issues]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id - left.id)
    .slice(0, PROJECT_STATUS_LIMIT)
    .map((issue) => ({
      id: issue.id,
      status: issue.status,
      title: issue.title,
      updated_at: issue.updated_at
    }));
}
