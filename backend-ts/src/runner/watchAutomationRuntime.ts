import type { RunnerDatabase } from "../db/database.ts";
import {
  listWatchingAutomationWatches,
  listPendingAutomationWatchDeliveries,
  markAutomationWatchNotified,
  markAutomationWatchTerminal,
  recordAutomationWatchNotificationQueued,
  updateAutomationWatchCursor,
  type AutomationWatch,
  type AutomationWatchOutcome
} from "../db/repositories/automationWatches.ts";
import { getAutomation } from "../db/repositories/automations.ts";
import { getSyncOutbox } from "../db/repositories/imReplyOutbox.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { createPiNotificationIntent, getPiNotificationIntent } from "../db/repositories/pi.ts";
import type { AutomationAudit } from "../domain/automation/contracts.ts";
import { queueExistingNotificationIntent } from "../notifications/unifiedNotificationPipeline.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { SUPERVISOR_NOTIFICATION_PREFIX } from "../xuanwu/userFacingTerminology.ts";
import { recordSupervisorCommitmentTerminalOutcome } from "../pi/supervisorCommitments.ts";

export type WatchAutomationCycleResult = {
  cursor_advanced: number;
  delivered: number;
  expired: number;
  failed: number;
  queued: number;
  satisfied: number;
  scanned: number;
};

type ExternalEventRow = {
  event_type: string;
  id: number;
  normalized_message_json: string;
  provider: string;
  source: string;
};
type Match = {
  matchedRef: string;
  outcome: Exclude<AutomationWatchOutcome, "">;
  sourceEventID: string;
  sourceEventType: string;
};
type WatchEvaluation = { cursor?: number; match?: Match };

const WATCH_INTENT_KIND = "automation_watch_terminal";
const WATCH_NOTIFICATION_TYPE = "automation_watch_notification";

export function runWatchAutomationsOnce(
  db: RunnerDatabase,
  options: { now?: Date | string } = {}
): WatchAutomationCycleResult {
  const now = normalizedDate(options.now);
  const watches = listWatchingAutomationWatches(db);
  const result: WatchAutomationCycleResult = {
    cursor_advanced: 0,
    delivered: 0,
    expired: 0,
    failed: 0,
    queued: 0,
    satisfied: 0,
    scanned: watches.length
  };
  reconcileDeliveredWatches(db, now, result);
  for (const watch of watches) {
    try {
      const timeout = expiryMatch(watch, now);
      if (timeout) {
        if (settleAndNotify(db, watch, timeout, now)) {
          result.expired += 1;
          result.queued += 1;
        }
        continue;
      }
      const evaluation: WatchEvaluation = watch.condition.type === "issue_status"
        ? evaluateIssueWatch(db, watch)
        : evaluateThreadWatch(db, watch);
      if (evaluation.cursor !== undefined && !evaluation.match) {
        updateAutomationWatchCursor(db, watch, evaluation.cursor, audit(watch, now, `cursor:${evaluation.cursor}`));
        result.cursor_advanced += 1;
      }
      if (!evaluation.match) continue;
      if (settleAndNotify(db, watch, evaluation.match, now)) {
        result.satisfied += 1;
        result.queued += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

function settleAndNotify(db: RunnerDatabase, watch: AutomationWatch, match: Match, now: Date): boolean {
  const timestamp = now.toISOString();
  const write = db.transaction(() => {
    const terminal = markAutomationWatchTerminal(db, watch, {
      matchedRef: match.matchedRef,
      outcome: match.outcome,
      status: match.outcome === "timeout" ? "expired" : "satisfied"
    }, audit(watch, now, `terminal:${match.outcome}`));
    if (!["satisfied", "expired"].includes(terminal.status)) return false;
    if (terminal.subject.kind === "issues" && terminal.condition.metadata?.original_condition) {
      recordSupervisorCommitmentTerminalOutcome(db, terminal.automation_id);
    }
    const intent = createPiNotificationIntent(db, {
      conversation_id: terminal.notification_target.thread_id || terminal.notification_target.conversation_id || watchOriginConversation(terminal),
      decision: "send_now",
      id: intentID(watch),
      idempotency_key: `automation_watch_terminal:${watch.automation_id}`,
      issue_id: notificationIssueID(watch),
      kind: WATCH_INTENT_KIND,
      payload_json: {
        matched_ref: match.matchedRef,
        outcome: match.outcome,
        watch_id: watch.automation_id
      },
      project_id: projectID(db, watch),
      ready_at: timestamp,
      severity: match.outcome === "completion" || match.outcome === "thread_event" ? "info" : "actionable",
      source_event_id: match.sourceEventID,
      source_event_type: match.sourceEventType,
      state: "ready",
      summary: `Watch ${watch.automation_id} reached ${match.outcome}`,
      target_channel: terminal.notification_target.connector_id,
      target_chat_id: terminal.notification_target.conversation_id,
      target_message_id: terminal.notification_target.reply_to_message_id,
      target_thread_id: terminal.notification_target.thread_id
    });
    if (!hasExternalNotificationTarget(terminal)) {
      recordAutomationWatchNotificationQueued(db, terminal, audit(watch, now, "notification-intent-ready"));
      return true;
    }
    const queued = queueExistingNotificationIntent(db, {
      content: notificationText(watch, match),
      intent,
      notificationID: watch.automation_id,
      notificationType: WATCH_NOTIFICATION_TYPE,
      route: {
        channel: terminal.notification_target.connector_id,
        chatID: terminal.notification_target.conversation_id,
        eventID: sourceExternalEventID(match.sourceEventID),
        messageID: terminal.notification_target.reply_to_message_id,
        threadID: terminal.notification_target.thread_id
      }
    });
    if (!queued.queued) return false;
    recordAutomationWatchNotificationQueued(db, terminal, audit(watch, now, "notification-queued"));
    return true;
  });
  return write.immediate();
}

function hasExternalNotificationTarget(watch: AutomationWatch): boolean {
  return Boolean(
    watch.notification_target.conversation_id ||
    watch.notification_target.reply_to_message_id ||
    watch.notification_target.thread_id
  );
}

function watchOriginConversation(watch: AutomationWatch): string {
  const value = watch.condition.metadata?.origin_conversation_id;
  return typeof value === "string" ? value.trim() : "";
}

function reconcileDeliveredWatches(
  db: RunnerDatabase,
  now: Date,
  result: WatchAutomationCycleResult
): void {
  for (const watch of listPendingAutomationWatchDeliveries(db)) {
    const intent = getPiNotificationIntent(db, intentID(watch));
    const outbox = intent && intent.sent_outbox_id > 0 ? getSyncOutbox(db, intent.sent_outbox_id) : null;
    if (outbox?.status !== "sent") continue;
    try {
      markAutomationWatchNotified(db, watch, audit(watch, now, "delivery-confirmed"));
      result.delivered += 1;
    } catch {
      result.failed += 1;
    }
  }
}

function evaluateIssueWatch(db: RunnerDatabase, watch: AutomationWatch): WatchEvaluation {
  if (watch.subject.kind !== "issues" || watch.condition.type !== "issue_status") return {};
  const issues = watch.subject.issue_ids.map((id) => getIssue(db, id));
  if (issues.some((issue) => !issue)) {
    return { match: {
      matchedRef: `issues:${watch.subject.issue_ids.join(",")}`,
      outcome: "failure",
      sourceEventID: `automation-watch:${watch.automation_id}:missing-issue`,
      sourceEventType: "automation.watch_target_missing"
    } };
  }
  const statuses = new Set(watch.condition.statuses);
  const matched = watch.condition.match === "all"
    ? issues.every((issue) => statuses.has(issue!.status))
    : issues.some((issue) => statuses.has(issue!.status));
  if (!matched) return {};
  const outcome = issues.some((issue) => issue!.status === "failed")
    ? "failure"
    : issues.some((issue) => issue!.status === "cancelled") ? "cancelled" : "completion";
  const decisive = issues.find((issue) => issue!.status === "failed" || issue!.status === "cancelled") ?? issues[0]!;
  return { match: {
    matchedRef: `issue:${decisive!.id}:${decisive!.status}`,
    outcome,
    sourceEventID: `issue:${decisive!.id}:${decisive!.updated_at}`,
    sourceEventType: "issue.status_observed"
  } };
}

function evaluateThreadWatch(
  db: RunnerDatabase,
  watch: AutomationWatch
): WatchEvaluation {
  if (watch.subject.kind !== "external_thread" || watch.condition.type !== "external_thread_event") return {};
  const subject = watch.subject;
  const condition = watch.condition;
  const events = db.sqlite.query<ExternalEventRow, [number]>(`select id, source, provider, event_type, normalized_message_json
    from external_events where id>? order by id asc limit 500`).all(watch.last_external_event_id);
  const eventTypes = new Set(condition.event_types);
  const match = events.find((event) => {
    const normalized = parseObject(event.normalized_message_json);
    const threadID = clean(normalized.thread_id) || clean(normalized.root_id);
    const providerMatches = event.provider === subject.provider || event.source === subject.provider;
    return providerMatches && threadID === subject.thread_id &&
      (eventTypes.size === 0 || eventTypes.has(event.event_type));
  });
  if (match) return { match: {
    matchedRef: `external_event:${match.id}`,
    outcome: "thread_event",
    sourceEventID: `external_event:${match.id}`,
    sourceEventType: match.event_type
  } };
  const cursor = events.at(-1)?.id;
  return cursor === undefined ? {} : { cursor };
}

function expiryMatch(watch: AutomationWatch, now: Date): Match | null {
  if (watch.expires_at === "" || Date.parse(watch.expires_at) > now.getTime()) return null;
  return {
    matchedRef: `watch_expiry:${watch.expires_at}`,
    outcome: "timeout",
    sourceEventID: `automation-watch:${watch.automation_id}:expiry`,
    sourceEventType: "automation.watch_expired"
  };
}

function audit(watch: AutomationWatch, now: Date, suffix: string): AutomationAudit {
  return {
    actor_id: "watch-automation-runtime",
    actor_kind: "automation",
    correlation_id: `watch-cycle:${watch.automation_id}:${now.toISOString()}`,
    event_id: `watch-event:${watch.automation_id}:${now.getTime()}:${suffix}`,
    gate: {
      authority: "deterministic_policy",
      decision: "allow",
      policy_ref: "automation-watch-runtime:v1"
    },
    occurred_at: now.toISOString(),
    reason: "deterministic watch condition evaluation"
  };
}

function projectID(db: RunnerDatabase, watch: AutomationWatch): string {
  const automation = getAutomation(db, watch.automation_id);
  return automation?.owner.kind === "project" ? automation.owner.project_id : "";
}

function notificationIssueID(watch: AutomationWatch): number {
  return watch.subject.kind === "issues" ? watch.subject.issue_ids[0] ?? 0 : 0;
}

function intentID(watch: AutomationWatch): string {
  return `automation-watch-terminal-${watch.automation_id.slice("automation:".length)}`;
}

function sourceExternalEventID(value: string): number {
  const match = /^external_event:([1-9][0-9]*)$/.exec(value);
  return match ? Number(match[1]) : 0;
}

function notificationText(watch: AutomationWatch, match: Match): string {
  const labels: Record<Exclude<AutomationWatchOutcome, "">, string> = {
    cancelled: "观察目标已取消",
    completion: "观察目标已完成",
    failure: "观察目标已失败",
    thread_event: "外部线程出现新事件",
    timeout: "观察已到期"
  };
  return [
    `${SUPERVISOR_NOTIFICATION_PREFIX}：Watch Automation ${labels[match.outcome]}`,
    `Watch：${redactSensitiveText(watch.automation_id)}`,
    `结果：${redactSensitiveText(match.matchedRef)}`
  ].join("\n");
}

function normalizedDate(value: Date | string | undefined): Date {
  const date = value instanceof Date ? value : new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("watch automation now must be a valid timestamp");
  return date;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
