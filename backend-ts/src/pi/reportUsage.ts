import type { RunnerDatabase } from "../db/database.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { listProjects } from "../db/repositories/projects.ts";
import { readCodexUsage } from "../usage/codex.ts";
import type { UsageIssueRef, UsageProjectRef } from "../usage/types.ts";
import { redactSensitiveText } from "../util/redact.ts";

type UsageCostInput = { codexSessionsDir?: string; database: RunnerDatabase; projectID: string };

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export async function buildUsageCostSummary(input: UsageCostInput): Promise<Record<string, unknown>> {
  try {
    const root = clean(input.codexSessionsDir);
    if (root === "") throw new Error("codex sessions dir 未配置");
    const report = await readCodexUsage({ root, options: usageOptions(input.database) });
    const project = projectUsage(report, input.projectID);
    return {
      events_scanned: numberValue(report.events_scanned),
      project_usage: project,
      rate_limits: report.rate_limits ?? null,
      source: "/api/usage/codex",
      status: "available",
      summary: summarizedUsage(report, project, input.projectID),
      total_tokens: input.projectID === "" ? totalTokens(report) : totalTokens(project)
    };
  } catch (error) {
    return { error: safeText(error instanceof Error ? error.message : String(error)), status: "not_configured", total_tokens: 0 };
  }
}

function usageOptions(db: RunnerDatabase): { issues: UsageIssueRef[]; projects: UsageProjectRef[] } {
  return { issues: usageIssues(db), projects: usageProjects(db) };
}

function usageProjects(db: RunnerDatabase): UsageProjectRef[] {
  return listProjects(db).map((project) => ({ cwd: project.cwd, id: project.id, name: project.name }));
}

function usageIssues(db: RunnerDatabase): UsageIssueRef[] {
  return listIssues(db).flatMap((issue) => {
    const sessionID = issue.codex_thread_id || issue.latest_run?.provider_session_id || issue.latest_run?.codex_thread_id || "";
    return sessionID ? [{ id: issue.id, project_id: issue.project_id, session_id: sessionID, status: issue.status, title: issue.title }] : [];
  });
}

function projectUsage(report: Record<string, unknown>, projectID: string): Record<string, unknown> | undefined {
  const projects = Array.isArray(report.project_usage) ? report.project_usage as Array<Record<string, unknown>> : [];
  return projects.find((item) => item.id === projectID);
}

function summarizedUsage(
  report: Record<string, unknown>,
  project: Record<string, unknown> | undefined,
  projectID: string
): Record<string, unknown> {
  return projectID === "" ? objectValue(report.summary) : { all_time: objectValue(project?.usage) };
}

function totalTokens(value: Record<string, unknown> | undefined): number {
  const usage = (value?.usage ?? value?.summary) as Record<string, unknown> | undefined;
  const allTime = usage?.all_time as Record<string, unknown> | undefined;
  return numberValue(usage?.total_tokens) || numberValue(allTime?.total_tokens);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
