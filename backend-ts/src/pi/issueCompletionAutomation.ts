import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { getSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { getPiNotificationIntent } from "../db/repositories/pi/notificationIntents.ts";
import {
  cancelAutomationWatch,
  createAutomationWatch,
  getAutomationWatch,
  listAutomationIssueWatches,
  markAutomationWatchNotified,
  markAutomationWatchTerminal,
  type AutomationWatch
} from "../db/repositories/automationWatches.ts";
import type {
  PiIssueCompletionWatch,
  PiIssueCompletionWatchInput,
  PiIssueCompletionWatchItem
} from "../db/repositories/pi/issueCompletionWatches.ts";
import type { PiIssueCompletionWatchNotification } from "../db/repositories/pi/issueCompletionWatchAdmin.ts";
import type { AutomationAudit, AutomationID } from "../domain/automation/contracts.ts";

export const ISSUE_COMPLETION_TERMINAL_STATUSES = new Set([
  "done", "failed", "cancelled", "pending_verification"
]);

export function createIssueCompletionAutomation(
  db: RunnerDatabase,
  input: PiIssueCompletionWatchInput
): PiIssueCompletionWatch {
  const issueIDs = positiveIDs(input.issue_ids);
  if (issueIDs.length === 0) throw new Error("issue_ids is required");
  const issues = issueIDs.map((id) => {
    const issue = getIssue(db, id);
    if (!issue) throw new Error(`issue ${id} not found`);
    return issue;
  });
  const projectID = clean(input.project_id) || issues[0]?.project_id || "";
  if (!projectID || issues.some((issue) => issue.project_id !== projectID)) throw new Error("issue project_id does not match watch");
  const original = object(input.condition);
  const statuses = Array.isArray(original.terminal_statuses)
    ? original.terminal_statuses.map(clean).filter((status) => ISSUE_COMPLETION_TERMINAL_STATUSES.has(status))
    : [...ISSUE_COMPLETION_TERMINAL_STATUSES];
  const target = {
    channel: "feishu" as const,
    chat_id: clean(input.target_chat_id),
    message_id: clean(input.target_message_id),
    thread_id: clean(input.target_thread_id)
  };
  const requestedID = clean(input.id);
  const sourceKey = [clean(input.source_event_id), clean(input.source_message_id), projectID, ...issueIDs].join(":");
  const audit = automationWatchAudit("create", sourceKey);
  const watch = createAutomationWatch(db, {
    allow_empty_notification_target: true,
    condition: {
      match: original.type === "any_terminal" ? "any" : "all",
      metadata: {
        original_condition: original,
        origin_conversation_id: clean(input.origin_conversation_id),
        requested_by: clean(input.requested_by),
        source_event_id: clean(input.source_event_id),
        source_message_id: clean(input.source_message_id),
        target_channel: clean(input.target_channel) || "feishu"
      },
      statuses: [...new Set(statuses)].sort(),
      type: "issue_status"
    },
    dedupe_key: `issue-completion:${sourceKey}`,
    ...(requestedID ? { id: automationWatchID(requestedID) } : {}),
    name: `Issue completion watch · ${issueIDs.join(",")}`,
    notification_target: target,
    project_id: projectID,
    subject: { issue_ids: issueIDs, kind: "issues" }
  }, audit);
  return projectIssueCompletionAutomation(db, watch);
}

export function getIssueCompletionAutomation(db: RunnerDatabase, id: string): PiIssueCompletionWatch | null {
  const key = automationWatchID(id);
  const watch = getAutomationWatch(db, key) ?? listAutomationIssueWatches(db).find((item) => item.automation_id === id);
  return watch ? projectIssueCompletionAutomation(db, watch) : null;
}

export function listIssueCompletionAutomations(
  db: RunnerDatabase,
  filter: { limit?: number; projectId?: string; status?: string } = {}
): PiIssueCompletionWatch[] {
  const projectID = clean(filter.projectId);
  const status = clean(filter.status);
  return listAutomationIssueWatches(db)
    .map((watch) => projectIssueCompletionAutomation(db, watch))
    .filter((watch) => !projectID || watch.project_id === projectID)
    .filter((watch) => !status || watch.status === status)
    .slice(0, boundedLimit(filter.limit));
}

export function cancelIssueCompletionAutomation(
  db: RunnerDatabase,
  id: string,
  reason = "cancelled"
): PiIssueCompletionWatch {
  const current = requireWatch(db, id);
  if (current.status !== "active") return current;
  const watch = cancelAutomationWatch(db, current.id as AutomationID, automationWatchAudit("cancel", current.id, reason));
  db.sqlite.run("update automation_watches set error=? where automation_id=?", [clean(reason), watch.automation_id]);
  return projectIssueCompletionAutomation(db, getAutomationWatch(db, watch.automation_id)!);
}

export function markIssueCompletionAutomationSatisfied(db: RunnerDatabase, id: string, error = ""): PiIssueCompletionWatch {
  const current = requireNativeWatch(db, id);
  const watch = markAutomationWatchTerminal(db, current, {
    matchedRef: current.subject.kind === "issues" ? current.subject.issue_ids.join(",") : current.automation_id,
    outcome: error ? "failure" : "completion",
    status: "satisfied"
  }, automationWatchAudit("satisfied", current.automation_id, error));
  if (error) db.sqlite.run("update automation_watches set error=? where automation_id=?", [clean(error), watch.automation_id]);
  return projectIssueCompletionAutomation(db, getAutomationWatch(db, watch.automation_id)!);
}

export function markIssueCompletionAutomationNotified(db: RunnerDatabase, id: string): PiIssueCompletionWatch {
  const current = requireNativeWatch(db, id);
  return projectIssueCompletionAutomation(db, markAutomationWatchNotified(
    db,
    current,
    automationWatchAudit("notified", current.automation_id)
  ));
}

export function listIssueCompletionAutomationNotifications(
  db: RunnerDatabase,
  id: string
): PiIssueCompletionWatchNotification[] {
  const key = `automation_watch_terminal:${automationWatchID(id)}`;
  const ids = db.sqlite.query<{ id: string }, [string, string]>(
    "select id from pi_notification_intents where kind=? and idempotency_key=? order by created_at asc, id asc"
  ).all("automation_watch_terminal", key).map((row) => row.id);
  return ids.map((intentID) => {
    const intent = getPiNotificationIntent(db, intentID);
    return intent ? { intent, outbox: intent.sent_outbox_id > 0 ? getSyncOutbox(db, intent.sent_outbox_id) : null } : null;
  }).filter((item): item is PiIssueCompletionWatchNotification => Boolean(item));
}

export function issueCompletionAutomationOwnsTargetForIssue(db: RunnerDatabase, issueID: number): boolean {
  return listAutomationIssueWatches(db).some((watch) =>
    watch.subject.kind === "issues" &&
    watch.subject.issue_ids.includes(issueID) &&
    (watch.status === "watching" || watch.status === "satisfied") &&
    watch.notification_target.chat_id !== ""
  );
}

export function issueCompletionAutomationCounts(db: RunnerDatabase): {
  active_watches: number;
  failed_notification: number;
  satisfied_pending_notification: number;
} {
  return {
    active_watches: db.sqlite.query<{ count: number }, []>(
      "select count(*) as count from automation_watches where migration_mode='native' and status='watching'"
    ).get()?.count ?? 0,
    failed_notification: db.sqlite.query<{ count: number }, [string]>(`select count(*) as count
      from pi_notification_intents intent left join sync_outbox outbox on outbox.id=intent.sent_outbox_id
      where intent.kind=? and ((intent.state='ready' and intent.error<>'') or outbox.status='failed')`
    ).get("automation_watch_terminal")?.count ?? 0,
    satisfied_pending_notification: db.sqlite.query<{ count: number }, [string]>(`select count(*) as count
      from pi_notification_intents where kind=? and state='ready' and sent_outbox_id=0 and error=''`
    ).get("automation_watch_terminal")?.count ?? 0
  };
}

export function projectIssueCompletionAutomation(db: RunnerDatabase, watch: AutomationWatch): PiIssueCompletionWatch {
  if (watch.subject.kind !== "issues") throw new Error(`automation watch ${watch.automation_id} is not issue-based`);
  const definition = db.sqlite.query<{ scope_id: string }, [string]>(
    "select scope_id from automation_definitions where id=?"
  ).get(watch.automation_id);
  const metadata = watch.condition.metadata ?? {};
  const original = object(metadata.original_condition);
  const condition = JSON.stringify({
    ...original,
    terminal_statuses: Array.isArray(original.terminal_statuses)
      ? original.terminal_statuses
      : watch.condition.type === "issue_status" ? watch.condition.statuses : [],
    type: original.type || "all_terminal"
  });
  const status = legacyStatus(watch);
  const projectID = definition?.scope_id ?? "";
  return {
    completed_at: watch.satisfied_at,
    condition,
    created_at: watch.created_at,
    error: watch.error,
    id: watch.automation_id,
    idempotency_key: watch.dedupe_key,
    items: watch.subject.issue_ids.map((issueID) => projectItem(db, watch, issueID, projectID)),
    notified_at: watch.notified_at,
    origin_conversation_id: clean(metadata.origin_conversation_id),
    project_id: projectID,
    requested_by: clean(metadata.requested_by),
    source_event_id: clean(metadata.source_event_id),
    source_message_id: clean(metadata.source_message_id),
    status,
    target_channel: clean(metadata.target_channel) || watch.notification_target.channel,
    target_chat_id: watch.notification_target.chat_id,
    target_message_id: watch.notification_target.message_id,
    target_thread_id: watch.notification_target.thread_id,
    updated_at: watch.updated_at
  };
}

function projectItem(db: RunnerDatabase, watch: AutomationWatch, issueID: number, projectID: string): PiIssueCompletionWatchItem {
  const status = getIssue(db, issueID)?.status ?? "";
  return {
    created_at: watch.created_at,
    initial_status: "",
    issue_id: issueID,
    last_status: status,
    project_id: projectID,
    terminal_at: ISSUE_COMPLETION_TERMINAL_STATUSES.has(status) ? watch.satisfied_at : "",
    updated_at: watch.updated_at,
    watch_id: watch.automation_id
  };
}

function legacyStatus(watch: AutomationWatch): PiIssueCompletionWatch["status"] {
  if (watch.status === "watching") return "active";
  if (watch.status === "satisfied" || watch.status === "expired") return "satisfied";
  if (watch.status === "notified") return "notified";
  if (watch.status === "cancelled") return "cancelled";
  return "failed";
}

function requireWatch(db: RunnerDatabase, id: string): PiIssueCompletionWatch {
  const watch = getIssueCompletionAutomation(db, id);
  if (!watch) throw new Error(`Automation issue completion watch ${clean(id)} not found`);
  return watch;
}

function requireNativeWatch(db: RunnerDatabase, id: string): AutomationWatch {
  const watch = getAutomationWatch(db, automationWatchID(id));
  if (!watch) throw new Error(`Automation issue completion watch ${clean(id)} not found`);
  return watch;
}

function automationWatchID(value: string): AutomationID {
  const text = clean(value);
  if (text.startsWith("automation:")) return text as AutomationID;
  const slug = text.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 96) || crypto.randomUUID();
  return `automation:watch-${slug}` as AutomationID;
}

function automationWatchAudit(operation: string, correlation: string, reason = operation): AutomationAudit {
  const now = new Date().toISOString();
  return {
    actor_id: "issue-completion-automation",
    actor_kind: "automation",
    correlation_id: `issue-completion:${correlation}`,
    event_id: `automation-event:watch-${operation}:${crypto.randomUUID()}`,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "automation-watch-command:v1" },
    occurred_at: now,
    reason: `issue completion Automation ${reason}`
  };
}

function positiveIDs(value: unknown): number[] {
  return [...new Set((Array.isArray(value) ? value : [value]).filter((item): item is number => Number.isSafeInteger(item) && Number(item) > 0))].sort((a, b) => a - b);
}

function object(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string") return {};
  try { const parsed = JSON.parse(value); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? Math.min(value, 100) : 20;
}

function clean(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
