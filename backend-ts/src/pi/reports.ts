import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { listIssues, type Issue } from "../db/repositories/issues.ts";
import {
  createPiReportRecord,
  getPiDelegation,
  listPiActionEvents,
  listPiDelegations,
  listPiHeartbeatRuns,
  type IssueSupervisorEvent,
  type PiActionEvent,
  type PiHeartbeatRun
} from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import type { EventBus } from "../events/bus.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { diagnoseIssueState, type IssueStateDiagnostic } from "./issueStateManager.ts";
import { buildNightRunSummary } from "./nightRunSummary.ts";
import { reportWarnings, summarizeProviderHealth } from "./reportHealth.ts";
import { issueReportSummary } from "./reportIssueSummary.ts";
import { listReportSupervisorEvents, supervisorReportSummary } from "./reportSupervisorSummary.ts";
import { buildUsageCostSummary } from "./reportUsage.ts";
import { parseStructuredVerifierReviewEventPayload } from "../domain/evidence/verifierReview.ts";

export type PiReportInput = {
  bus?: Pick<EventBus, "publish">; codexSessionsDir?: string; database: RunnerDatabase;
  delegationID?: string; heartbeatID?: string; now?: Date; projectID?: string;
  providerStatuses?: Array<Record<string, unknown>>;
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
  const providerHealth = summarizeProviderHealth(input.project, input.scope.providerStatuses);
  const supervisor = supervisorReportSummary(input.evidence.supervisor_events);
  const warnings = reportWarnings(providerHealth, input.usage);
  const usageWarnings = warnings.filter((item) => item.source === "usage_cost").length;
  const issueSummaries = input.issues.map(issueReportSummary);
  const completedSummaries = completed.map(issueReportSummary);
  const failedSummaries = failed.map(issueReportSummary);
  const issueIDs = input.issues.map((issue) => issue.id);
  const heartbeatIDs = input.evidence.heartbeat_runs.map((run) => run.id);
  const nightSummary = nightRunSummary(input, issueSummaries, completedSummaries, failedSummaries, heartbeatIDs);
  const verifierReviews = latestVerifierReviews(db, input.issues);
  const verifierVerdicts = verifierReviewVerdicts(verifierReviews);
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
    notification: notificationPlan(input.project?.id ?? ""),
    project_id: input.project?.id ?? "",
    project_name: safeText(input.project?.name ?? "All projects"),
    provider_health: providerHealth,
    summary: {
      blocked: nightSummary.issue_categories.blocked.length,
      completed: completed.length,
      failed: failed.length,
      needs_user: nightSummary.issue_categories.needs_user.length,
      supervisor_exhausted_recoveries: supervisor.exhausted_recoveries,
      supervisor_needs_user_escalations: supervisor.needs_user_escalations,
      supervisor_rate_limit_waits: supervisor.rate_limit_waits,
      supervisor_recovered_issues: supervisor.recovered_issues,
      supervisor_recovery_actions: supervisor.recovery_actions,
      total: input.issues.length,
      usage_warnings: usageWarnings,
      verifier_fail: verifierVerdicts.fail,
      verifier_inconclusive: verifierVerdicts.inconclusive,
      verifier_pass: verifierVerdicts.pass,
      verification_gaps: gaps.length,
      warnings: warnings.length
    },
    summary_text_zh: nightSummary.summary_text_zh,
    source: input.scope.source,
    status: "generated",
    supervisor_summary: supervisor,
    type: input.type,
    usage_cost: input.usage,
    verifier_reviews: verifierReviews,
    verification_gaps: gaps,
    warnings,
    window: input.window
  };
}

function latestVerifierReviews(db: RunnerDatabase, issues: Issue[]): Array<Record<string, unknown>> {
  return issues.flatMap((issue) => {
    const events = listIssueEvents(db, issue.id, { limit: 20, types: ["issue.verification_report"] });
    for (const event of [...events].reverse()) {
      const review = parseStructuredVerifierReviewEventPayload(event.payload);
      if (!review) continue;
      return [{
        event_id: event.id,
        evidence_ids: [...new Set(review.findings.flatMap((finding) => finding.evidence_ids))],
        gate_consistency: review.gate_consistency,
        issue_id: issue.id,
        missing_evidence: review.missing_evidence,
        policy_ref: review.input_context.policy_ref,
        recommended_next_action: review.recommended_next_action,
        verdict: review.verdict,
        work_id: review.input_context.work_id
      }];
    }
    return [];
  });
}

function verifierReviewVerdicts(reviews: Array<Record<string, unknown>>): Record<"fail" | "inconclusive" | "pass", number> {
  const counts = { fail: 0, inconclusive: 0, pass: 0 };
  for (const review of reviews) {
    const verdict = review.verdict;
    if (verdict === "pass" || verdict === "fail" || verdict === "inconclusive") counts[verdict] += 1;
  }
  return counts;
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
  delegationID: string; heartbeatID: string; projectID: string;
  providerStatuses?: Array<Record<string, unknown>>; source: string;
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
): {
  audit_events: PiActionEvent[];
  delegations: ReturnType<typeof listPiDelegations>;
  heartbeat_runs: PiHeartbeatRun[];
  supervisor_events: IssueSupervisorEvent[];
} {
  const actionFilter = scope.delegationID ? { delegationId: scope.delegationID, projectId: projectID } : { projectId: projectID };
  const heartbeatFilter = scope.delegationID ? { delegationId: scope.delegationID, projectId: projectID } : { projectId: projectID };
  const delegationFilter = scope.delegationID ? {} : { projectId: projectID };
  const delegations = scope.delegationID ? [getPiDelegation(db, scope.delegationID)].filter(Boolean) : listPiDelegations(db, delegationFilter);
  const auditEvents = listPiActionEvents(db, actionFilter)
    .filter((event) => inWindow(event.created_at, window) && heartbeatMatches(event, scope))
    .slice(-20);
  const heartbeatRuns = listPiHeartbeatRuns(db, heartbeatFilter).filter((run) => {
    const matchesID = scope.heartbeatID === "" || run.id === scope.heartbeatID;
    return matchesID && inWindow(run.started_at, window);
  });
  return {
    audit_events: auditEvents,
    delegations: delegations.filter((item): item is NonNullable<typeof item> => Boolean(item))
      .filter((item) => scope.delegationID !== "" || inWindow(item.updated_at, window))
      .slice(0, 20),
    heartbeat_runs: heartbeatRuns.slice(0, 20),
    supervisor_events: listReportSupervisorEvents(db, { auditEvents, projectID, scope, window })
  };
}

function heartbeatMatches(event: PiActionEvent, scope: ReportScope): boolean {
  return scope.heartbeatID === "" || event.heartbeat_id === scope.heartbeatID;
}

async function usageSummary(input: PiReportInput, projectID: string): Promise<Record<string, unknown>> {
  return buildUsageCostSummary({ codexSessionsDir: input.codexSessionsDir, database: input.database, projectID });
}

function notificationPlan(projectID: string): Record<string, unknown> {
  return {
    channels: { mobile: false, sse: true },
    event: "pi.report.generated",
    project_id: projectID
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
    providerStatuses: input.providerStatuses,
    source: clean(input.source) || (delegationID ? "delegation" : "manual")
  };
}

function inWindow(value: string, window: { since: string; until: string }): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(window.since) && time <= Date.parse(window.until);
}

function safeText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
