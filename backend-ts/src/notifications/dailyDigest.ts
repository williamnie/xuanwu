import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import {
  getPiNotificationPreference,
  listPiNotificationIntents,
  readProjectPiPolicy,
  updatePiNotificationIntent,
  type PiNotificationIntent
} from "../db/repositories/pi.ts";
import { quietHoursResumeAt } from "../schedule/cronSchedule.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { routeNotification, type NotificationRoute } from "./unifiedNotificationPipeline.ts";

export type DailyDigestResult = {
  aggregated: number;
  failed: number;
  queued: number;
  scanned: number;
  skipped: number;
};

type DigestCandidate = {
  dailyAt: string;
  intent: PiNotificationIntent;
  route: NotificationRoute;
  timezone: string;
};

const DEFAULT_DAILY_AT = "09:00";
const DAILY_DIGEST_TYPE = "notification_daily_digest";

/**
 * Aggregates ungrouped intents deferred by digest preferences or project quiet
 * hours. Run-group digests retain their existing scheduler and are excluded.
 */
export function queueDailyNotificationDigests(
  db: RunnerDatabase,
  options: { now?: Date } = {}
): DailyDigestResult {
  const now = options.now ?? new Date();
  const candidates = dailyCandidates(db, now);
  const result: DailyDigestResult = {
    aggregated: 0,
    failed: 0,
    queued: 0,
    scanned: candidates.length,
    skipped: 0
  };
  for (const group of groupedCandidates(candidates)) {
    try {
      const queued = queueDigestGroup(db, group, now);
      if (!queued) result.skipped += group.length;
      else {
        result.aggregated += group.length;
        result.queued += 1;
      }
    } catch {
      result.failed += group.length;
    }
  }
  return result;
}

function dailyCandidates(db: RunnerDatabase, now: Date): DigestCandidate[] {
  return listPiNotificationIntents(db, { state: "aggregated" })
    .filter((intent) => intent.run_group_id === "" && intent.kind !== "daily_digest")
    .map((intent) => candidate(db, intent))
    .filter((item): item is DigestCandidate => item !== null)
    .filter((item) => dueForDailyDigest(item, now));
}

function candidate(db: RunnerDatabase, intent: PiNotificationIntent): DigestCandidate | null {
  if (intent.target_channel === "") return null;
  if (intent.target_chat_id === "" && intent.target_thread_id === "" && intent.target_message_id === "") return null;
  const policy = readProjectPiPolicy(db, intent.project_id);
  const preference = getPiNotificationPreference(db, intent.preference_id);
  const digestPolicy = parseRecord(preference?.digest_policy_json ?? "{}");
  return {
    dailyAt: validTime(digestPolicy.daily_at) || DEFAULT_DAILY_AT,
    intent,
    route: {
      channel: intent.target_channel,
      chatID: intent.target_chat_id,
      messageID: intent.target_message_id,
      threadID: intent.target_thread_id
    },
    timezone: policy.timezone
  };
}

function dueForDailyDigest(candidate: DigestCandidate, now: Date): boolean {
  const intent = candidate.intent;
  if (Date.parse(intent.created_at) > now.getTime()) return false;
  if (intent.flush_after_at !== "" && Date.parse(intent.flush_after_at) > now.getTime()) return false;
  const localNow = localStamp(now, candidate.timezone);
  if (localNow.time < candidate.dailyAt) return false;
  const created = localStamp(new Date(intent.created_at), candidate.timezone);
  return created.date < localNow.date || (created.date === localNow.date && created.time <= candidate.dailyAt);
}

function groupedCandidates(candidates: DigestCandidate[]): DigestCandidate[][] {
  const groups = new Map<string, DigestCandidate[]>();
  for (const item of candidates) {
    const key = [
      item.intent.project_id,
      item.route.channel,
      item.route.chatID,
      item.route.threadID,
      item.route.messageID,
      item.timezone,
      item.dailyAt
    ].join("\0");
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function queueDigestGroup(db: RunnerDatabase, group: DigestCandidate[], now: Date): boolean {
  const first = group[0];
  if (!first) return false;
  const policy = readProjectPiPolicy(db, first.intent.project_id);
  const quietUntil = quietHoursResumeAt({
    mode: "daily",
    next_run_at: now.toISOString(),
    quiet_hours_json: policy.quiet_hours_json,
    time_of_day: first.dailyAt,
    timezone: policy.timezone
  }, now);
  if (quietUntil !== "") return false;
  const bucket = localStamp(now, first.timezone).date;
  const routeKey = createHash("sha256").update(routeIdentity(first.route)).digest("hex").slice(0, 16);
  const idempotencyKey = `daily_digest:${first.intent.project_id}:${bucket}:${first.dailyAt}:${routeKey}`;
  const payload = digestPayload(group.map((item) => item.intent), bucket);
  const routed = routeNotification(db, {
    content: formatDailyDigest(payload),
    decision: "send_now",
    deepLink: "#/automations",
    idempotencyKey,
    kind: "daily_digest",
    notificationType: DAILY_DIGEST_TYPE,
    now,
    payload,
    projectID: first.intent.project_id,
    routes: [first.route],
    severity: "info",
    sourceEventID: idempotencyKey,
    sourceEventType: "notification.daily_digest",
    summary: `Daily Digest ${bucket}: ${group.length} notification intents`
  })[0];
  if (!routed || routed.outboxID <= 0) return false;
  for (const item of group) {
    updatePiNotificationIntent(db, item.intent.id, {
      error: "",
      sent_at: now.toISOString(),
      sent_outbox_id: routed.outboxID,
      state: "sent"
    });
  }
  return true;
}

function digestPayload(intents: PiNotificationIntent[], bucket: string): Record<string, unknown> {
  const counts: Record<string, number> = {};
  const items = intents.map((intent) => {
    counts[intent.kind] = (counts[intent.kind] ?? 0) + 1;
    return {
      deep_link: intentDeepLink(intent),
      issue_id: intent.issue_id,
      kind: intent.kind,
      summary: redactSensitiveText(intent.summary)
    };
  });
  return { bucket, counts, intent_ids: intents.map((intent) => intent.id), items, total: intents.length };
}

function formatDailyDigest(payload: Record<string, unknown>): string {
  const items = Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : [];
  return [
    `Daily Digest · ${cleanString(payload.bucket)} · ${positiveInteger(payload.total)} 条`,
    ...items.slice(0, 20).map((item) => {
      const link = safeDeepLink(item.deep_link);
      const suffix = link === "" ? "" : ` · ${link}`;
      return `- ${cleanString(item.kind)}：${redactSensitiveText(cleanString(item.summary))}${suffix}`;
    })
  ].join("\n");
}

function intentDeepLink(intent: PiNotificationIntent): string {
  const payload = parseRecord(intent.payload_json);
  return safeDeepLink(payload.deep_link) || (intent.issue_id > 0 ? `/api/issues/${intent.issue_id}` : "");
}

function routeIdentity(route: NotificationRoute): string {
  return [route.channel, route.chatID, route.threadID, route.messageID].map(cleanString).join("\0");
}

function localStamp(date: Date, timezone: string): { date: string; time: string } {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric"
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  };
}

function validTime(value: unknown): string {
  const text = cleanString(value);
  return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(text) ? text : "";
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function safeDeepLink(value: unknown): string {
  const text = cleanString(value);
  return text.startsWith("#/") || text.startsWith("/api/") ? text : "";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
