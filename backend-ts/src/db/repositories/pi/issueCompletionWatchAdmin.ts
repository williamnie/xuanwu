import type { RunnerDatabase } from "../../database.ts";
import { getSyncOutbox, type SyncOutboxRecord } from "../imReplyOutbox.ts";
import { getPiIssueCompletionWatch, type PiIssueCompletionWatch } from "./issueCompletionWatches.ts";
import { getPiNotificationIntent, type PiNotificationIntent } from "./notificationIntents.ts";
import { cleanString, integerInput } from "./common.ts";

export type PiIssueCompletionWatchListFilter = {
  limit?: number;
  projectId?: string;
  status?: string;
};
export type PiIssueCompletionWatchNotification = {
  intent: PiNotificationIntent;
  outbox: SyncOutboxRecord | null;
};
export type PiIssueCompletionWatchCounts = {
  active_watches: number;
  failed_notification: number;
  satisfied_pending_notification: number;
};

const WATCH_INTENT_KIND = "issue_completion_watch_satisfied";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function listPiIssueCompletionWatches(
  db: RunnerDatabase,
  filter: PiIssueCompletionWatchListFilter = {}
): PiIssueCompletionWatch[] {
  return watchIDs(db, filter)
    .map((id) => getPiIssueCompletionWatch(db, id))
    .filter((watch): watch is PiIssueCompletionWatch => Boolean(watch));
}

export function listPiIssueCompletionWatchNotifications(
  db: RunnerDatabase,
  watchID: string
): PiIssueCompletionWatchNotification[] {
  return notificationIntentIDs(db, watchID).map((id) => {
    const intent = getPiNotificationIntent(db, id);
    if (!intent) return null;
    return { intent, outbox: intent.sent_outbox_id > 0 ? getSyncOutbox(db, intent.sent_outbox_id) : null };
  }).filter((item): item is PiIssueCompletionWatchNotification => Boolean(item));
}

export function piIssueCompletionWatchCounts(db: RunnerDatabase): PiIssueCompletionWatchCounts {
  return {
    active_watches: countRows(db, "select count(*) as count from pi_issue_completion_watches where status='active'"),
    failed_notification: failedNotificationCount(db),
    satisfied_pending_notification: countRows(db, `select count(*) as count from pi_notification_intents
      where kind=? and state='ready' and sent_outbox_id=0 and error=''`, [WATCH_INTENT_KIND])
  };
}

function watchIDs(db: RunnerDatabase, filter: PiIssueCompletionWatchListFilter): string[] {
  const parts = watchWhere(filter);
  return db.sqlite.query<{ id: string }, Array<string | number>>(
    `select id from pi_issue_completion_watches${parts.where}
     order by created_at desc, id desc limit ?`
  ).all(...parts.args, boundedLimit(filter.limit)).map((row) => row.id);
}

function notificationIntentIDs(db: RunnerDatabase, watchID: string): string[] {
  const key = `issue_completion_watch_satisfied:${cleanString(watchID)}`;
  return db.sqlite.query<{ id: string }, [string, string]>(
    `select id from pi_notification_intents where kind=? and idempotency_key=?
     order by created_at asc, id asc`
  ).all(WATCH_INTENT_KIND, key).map((row) => row.id);
}

function watchWhere(filter: PiIssueCompletionWatchListFilter): {
  args: Array<string | number>;
  where: string;
} {
  const clauses: string[] = [];
  const args: Array<string | number> = [];
  addClause(clauses, args, "project_id=?", filter.projectId);
  addClause(clauses, args, "status=?", filter.status);
  return { args, where: clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "" };
}

function failedNotificationCount(db: RunnerDatabase): number {
  return countRows(db, `select count(*) as count from pi_notification_intents intent
    left join sync_outbox outbox on outbox.id=intent.sent_outbox_id
    where intent.kind=? and ((intent.state='ready' and intent.error<>'') or outbox.status='failed')`, [WATCH_INTENT_KIND]);
}

function addClause(clauses: string[], args: Array<string | number>, sql: string, value: unknown): void {
  const text = cleanString(value);
  if (text === "") return;
  clauses.push(sql);
  args.push(text);
}

function countRows(db: RunnerDatabase, sql: string, args: Array<string | number> = []): number {
  return db.sqlite.query<{ count: number }, Array<string | number>>(sql).get(...args)?.count ?? 0;
}

function boundedLimit(value: unknown): number {
  const limit = integerInput(value);
  if (limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}
