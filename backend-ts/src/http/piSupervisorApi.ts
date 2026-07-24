import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents, type IssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  listIssueSupervisorEvents,
  summarizeIssueSupervisorEvents,
  type IssueSupervisorEvent
} from "../db/repositories/pi.ts";
import { redactAuditJsonText, redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { HttpError, json } from "./errors.ts";
import type { Router } from "./router.ts";

type PiSupervisorApiContext = { database: RunnerDatabase };
type RetryAfterEvidence = {
  at: string; remaining_seconds: number; reason: string; source: string; source_event_id: string;
};

export function registerPiSupervisorRoutes(router: Router, context: PiSupervisorApiContext): void {
  router.get("/api/issues/:id/supervisor", (request) => json(issueSupervisorView(context.database, issueID(request))));
}

function issueSupervisorView(db: RunnerDatabase, id: number): Record<string, unknown> {
  const issue = getIssue(db, id);
  if (!issue) throw new HttpError(404, "资源不存在");
  // The history panel only renders the latest rows. Keep special latest values
  // as targeted queries so a large historical signal backlog never has to be
  // materialized and redacted on the HTTP event loop.
  const supervisorEvents = listIssueSupervisorEvents(db, { issueId: id, latestLimit: 20 });
  const latestDecision = listIssueSupervisorEvents(db, {
    eventTypes: ["decision", "decision_failed"],
    issueId: id,
    latestLimit: 1
  }).at(-1);
  const latestProvider = listIssueSupervisorEvents(db, {
    eventTypes: ["signal", "signal_failed"],
    issueId: id,
    latestLimit: 1
  }).at(-1);
  const latestRecovery = listIssueSupervisorEvents(db, {
    eventTypes: ["action", "result"],
    issueId: id,
    latestLimit: 1
  }).at(-1);
  const retryAfterEvents = listIssueSupervisorEvents(db, {
    issueId: id,
    latestLimit: 20,
    retryAfterOnly: true
  });
  // Supervisor 只需要 retry-after 证据；避免详情页读取整段 Provider 日志。
  const issueEvents = listIssueEvents(db, id, {
    hydrateArtifacts: false,
    limit: 100,
    types: ["issue.retry_after_scheduled"]
  });
  const providerEvidence = latestProvider ?? latestRetryIssueEvent(issueEvents);
  return {
    issue_id: id,
    latest: {
      created_at: latestDecision?.created_at || providerEvidence?.created_at || "",
      diagnosis_code: latestDecision?.diagnosis_code || clean(rowValue(providerEvidence, "diagnosis_code")),
      executed_recovery_message: recoveryMessage(latestRecovery) || decisionView(latestDecision).recovery_message,
      pi_decision: decisionView(latestDecision),
      provider_error: providerErrorView(providerEvidence),
      recovery_action: recoveryActionView(latestRecovery)
    },
    project_id: issue.project_id,
    recovery_history: supervisorEvents.slice(-20).reverse().map(historyItem),
    retry_after: retryAfterView(issue, retryAfterEvents, issueEvents),
    summary: summarizeIssueSupervisorEvents(db, id)
  };
}

function latestEvent<T>(items: T[], predicate: (item: T) => boolean): T | undefined {
  return [...items].reverse().find(predicate);
}

function decisionView(event: IssueSupervisorEvent | undefined): Record<string, unknown> {
  const decision = objectValue(jsonValue(event?.payload_json ?? "{}").decision);
  return {
    confidence: event?.confidence ?? "",
    decision: event?.decision || clean(decision.decision),
    evidence_refs: stringArray(decision.evidence_refs),
    expected_outcome: clean(decision.expected_outcome),
    fallback_if_no_progress: clean(decision.fallback_if_no_progress),
    rationale: clean(decision.rationale),
    recovery_message: clean(decision.recovery_message),
    risk_level: clean(decision.risk_level),
    wait_until: clean(decision.wait_until) || event?.retry_after_at || ""
  };
}

function providerErrorView(event: IssueSupervisorEvent | IssueEvent | undefined): Record<string, unknown> {
  const payload = jsonValue(eventPayload(event));
  const providerError = objectValue(payload.provider_error);
  return {
    category: clean(rowValue(event, "provider_error_category")) || clean(providerError.category),
    diagnosis_code: clean(rowValue(event, "diagnosis_code")),
    provider: clean(rowValue(event, "provider")) || clean(providerError.provider),
    raw_summary: safeText(clean(payload.raw_summary) || clean(payload.reason) || clean(payload.error)),
    retry_after_at: clean(rowValue(event, "retry_after_at")) || clean(payload.retry_after_at) || clean(providerError.retry_after_at),
    status_code: numberValue(payload.status_code) || numberValue(providerError.status_code) || 0
  };
}

function recoveryActionView(event: IssueSupervisorEvent | undefined): Record<string, unknown> {
  const payload = jsonValue(event?.payload_json ?? "{}");
  return {
    action_id: event?.action_id ?? "",
    action_type: event?.action_type ?? "",
    decision: event?.decision ?? "",
    outcome: clean(payload.outcome) || clean(payload.status),
    provider_turn_id: clean(payload.provider_turn_id),
    retry_after_at: event?.retry_after_at || clean(payload.retry_after_at)
  };
}

function historyItem(event: IssueSupervisorEvent): Record<string, unknown> {
  return {
    action_id: event.action_id,
    action_type: event.action_type,
    created_at: event.created_at,
    decision: event.decision,
    diagnosis_code: event.diagnosis_code,
    event_type: event.event_type,
    id: event.id,
    message: eventMessage(event),
    retry_after_at: event.retry_after_at
  };
}

function retryAfterView(
  issue: { auto_retry_next_at: string; auto_retry_reason: string },
  supervisorEvents: IssueSupervisorEvent[],
  issueEvents: IssueEvent[]
): RetryAfterEvidence | null {
  const candidates = [
    ...supervisorEvents.map(supervisorRetryAfter),
    ...issueEvents.map(issueRetryAfter),
    issue.auto_retry_next_at ? issueRetryRecord(issue) : null
  ].filter((item): item is RetryAfterEvidence => Boolean(item?.at));
  const latest = candidates.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0];
  return latest ? { ...latest, remaining_seconds: remainingSeconds(latest.at) } : null;
}

function supervisorRetryAfter(event: IssueSupervisorEvent): RetryAfterEvidence | null {
  const payload = jsonValue(event.payload_json);
  const at = event.retry_after_at || clean(payload.retry_after_at) || clean(objectValue(payload.decision).wait_until);
  if (!at) return null;
  return {
    at,
    remaining_seconds: 0,
    reason: event.diagnosis_code || clean(payload.reason),
    source: `supervisor_event:${event.id}`,
    source_event_id: event.action_id || String(event.id)
  };
}

function issueRetryAfter(event: IssueEvent): RetryAfterEvidence | null {
  if (event.type !== "issue.retry_after_scheduled") return null;
  const payload = jsonValue(event.payload);
  const at = clean(payload.retry_after_at);
  if (!at) return null;
  return {
    at,
    remaining_seconds: 0,
    reason: safeText(clean(payload.reason)),
    source: `issue_event:${event.id}`,
    source_event_id: clean(payload.source_event_id) || String(event.id)
  };
}

function issueRetryRecord(issue: { auto_retry_next_at: string; auto_retry_reason: string }): RetryAfterEvidence {
  return {
    at: issue.auto_retry_next_at,
    remaining_seconds: 0,
    reason: safeText(issue.auto_retry_reason),
    source: "issue.auto_retry_next_at",
    source_event_id: ""
  };
}

function recoveryMessage(event: IssueSupervisorEvent | undefined): string {
  const payload = jsonValue(event?.payload_json ?? "{}");
  return safeText(clean(payload.prompt) || clean(payload.message) || clean(objectValue(payload.decision).recovery_message));
}

function eventMessage(event: IssueSupervisorEvent): string {
  return recoveryMessage(event) || clean(decisionView(event).rationale) || clean(providerErrorView(event).raw_summary);
}

function latestRetryIssueEvent(events: IssueEvent[]): IssueEvent | undefined {
  return latestEvent(events, (event) => event.type === "issue.retry_after_scheduled");
}

function remainingSeconds(value: string): number {
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, Math.ceil((at - Date.now()) / 1_000)) : 0;
}

function eventPayload(event: IssueSupervisorEvent | IssueEvent | undefined): string {
  if (!event) return "{}";
  return "payload_json" in event ? event.payload_json : event.payload;
}

function rowValue(event: IssueSupervisorEvent | IssueEvent | undefined, key: string): unknown {
  return event && key in event ? (event as unknown as Record<string, unknown>)[key] : "";
}

function jsonValue(value: unknown): Record<string, unknown> {
  try {
    const parsed = JSON.parse(redactAuditJsonText(String(value || "{}"))) as unknown;
    return objectValue(parsed);
  } catch {
    return {};
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeText(value: string): string {
  return redactAuditText(value);
}

function issueID(request: Request): number {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const raw = parts[parts.indexOf("issues") + 1] ?? "";
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw new HttpError(400, "issue id 不合法");
  return id;
}
