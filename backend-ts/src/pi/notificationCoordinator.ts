import type { RunnerDatabase } from "../db/database.ts";
import type { Issue } from "../db/repositories/issues.ts";
import {
  createPiNotificationIntent,
  listPiRunGroupItems,
  readProjectPiPolicy,
  updatePiNotificationIntent,
  type PiGuardianEvent,
  type PiNotificationIntent,
  type PiRunGroupItem
} from "../db/repositories/pi.ts";
import { redactSensitiveText } from "../util/redact.ts";
import {
  resolvePiNotificationPreference,
  type ResolvedPiNotificationPreference
} from "./notificationPreferenceResolver.ts";
import { quietHoursResumeAt } from "../schedule/cronSchedule.ts";

export type LifecycleIntentDecision = "aggregate" | "send_now" | "suppress";
export type LifecycleIntentResult = {
  decision: LifecycleIntentDecision;
  intent: PiNotificationIntent;
  runGroupID: string;
};

export function coordinateIssueLifecycleNotification(
  db: RunnerDatabase,
  input: { event: PiGuardianEvent; issue: Issue; now?: Date; target?: LifecycleTarget }
): LifecycleIntentResult {
  const item = latestRunGroupItemForIssue(db, input.issue.id);
  const runGroupID = item?.run_group_id ?? "";
  const preference = resolveLifecyclePreference(db, input.event, input.issue, runGroupID);
  const quietUntil = lifecycleQuietUntil(db, input.issue.project_id, input.now ?? new Date(), input.event.severity, preference);
  const decision = lifecycleDecision(input.issue.status, runGroupID, input.event.severity, preference, quietUntil);
  const intent = createPiNotificationIntent(db, {
    conversation_id: input.event.conversation_id,
    decision,
    flush_after_at: decision === "aggregate" ? quietUntil : "",
    idempotency_key: lifecycleIntentKey(input.issue, input.event, runGroupID),
    issue_id: input.issue.id,
    kind: lifecycleKind(input.issue.status),
    payload_json: lifecycleIntentPayload(input.issue),
    preference_id: preference.preferenceID,
    project_id: input.issue.project_id,
    run_group_id: runGroupID,
    severity: input.event.severity,
    source_event_id: input.event.id,
    source_event_sequence_id: input.event.sequence_id,
    source_event_type: input.event.event_type,
    state: lifecycleIntentState(decision),
    summary: lifecycleSummary(input.issue),
    target_channel: input.target ? "feishu" : "",
    target_chat_id: input.target?.chatID ?? "",
    target_message_id: input.target?.messageID ?? "",
    target_thread_id: input.target?.threadID ?? ""
  });
  return { decision, intent, runGroupID };
}

export function markLifecycleIntentSent(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  sentOutboxID: number
): PiNotificationIntent {
  return markNotificationIntentSent(db, intent, sentOutboxID);
}

export function markNotificationIntentSent(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  sentOutboxID: number
): PiNotificationIntent {
  return updatePiNotificationIntent(db, intent.id, {
    sent_at: new Date().toISOString(),
    sent_outbox_id: sentOutboxID,
    state: "sent"
  });
}

export function markNotificationIntentRetry(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  reason: string
): PiNotificationIntent {
  return updatePiNotificationIntent(db, intent.id, {
    error: redactSensitiveText(reason),
    state: "ready"
  });
}

export function suppressLifecycleIntent(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  reason: string
): PiNotificationIntent {
  return updatePiNotificationIntent(db, intent.id, {
    decision: "suppress",
    error: reason,
    state: "suppressed"
  });
}

export type LifecycleTarget = { chatID: string; messageID: string; threadID: string };

function latestRunGroupItemForIssue(db: RunnerDatabase, issueID: number): PiRunGroupItem | null {
  const row = db.sqlite.query<{ run_group_id: string }, [number]>(
    `select run_group_id from pi_run_group_items
     where issue_id=? order by joined_at desc, run_group_id desc limit 1`
  ).get(issueID);
  if (!row) return null;
  return listPiRunGroupItems(db, row.run_group_id)
    .find((item) => item.issue_id === issueID) ?? null;
}

function resolveLifecyclePreference(
  db: RunnerDatabase,
  event: PiGuardianEvent,
  issue: Issue,
  runGroupID: string
): ResolvedPiNotificationPreference {
  return resolvePiNotificationPreference(db, {
    conversationID: event.conversation_id,
    eventSequence: event.sequence_id,
    projectID: issue.project_id,
    runGroupID
  });
}

function lifecycleDecision(
  status: string,
  runGroupID: string,
  severity: string,
  preference: ResolvedPiNotificationPreference,
  quietUntil: string
): LifecycleIntentDecision {
  const preferenceDecision = preferenceLifecycleDecision(preference, severity);
  if (preferenceDecision) return preferenceDecision;
  if (quietUntil !== "") return "aggregate";
  if (runGroupID === "") return "send_now";
  if (isStartStatus(status)) return "suppress";
  return "aggregate";
}

function lifecycleQuietUntil(
  db: RunnerDatabase,
  projectID: string,
  now: Date,
  severity: string,
  preference: ResolvedPiNotificationPreference
): string {
  if (mustNotify(preference, severity)) return "";
  const policy = readProjectPiPolicy(db, projectID);
  return quietHoursResumeAt({
    mode: "daily",
    next_run_at: now.toISOString(),
    quiet_hours_json: policy.quiet_hours_json,
    time_of_day: "00:00",
    timezone: policy.timezone
  }, now);
}

function preferenceLifecycleDecision(
  preference: ResolvedPiNotificationPreference,
  severity: string
): LifecycleIntentDecision | null {
  if (preference.source === "system_default") return null;
  if (mustNotify(preference, severity)) return "send_now";
  if (preference.effective.mode === "quiet") return "suppress";
  if (preference.effective.mode === "digest") return "aggregate";
  return null;
}

function mustNotify(preference: ResolvedPiNotificationPreference, severity: string): boolean {
  const token = severity.trim().toLowerCase();
  return ["urgent", "actionable", "pi_unavailable", "needs_user", "budget_exhausted", "unsafe_or_external"].includes(token) ||
    preference.effective.notify_on.includes(token);
}

function lifecycleIntentState(decision: LifecycleIntentDecision): string {
  if (decision === "send_now") return "ready";
  if (decision === "suppress") return "suppressed";
  return "aggregated";
}

function lifecycleKind(status: string): string {
  if (isStartStatus(status)) return "issue_start";
  if (status === "done") return "issue_done";
  if (status === "pending_verification") return "issue_pending_verification";
  if (status === "failed") return "issue_failed";
  return `issue_${status}`;
}

function lifecycleIntentKey(issue: Issue, event: PiGuardianEvent, runGroupID: string): string {
  const source = isStartStatus(issue.status) ? "start" : event.id;
  return `${lifecycleKind(issue.status)}:${issue.project_id}:${issue.id}:${runGroupID}:${source}:feishu`;
}

function lifecycleSummary(issue: Issue): string {
  return `issue #${issue.id} ${issue.status}: ${issue.title}`;
}

function lifecycleIntentPayload(issue: Issue): Record<string, string | number> {
  return {
    error: redactSensitiveText(issue.error),
    issue_id: issue.id,
    status: issue.status,
    title: issue.title
  };
}

function isStartStatus(status: string): boolean {
  return status === "todo" || status === "in_progress";
}
