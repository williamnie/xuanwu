import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";

export const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;
export const PI_PROJECT_STATUS_TOOL = "project.status";
export const PI_ALLOWED_TOOLS = [...PI_READ_ONLY_TOOLS, PI_PROJECT_STATUS_TOOL] as const;

type ProjectStatusSnapshot = {
  cwd: string;
  id: string;
  issue_status_counts: Record<string, number>;
  latest_issues: Array<{ id: number; status: string; title: string; updated_at: string }>;
  name: string;
  provider: string;
  total_issues: number;
};

const PROJECT_STATUS_LIMIT = 8;

export function createPiProjectTools(db: RunnerDatabase, project: Project): ToolDefinition[] {
  return [createProjectStatusTool(db, project)];
}

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

function createProjectStatusTool(db: RunnerDatabase, project: Project): ToolDefinition {
  return {
    name: PI_PROJECT_STATUS_TOOL,
    label: "Project Status",
    description: "Read a safe project status snapshot for the current runner project.",
    parameters: Type.Object({}),
    async execute() {
      const snapshot = createProjectStatusSnapshot(db, project.id);
      return {
        content: [{ type: "text", text: JSON.stringify(snapshot, null, 2) }],
        details: snapshot
      };
    }
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
