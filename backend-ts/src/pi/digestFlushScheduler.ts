import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  createPiNotificationIntent,
  getPiRunGroup,
  listPiNotificationIntents,
  listPiRunGroupItems,
  listPiRunGroups,
  refreshPiRunGroupCompletion,
  updatePiNotificationIntent,
  updatePiRunGroup,
  updatePiRunGroupItem,
  type PiRunGroup,
  type PiRunGroupItem
} from "../db/repositories/pi.ts";
import { lifecycleReport } from "./runGroupReportStatus.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type DigestFlushSchedulerResult = { flushed: number; scanned: number; skipped: number };
export type DigestFlushSchedulerInput = { limit?: number; now?: Date | string };
export type ManualDigestFlushInput = { now?: Date | string; runGroupID: string };

type FlushReason = "completed" | "manual" | "partial_deadline" | "partial_interval";
type DigestCounts = {
  active: number; completed: number; failed: number; needsUser: number;
  skipped: number; total: number;
};
type DigestPayload = DigestCounts & {
  active_count: number; completed_count: number; failed_count: number;
  issues: Array<Record<string, number | string>>; needs_user_count: number;
  run_group_id: string; skipped_count: number; total_count: number;
};

const DEFAULT_LIMIT = 50;
const DIGEST_CHANNEL = "feishu";
const MINUTE_MS = 60_000;
const activeDigestFlushGroups = new Set<string>();

export function runDigestFlushSchedulerOnce(
  db: RunnerDatabase,
  input: DigestFlushSchedulerInput = {}
): DigestFlushSchedulerResult {
  const nowText = iso(input.now);
  const groups = candidateGroups(db, input.limit ?? DEFAULT_LIMIT);
  const result: DigestFlushSchedulerResult = { flushed: 0, scanned: groups.length, skipped: 0 };
  for (const group of groups) {
    const refreshed = refreshGroupForDigest(db, group.id, nowText);
    if (!refreshed) {
      result.skipped += 1;
      continue;
    }
    const reason = dueReason(db, refreshed, nowText);
    if (!reason) {
      result.skipped += 1;
      continue;
    }
    if (activeDigestFlushGroups.has(refreshed.id)) {
      result.skipped += 1;
      continue;
    }
    if (flushGroupDigest(db, refreshed, reason, nowText)) result.flushed += 1;
    else result.skipped += 1;
  }
  return result;
}

export function flushRunGroupDigest(
  db: RunnerDatabase,
  input: ManualDigestFlushInput
): DigestFlushSchedulerResult {
  const nowText = iso(input.now);
  const group = refreshGroupForDigest(db, input.runGroupID, nowText);
  if (!group) return { flushed: 0, scanned: 0, skipped: 1 };
  if (activeDigestFlushGroups.has(group.id)) return { flushed: 0, scanned: 1, skipped: 1 };
  const flushed = flushGroupDigest(db, group, "manual", nowText, true);
  return { flushed: flushed ? 1 : 0, scanned: 1, skipped: flushed ? 0 : 1 };
}

function flushGroupDigest(
  db: RunnerDatabase,
  group: PiRunGroup,
  reason: FlushReason,
  nowText: string,
  force = false
): boolean {
  activeDigestFlushGroups.add(group.id);
  try {
    return db.transaction(() => {
      const current = getPiRunGroup(db, group.id);
      if (!current || (!force && dueReason(db, current, nowText) !== reason)) return false;
      const reserved = updatePiRunGroup(db, group.id, {
        digest_flush_sequence: current.digest_flush_sequence + 1,
        last_digest_at: nowText,
        status: nextGroupStatus(current.status, reason)
      });
      const items = listPiRunGroupItems(db, group.id);
      const payload = digestPayload(group.id, group.expected_issue_count, items);
      markCoveredLifecycleIntents(db, group.id);
      createPiNotificationIntent(db, {
        conversation_id: group.origin_conversation_id,
        flush_reason: reason,
        flush_sequence: reserved.digest_flush_sequence,
        kind: "digest",
        payload_json: payload,
        project_id: group.project_id,
        ready_at: nowText,
        run_group_id: group.id,
        source_event_type: "digest.flush_due",
        state: "ready",
        summary: digestSummary(reason, payload),
        target_channel: DIGEST_CHANNEL
      });
      return true;
    }).immediate();
  } finally {
    activeDigestFlushGroups.delete(group.id);
  }
}

function nextGroupStatus(currentStatus: string, reason: FlushReason): string {
  if (reason === "completed" || currentStatus === "completed") return "completed";
  return "partial";
}

function refreshGroupForDigest(db: RunnerDatabase, runGroupID: string, timestamp: string): PiRunGroup | null {
  const group = getPiRunGroup(db, runGroupID);
  if (!group) return null;
  for (const item of listPiRunGroupItems(db, group.id)) refreshItemFromIssue(db, item, timestamp);
  return refreshPiRunGroupCompletion(db, group.id);
}

function refreshItemFromIssue(db: RunnerDatabase, item: PiRunGroupItem, timestamp: string): void {
  const issue = getIssue(db, item.issue_id);
  const report = lifecycleReport(issue?.status ?? "");
  if (!issue || !report) return;
  if (item.final_issue_status === issue.status && item.report_reason === issue.error) return;
  updatePiRunGroupItem(db, item.run_group_id, item.issue_id, {
    completed_at: item.completed_at || timestamp,
    final_issue_status: issue.status,
    report_reason: issue.error
  });
}

function dueReason(db: RunnerDatabase, group: PiRunGroup, nowText: string): FlushReason | "" {
  if (group.status === "completed" && !hasDigest(db, group.id, "completed")) return "completed";
  if (group.status === "completed") return "";
  if (deadlineDue(group, nowText) && !hasDigest(db, group.id, "partial_deadline")) {
    return "partial_deadline";
  }
  if (intervalDue(group, nowText)) return "partial_interval";
  return "";
}

function deadlineDue(group: PiRunGroup, nowText: string): boolean {
  const deadline = Date.parse(group.deadline_at);
  const now = Date.parse(nowText);
  return Number.isFinite(deadline) && Number.isFinite(now) && deadline <= now;
}

function intervalDue(group: PiRunGroup, nowText: string): boolean {
  const minutes = group.max_interval_minutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return false;
  const anchor = Date.parse(group.last_digest_at || group.created_at);
  const now = Date.parse(nowText);
  return Number.isFinite(anchor) && Number.isFinite(now) && now - anchor >= minutes * MINUTE_MS;
}

function hasDigest(db: RunnerDatabase, runGroupID: string, reason: FlushReason): boolean {
  return listPiNotificationIntents(db, { kind: "digest", runGroupId: runGroupID })
    .some((intent) => intent.flush_reason === reason);
}

function markCoveredLifecycleIntents(db: RunnerDatabase, runGroupID: string): void {
  for (const intent of listPiNotificationIntents(db, { runGroupId: runGroupID })) {
    if (intent.kind === "digest" || ["aggregated", "sent", "suppressed"].includes(intent.state)) continue;
    updatePiNotificationIntent(db, intent.id, { state: "aggregated" });
  }
}

function digestPayload(runGroupID: string, expectedCount: number, items: PiRunGroupItem[]): DigestPayload {
  const counts = digestCounts(expectedCount, items);
  return {
    active: counts.active,
    active_count: counts.active,
    completed: counts.completed,
    completed_count: counts.completed,
    failed: counts.failed,
    failed_count: counts.failed,
    issues: notableIssues(items),
    needsUser: counts.needsUser,
    needs_user_count: counts.needsUser,
    run_group_id: runGroupID,
    skipped: counts.skipped,
    skipped_count: counts.skipped,
    total: counts.total,
    total_count: counts.total
  };
}

function digestCounts(expectedCount: number, items: PiRunGroupItem[]): DigestCounts {
  const counts: DigestCounts = {
    active: Math.max(expectedCount - items.length, 0),
    completed: 0, failed: 0, needsUser: 0, skipped: 0,
    total: Math.max(expectedCount, items.length)
  };
  for (const item of items) incrementBucket(counts, item.report_bucket);
  return counts;
}

function incrementBucket(counts: DigestCounts, bucket: string): void {
  if (bucket === "done") counts.completed += 1;
  else if (bucket === "failed") counts.failed += 1;
  else if (bucket === "needs_user") counts.needsUser += 1;
  else if (bucket === "skipped") counts.skipped += 1;
  else counts.active += 1;
}

function notableIssues(items: PiRunGroupItem[]): Array<Record<string, number | string>> {
  return items.filter((item) => item.report_bucket !== "done" && item.report_bucket !== "active")
    .map((item) => ({
      bucket: item.report_bucket,
      issue_id: item.issue_id,
      reason: redactSensitiveText(item.report_reason),
      status: item.report_status,
      title: item.issue_title_snapshot
    }));
}

function digestSummary(reason: FlushReason, payload: DigestPayload): string {
  return `run group ${payload.run_group_id} ${reason}: total ${payload.total_count}, ` +
    `done ${payload.completed_count}, failed ${payload.failed_count}, ` +
    `needs_user ${payload.needs_user_count}, ` +
    `active ${payload.active_count}, skipped ${payload.skipped_count}`;
}

function candidateGroups(db: RunnerDatabase, limit: number): PiRunGroup[] {
  return ["active", "partial", "completed"].flatMap((status) => listPiRunGroups(db, { status }))
    .sort((left, right) => left.created_at.localeCompare(right.created_at))
    .slice(0, boundedLimit(limit));
}

function boundedLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, DEFAULT_LIMIT);
}

function iso(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
