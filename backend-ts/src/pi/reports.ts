import type { RunnerDatabase } from "../db/database.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import { getNotificationSettings } from "../db/repositories/notificationSettings.ts";
import {
  createPiReportRecord,
  getPiDelegation,
  listPiActionEvents,
  listPiDelegations,
  listPiHeartbeatRuns,
  type PiActionEvent,
  type PiHeartbeatRun
} from "../db/repositories/pi.ts";
import { getProject, listProjects, type Project } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { readCodexUsage } from "../usage/codex.ts";
import type { UsageIssueRef, UsageProjectRef } from "../usage/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { diagnoseIssueState, type IssueStateDiagnostic } from "./issueStateManager.ts";
import { buildNightRunSummary } from "./nightRunSummary.ts";
import { issueReportSummary } from "./reportIssueSummary.ts";

export type PiReportInput = {
  bus?: Pick<EventBus, "publish">; codexSessionsDir?: string; database: RunnerDatabase;
  delegationID?: string; heartbeatID?: string; now?: Date; projectID?: string;
  since?: string; source?: string; type?: string; until?: string;
};
export type PiReport = Record<string, unknown> & {
  delegation_id: string; generated_at: string; heartbeat_ids: string[]; issue_ids: number[];
  project_id: string; source: string; status: string; summary: Record<string, number>;
  type: string; usage_cost: Record<string, unknown>; window: { since: string; until: string };
};

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;

export async function buildPiReport(input: PiReportInput): Promise<PiReport> {
  const now = input.now ?? new Date();
  const scope = resolveReportScope(input);
  const project = projectScope(input.database, scope.projectID);
  const window = reportWindow(input, now);
  const evidence = relatedEvidence(input.database, project?.id ?? "", window, scope);
  const issues = reportIssues(input.database, project?.id ?? "", window, scope, evidence.audit_events);
  const diagnostics = diagnoseIssueState(input.database, {
    now, projectID: project?.id ?? "", issueIDs: issues.map((issue) => issue.id)
  }).diagnostics;
  const usage = await usageSummary(input, project?.id ?? "");
  const report = persistReport(input.database, assembleReport(input.database, {
    diagnostics, evidence, issues, now, project, scope, type: clean(input.type) || "manual", usage, window
  }));
  return report;
}

function persistReport(db: RunnerDatabase, report: PiReport): PiReport {
  const record = createPiReportRecord(db, {
    body_json: JSON.stringify(report),
    delegation_id: report.delegation_id,
    generated_at: String(report.generated_at),
    heartbeat_id: report.heartbeat_ids[0] ?? "",
    issue_ids_json: JSON.stringify(report.issue_ids),
    project_id: report.project_id,
    since_at: String(report.window?.since ?? ""),
    source: report.source,
    status: report.status,
    summary_json: JSON.stringify(report.summary),
    type: report.type,
    until_at: String(report.window?.until ?? "")
  });
  return { ...report, report_id: record.id };
}

function assembleReport(db: RunnerDatabase, input: {
  diagnostics: IssueStateDiagnostic[]; evidence: ReturnType<typeof relatedEvidence>; issues: Issue[];
  now: Date; project: Project | null; scope: ReportScope; type: string;
  usage: Record<string, unknown>; window: { since: string; until: string };
}): PiReport {
  const gaps = verificationGaps(input.diagnostics);
  const gapIDs = new Set(gaps.map((item) => item.issue_id));
  const completed = input.issues.filter((issue) => issue.status === "done" && !gapIDs.has(issue.id));
  const failed = input.issues.filter((issue) => issue.status === "failed");
  const escalations = blockedEscalations(input.diagnostics);
  const issueSummaries = input.issues.map(issueReportSummary);
  const completedSummaries = completed.map(issueReportSummary);
  const failedSummaries = failed.map(issueReportSummary);
  const issueIDs = input.issues.map((issue) => issue.id);
  const heartbeatIDs = input.evidence.heartbeat_runs.map((run) => run.id);
  const nightSummary = nightRunSummary(input, issueSummaries, completedSummaries, failedSummaries, heartbeatIDs);
  return {
    blocked_escalations: escalations,
    completed_issues: completedSummaries,
    delegation_id: input.scope.delegationID,
    evidence: input.evidence,
    failed_retry_summary: { count: failed.length, failed_issues: failedSummaries },
    generated_at: input.now.toISOString(),
    heartbeat_ids: heartbeatIDs,
    issue_categories: nightSummary.issue_categories,
    issue_ids: issueIDs,
    notification: notificationPlan(db, input.project?.id ?? ""),
    project_id: input.project?.id ?? "",
    project_name: safeText(input.project?.name ?? "All projects"),
    provider_health: providerHealth(input.project),
    summary: {
      blocked: nightSummary.issue_categories.blocked.length,
      completed: completed.length,
      failed: failed.length,
      needs_user: nightSummary.issue_categories.needs_user.length,
      total: input.issues.length,
      verification_gaps: gaps.length
    },
    summary_text_zh: nightSummary.summary_text_zh,
    source: input.scope.source,
    status: "generated",
    type: input.type,
    usage_cost: input.usage,
    verification_gaps: gaps,
    window: input.window
  };
}

function nightRunSummary(
  input: Parameters<typeof assembleReport>[1],
  issueSummaries: Array<Record<string, unknown>>,
  completedSummaries: Array<Record<string, unknown>>,
  failedSummaries: Array<Record<string, unknown>>,
  heartbeatIDs: string[]
): ReturnType<typeof buildNightRunSummary> {
  return buildNightRunSummary({
    allIssues: issueSummaries,
    completedIssues: completedSummaries,
    delegationID: input.scope.delegationID,
    diagnostics: input.diagnostics,
    failedIssues: failedSummaries,
    heartbeatIDs,
    projectLabel: input.project?.name ?? "All projects",
    source: input.scope.source,
    window: input.window
  });
}

type ReportScope = {
  delegationID: string; heartbeatID: string; projectID: string; source: string;
};

function reportIssues(
  db: RunnerDatabase,
  projectID: string,
  window: { since: string; until: string },
  scope: ReportScope,
  auditEvents: PiActionEvent[]
): Issue[] {
  const issues = listIssues(db, { projectId: projectID }).filter((issue) => inWindow(issue.updated_at, window));
  if (scope.delegationID === "" && scope.heartbeatID === "") return issues;
  const issueIDs = new Set(auditEvents.map((event) => event.issue_id).filter((id) => id > 0));
  return issues.filter((issue) => issueIDs.has(issue.id));
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

function relatedEvidence(
  db: RunnerDatabase,
  projectID: string,
  window: { since: string; until: string },
  scope: ReportScope
): { audit_events: PiActionEvent[]; delegations: ReturnType<typeof listPiDelegations>; heartbeat_runs: PiHeartbeatRun[] } {
  const actionFilter = scope.delegationID ? { delegationId: scope.delegationID, projectId: projectID } : { projectId: projectID };
  const heartbeatFilter = scope.delegationID ? { delegationId: scope.delegationID, projectId: projectID } : { projectId: projectID };
  const delegationFilter = scope.delegationID ? {} : { projectId: projectID };
  const delegations = scope.delegationID ? [getPiDelegation(db, scope.delegationID)].filter(Boolean) : listPiDelegations(db, delegationFilter);
  const heartbeatRuns = listPiHeartbeatRuns(db, heartbeatFilter).filter((run) => {
    const matchesID = scope.heartbeatID === "" || run.id === scope.heartbeatID;
    return matchesID && inWindow(run.started_at, window);
  });
  return {
    audit_events: listPiActionEvents(db, actionFilter)
      .filter((event) => inWindow(event.created_at, window) && heartbeatMatches(event, scope))
      .slice(-20),
    delegations: delegations.filter((item): item is NonNullable<typeof item> => Boolean(item))
      .filter((item) => scope.delegationID !== "" || inWindow(item.updated_at, window))
      .slice(0, 20),
    heartbeat_runs: heartbeatRuns.slice(0, 20)
  };
}

function heartbeatMatches(event: PiActionEvent, scope: ReportScope): boolean {
  return scope.heartbeatID === "" || event.heartbeat_id === scope.heartbeatID;
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

function reportWindow(input: PiReportInput, now: Date): { since: string; until: string } {
  const until = clean(input.until) || now.toISOString();
  const since = clean(input.since) || new Date(Date.parse(until) - 24 * 60 * 60 * 1000).toISOString();
  return { since, until };
}

function projectScope(db: RunnerDatabase, projectID: string): Project | null {
  if (projectID === "") return null;
  return getProject(db, projectID);
}

function resolveReportScope(input: PiReportInput): ReportScope {
  const delegationID = clean(input.delegationID);
  const delegation = delegationID ? getPiDelegation(input.database, delegationID) : null;
  return {
    delegationID,
    heartbeatID: clean(input.heartbeatID),
    projectID: clean(input.projectID) || (delegation?.project_id ?? ""),
    source: clean(input.source) || (delegationID ? "delegation" : "manual")
  };
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
