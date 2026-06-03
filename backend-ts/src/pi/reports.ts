import type { RunnerDatabase } from "../db/database.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import { getNotificationSettings } from "../db/repositories/notificationSettings.ts";
import { createPiReportRecord, listPiActionEvents, listPiDelegations, listPiHeartbeatRuns } from "../db/repositories/pi.ts";
import { getProject, listProjects, type Project } from "../db/repositories/projects.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import { readCodexUsage } from "../usage/codex.ts";
import type { UsageIssueRef, UsageProjectRef } from "../usage/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { diagnoseIssueState, type IssueStateDiagnostic } from "./issueStateManager.ts";

export type PiReportInput = {
  bus?: EventBus; codexSessionsDir?: string; database: RunnerDatabase;
  now?: Date; projectID?: string; since?: string; type?: string; until?: string;
};
export type PiReport = Record<string, unknown> & {
  project_id: string; summary: Record<string, number>; type: string; usage_cost: Record<string, unknown>;
};

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export async function buildPiReport(input: PiReportInput): Promise<PiReport> {
  const now = input.now ?? new Date();
  const project = projectScope(input.database, clean(input.projectID));
  const window = reportWindow(input, now);
  const issues = reportIssues(input.database, project?.id ?? "", window);
  const diagnostics = diagnoseIssueState(input.database, {
    now, projectID: project?.id ?? "", issueIDs: issues.map((issue) => issue.id)
  }).diagnostics;
  const usage = await usageSummary(input, project?.id ?? "");
  const report = persistReport(input.database, assembleReport(input.database, {
    diagnostics, issues, now, project, type: clean(input.type) || "manual", usage, window
  }));
  publishReport(input.bus, report);
  return report;
}

function persistReport(db: RunnerDatabase, report: PiReport): PiReport {
  const record = createPiReportRecord(db, {
    body_json: JSON.stringify(report),
    generated_at: String(report.generated_at),
    project_id: report.project_id,
    summary_json: JSON.stringify(report.summary),
    type: report.type
  });
  return { ...report, report_id: record.id };
}

function assembleReport(db: RunnerDatabase, input: {
  diagnostics: IssueStateDiagnostic[]; issues: Issue[]; now: Date; project: Project | null;
  type: string; usage: Record<string, unknown>; window: { since: string; until: string };
}): PiReport {
  const gaps = verificationGaps(input.diagnostics);
  const gapIDs = new Set(gaps.map((item) => item.issue_id));
  const completed = input.issues.filter((issue) => issue.status === "done" && !gapIDs.has(issue.id));
  const failed = input.issues.filter((issue) => issue.status === "failed");
  const escalations = blockedEscalations(input.diagnostics);
  return {
    blocked_escalations: escalations,
    completed_issues: completed.map(issueSummary),
    evidence: relatedEvidence(db, input.project?.id ?? "", input.window),
    failed_retry_summary: { count: failed.length, failed_issues: failed.map(issueSummary) },
    generated_at: input.now.toISOString(),
    notification: notificationPlan(db, input.project?.id ?? ""),
    project_id: input.project?.id ?? "",
    project_name: safeText(input.project?.name ?? "All projects"),
    provider_health: providerHealth(input.project),
    summary: {
      completed: completed.length,
      failed: failed.length,
      needs_user: escalations.length,
      total: input.issues.length,
      verification_gaps: gaps.length
    },
    type: input.type,
    usage_cost: input.usage,
    verification_gaps: gaps,
    window: input.window
  };
}

function reportIssues(db: RunnerDatabase, projectID: string, window: { since: string; until: string }): Issue[] {
  return listIssues(db, { projectId: projectID }).filter((issue) => inWindow(issue.updated_at, window));
}

function issueSummary(issue: Issue): Record<string, unknown> {
  const sessionID = issue.codex_thread_id || issue.latest_run?.provider_session_id || issue.latest_run?.codex_thread_id || "";
  return {
    evidence_links: evidenceLinks(issue, sessionID),
    error: safeText(issue.error),
    id: issue.id,
    status: issue.status,
    title: safeText(issue.title),
    updated_at: issue.updated_at
  };
}

function evidenceLinks(issue: Issue, sessionID: string): Record<string, string> {
  return {
    audit: `/api/pi/audit-events?project_id=${encodeURIComponent(issue.project_id)}&issue_id=${issue.id}`,
    issue: `/api/issues/${issue.id}`,
    runs: `/api/issues/${issue.id}/runs`,
    ...(sessionID ? { session: `/api/sessions/codex:${encodeURIComponent(sessionID)}` } : {})
  };
}

function verificationGaps(diagnostics: IssueStateDiagnostic[]): Array<Record<string, unknown>> {
  return diagnostics.filter((item) => item.code.includes("verification") || item.code.includes("missing_verification"))
    .map((item) => ({
      code: item.code,
      evidence_refs: item.evidence.map((evidence) => evidence.ref),
      issue_id: item.issue_id,
      status: item.status,
      title: safeText(item.title)
    }));
}

function blockedEscalations(diagnostics: IssueStateDiagnostic[]): Array<Record<string, unknown>> {
  return diagnostics.filter((item) => item.severity === "blocked" || item.severity === "needs_user")
    .map((item) => ({
      code: item.code,
      evidence_refs: item.evidence.map((evidence) => evidence.ref),
      issue_id: item.issue_id,
      notification_event: "pi.needs_user",
      status: item.status,
      title: safeText(item.title)
    }));
}

function relatedEvidence(db: RunnerDatabase, projectID: string, window: { since: string; until: string }) {
  return {
    audit_events: listPiActionEvents(db, { projectId: projectID }).filter((event) => inWindow(event.created_at, window)).slice(-20),
    delegations: listPiDelegations(db, { projectId: projectID }).filter((item) => inWindow(item.updated_at, window)).slice(0, 20),
    heartbeat_runs: listPiHeartbeatRuns(db, { projectId: projectID }).filter((run) => inWindow(run.started_at, window)).slice(0, 20)
  };
}

async function usageSummary(input: PiReportInput, projectID: string): Promise<Record<string, unknown>> {
  try {
    const root = clean(input.codexSessionsDir);
    if (root === "") throw new Error("codex sessions dir 未配置");
    const report = await readCodexUsage({ root, options: { issues: usageIssues(input.database), projects: usageProjects(input.database) } });
    const project = projectUsage(report, projectID);
    const total = projectID === "" ? totalTokens(report) : totalTokens(project);
    return { status: "available", source: "/api/usage/codex", total_tokens: total, project_usage: project };
  } catch (error) {
    return { error: safeText(error instanceof Error ? error.message : String(error)), status: "not_configured", total_tokens: 0 };
  }
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

function totalTokens(value: Record<string, unknown> | undefined): number {
  const usage = (value?.usage ?? value?.summary) as Record<string, unknown> | undefined;
  const allTime = usage?.all_time as Record<string, unknown> | undefined;
  return numberValue(usage?.total_tokens) || numberValue(allTime?.total_tokens);
}

function providerHealth(project: Project | null): Record<string, unknown> {
  const warnings = project?.provider ? [] : ["provider missing"];
  return { provider: project?.provider ?? "", status: warnings.length > 0 ? "warning" : "configured", warnings };
}

function notificationPlan(db: RunnerDatabase, projectID: string): Record<string, unknown> {
  const settings = getNotificationSettings(db);
  return {
    channels: { mobile: false, sse: true, webhook: settings.webhook_url !== "" },
    event: "pi.report.generated",
    project_id: projectID,
    webhook_reserved: true
  };
}

function publishReport(bus: EventBus | undefined, report: PiReport): void {
  if (!bus) return;
  bus.publish(reportEvent(report));
}

function reportEvent(report: PiReport): AppEvent {
  return {
    payload: JSON.stringify(report),
    projectId: report.project_id,
    text: `PI report ${report.type}: completed=${report.summary.completed ?? 0}, failed=${report.summary.failed ?? 0}`,
    type: "pi.report.generated"
  };
}

function reportWindow(input: PiReportInput, now: Date): { since: string; until: string } {
  const until = clean(input.until) || now.toISOString();
  const since = clean(input.since) || new Date(Date.parse(until) - 24 * 60 * 60 * 1000).toISOString();
  return { since, until };
}

function projectScope(db: RunnerDatabase, projectID: string): Project | null {
  if (projectID === "") return null;
  return getProject(db, projectID);
}

function inWindow(value: string, window: { since: string; until: string }): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(window.since) && time <= Date.parse(window.until);
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
