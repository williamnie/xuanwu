import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  createPiNotificationIntent,
  getPiIssueCompletionWatch,
  listActivePiIssueCompletionWatches,
  updatePiIssueCompletionWatchItemStatus,
  type PiIssueCompletionWatch,
  type PiIssueCompletionWatchItem
} from "../db/repositories/pi.ts";
import type { AppEvent, EventBus } from "../events/bus.ts";
import { redactSensitiveText } from "../util/redact.ts";
import {
  expireSupervisorCommitmentIfDue,
  recordSupervisorCommitmentTerminalOutcome
} from "./supervisorCommitments.ts";

export const ISSUE_COMPLETION_WATCH_INTENT_KIND = "issue_completion_watch_satisfied";

export type PiIssueCompletionWatchEventInput = {
  eventID?: unknown;
  eventType?: unknown;
  issueID: number;
  projectID?: unknown;
  status?: unknown;
};
export type PiIssueCompletionWatchEvaluationResult = {
  intents: number;
  satisfied: number;
  updatedItems: number;
  watches: number;
};

const ACTIVE_ISSUE_STATUSES = new Set(["triage", "todo", "in_progress"]);

export function attachPiIssueCompletionWatchObserver(input: {
  bus: Pick<EventBus, "observe">;
  database: RunnerDatabase;
}): () => void {
  return input.bus.observe((event) => {
    try {
      if (!isIssueLifecycleEvent(event)) return;
      evaluatePiIssueCompletionWatchesForIssue(input.database, {
        eventID: event.id,
        eventType: event.type,
        issueID: event.issueId,
        projectID: event.projectId,
        status: statusFromEvent(event)
      });
    } catch {
      // Watch evaluation is best-effort and must not break the source lifecycle event.
    }
  });
}

export function evaluatePiIssueCompletionWatchesForIssue(
  db: RunnerDatabase,
  input: PiIssueCompletionWatchEventInput
): PiIssueCompletionWatchEvaluationResult {
  const issue = getIssue(db, input.issueID);
  const status = cleanString(input.status) || issue?.status || "";
  const watches = activeWatchesForIssue(db, input.issueID);
  const result = emptyResult(watches.length);
  if (!issue || status === "") return result;
  for (const watch of watches) {
    if (expireSupervisorCommitmentIfDue(db, watch.id)) continue;
    updatePiIssueCompletionWatchItemStatus(db, watch.id, issue.id, status);
    result.updatedItems += 1;
    const refreshed = getPiIssueCompletionWatch(db, watch.id);
    if (refreshed?.status !== "satisfied") continue;
    queueSatisfiedWatchIntent(db, refreshed, { ...input, status });
    recordSupervisorCommitmentTerminalOutcome(db, refreshed.id);
    result.satisfied += 1;
    result.intents += 1;
  }
  return result;
}

export function sweepActivePiIssueCompletionWatches(
  db: RunnerDatabase
): PiIssueCompletionWatchEvaluationResult {
  const watches = listActivePiIssueCompletionWatches(db);
  const result = emptyResult(watches.length);
  for (const watch of watches) {
    if (expireSupervisorCommitmentIfDue(db, watch.id)) continue;
    for (const item of watch.items) {
      const issue = getIssue(db, item.issue_id);
      if (!issue || !shouldRefreshItem(item, issue.status)) continue;
      updatePiIssueCompletionWatchItemStatus(db, watch.id, issue.id, issue.status);
      result.updatedItems += 1;
    }
    const refreshed = getPiIssueCompletionWatch(db, watch.id);
    if (refreshed?.status !== "satisfied") continue;
    queueSatisfiedWatchIntent(db, refreshed, {
      eventID: `sweep:${watch.id}`,
      eventType: "issue_completion_watch.sweep",
      issueID: refreshed.items[0]?.issue_id ?? 0,
      projectID: refreshed.project_id
    });
    recordSupervisorCommitmentTerminalOutcome(db, refreshed.id);
    result.satisfied += 1;
    result.intents += 1;
  }
  return result;
}

function queueSatisfiedWatchIntent(
  db: RunnerDatabase,
  watch: PiIssueCompletionWatch,
  event: PiIssueCompletionWatchEventInput
): void {
  const issues = watchIssues(db, watch);
  const stats = issueStats(watch.items);
  createPiNotificationIntent(db, {
    conversation_id: watch.origin_conversation_id,
    decision: "send_now",
    id: `issue-completion-watch-satisfied-${watch.id}`,
    idempotency_key: `issue_completion_watch_satisfied:${watch.id}`,
    issue_id: event.issueID || watch.items[0]?.issue_id || 0,
    kind: ISSUE_COMPLETION_WATCH_INTENT_KIND,
    payload_json: watchIntentPayload(watch, issues, stats, event),
    project_id: watch.project_id,
    ready_at: new Date().toISOString(),
    severity: stats.failed + stats.cancelled > 0 ? "actionable" : "info",
    source_event_id: cleanString(event.eventID),
    source_event_type: cleanString(event.eventType) || "issue_completion_watch.satisfied",
    state: "ready",
    summary: watchSummary(watch, stats),
    target_channel: watchTargetChannel(watch),
    target_chat_id: watch.target_chat_id,
    target_message_id: watch.target_message_id,
    target_thread_id: watch.target_thread_id
  });
}

function watchIntentPayload(
  watch: PiIssueCompletionWatch,
  issues: WatchIssuePayload[],
  stats: WatchStats,
  event: PiIssueCompletionWatchEventInput
): Record<string, unknown> {
  return {
    condition: parseJsonObject(watch.condition),
    issues,
    next_step: nextStep(stats),
    project_id: watch.project_id,
    source_event: {
      id: cleanString(event.eventID),
      issue_id: event.issueID,
      status: cleanString(event.status),
      type: cleanString(event.eventType)
    },
    stats,
    target: {
      channel: watchTargetChannel(watch),
      chat_id: watch.target_chat_id,
      message_id: watch.target_message_id,
      thread_id: watch.target_thread_id
    },
    watch_id: watch.id
  };
}

type WatchIssuePayload = {
  error: string;
  id: number;
  status: string;
  terminal_at: string;
  title: string;
};
type WatchStats = {
  cancelled: number;
  done: number;
  failed: number;
  pending_verification: number;
  terminal: number;
  total: number;
};

function watchIssues(db: RunnerDatabase, watch: PiIssueCompletionWatch): WatchIssuePayload[] {
  return watch.items.map((item) => {
    const issue = getIssue(db, item.issue_id);
    return {
      error: redactSensitiveText(issue?.error ?? ""),
      id: item.issue_id,
      status: item.last_status,
      terminal_at: item.terminal_at,
      title: issue?.title ?? ""
    };
  });
}

function issueStats(items: PiIssueCompletionWatchItem[]): WatchStats {
  const stats: WatchStats = { cancelled: 0, done: 0, failed: 0, pending_verification: 0, terminal: 0, total: items.length };
  for (const item of items) {
    const status = cleanString(item.last_status);
    if (!isTerminalStatus(status)) continue;
    stats.terminal += 1;
    if (status === "done") stats.done += 1;
    if (status === "failed") stats.failed += 1;
    if (status === "cancelled") stats.cancelled += 1;
    if (status === "pending_verification") stats.pending_verification += 1;
  }
  return stats;
}

function activeWatchesForIssue(db: RunnerDatabase, issueID: number): PiIssueCompletionWatch[] {
  return listActivePiIssueCompletionWatches(db)
    .filter((watch) => watch.items.some((item) => item.issue_id === issueID));
}

function shouldRefreshItem(item: PiIssueCompletionWatchItem, status: string): boolean {
  const terminal = isTerminalStatus(status);
  return item.last_status !== status || (terminal && item.terminal_at === "") ||
    (!terminal && item.terminal_at !== "");
}

function isIssueLifecycleEvent(event: AppEvent): event is AppEvent & { issueId: number } {
  return (event.type === "issue.status_changed" || event.type === "issue.created") &&
    typeof event.issueId === "number" && event.issueId > 0;
}

function statusFromEvent(event: AppEvent): string {
  return cleanString(event.status) || cleanString(parseJsonObject(event.payload).status);
}

function watchTargetChannel(watch: PiIssueCompletionWatch): string {
  return watch.target_channel || (watch.target_chat_id ? "feishu" : "");
}

function watchSummary(watch: PiIssueCompletionWatch, stats: WatchStats): string {
  return `watch ${watch.id} satisfied: ${stats.terminal}/${stats.total} issues terminal`;
}

function nextStep(stats: WatchStats): string {
  const problemCount = stats.failed + stats.cancelled;
  if (problemCount > 0) return `${problemCount} 个 watched issue failed/cancelled，请查看失败原因并决定是否 retry。`;
  return "所有 watched issues 已进入终态，可以继续下一步。";
}

function emptyResult(watches: number): PiIssueCompletionWatchEvaluationResult {
  return { intents: 0, satisfied: 0, updatedItems: 0, watches };
}

function isTerminalStatus(status: string): boolean {
  const text = cleanString(status);
  return text !== "" && !ACTIVE_ISSUE_STATUSES.has(text);
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" ? value.trim() : "";
}
