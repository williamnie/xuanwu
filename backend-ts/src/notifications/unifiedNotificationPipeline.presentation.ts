import type { RunnerDatabase } from "../db/database.ts";
import { readProjectPiPolicy, updatePiNotificationIntent, type PiNotificationIntent } from "../db/repositories/pi.ts";
import { quietHoursResumeAt } from "../schedule/cronSchedule.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { applyNotificationSpeaker, notificationPresentation } from "./notificationPresentation.ts";
import { cleanString, positiveInteger } from "../util/values.ts";
import type { UnifiedNotificationInput, NotificationDecision, NotificationRoute, UnifiedNotificationRouteResult } from "./unifiedNotificationPipeline.model.ts";

export function normalizeInput(db: RunnerDatabase, input: UnifiedNotificationInput) {
  const presentation = notificationPresentation(db);
  return {
    approvalActionID: cleanString(input.approvalActionID),
    content: applyNotificationSpeaker(
      requiredText(redactSensitiveText(input.content), "content"),
      presentation
    ),
    conversationID: cleanString(input.conversationID),
    decision: input.decision,
    deepLink: safeDeepLink(input.deepLink),
    idempotencyKey: requiredText(input.idempotencyKey, "idempotencyKey"),
    issueID: positiveInteger(input.issueID),
    kind: requiredText(input.kind, "kind"),
    notificationID: cleanString(input.notificationID),
    notificationType: requiredText(input.notificationType, "notificationType"),
    now: input.now ?? new Date(),
    payload: input.payload ?? {},
    projectID: cleanString(input.projectID),
    requiresUser: input.requiresUser === true,
    runGroupID: cleanString(input.runGroupID),
    severity: cleanString(input.severity) || "info",
    sourceEventID: cleanString(input.sourceEventID),
    sourceEventSequenceID: positiveInteger(input.sourceEventSequenceID),
    sourceEventType: cleanString(input.sourceEventType),
    summary: requiredText(redactSensitiveText(input.summary), "summary")
  };
}

export function notificationDecision(
  input: ReturnType<typeof normalizeInput>,
  preferenceMode: string,
  quietUntil: string
): NotificationDecision {
  if (input.requiresUser || urgentSeverity(input.severity)) return "send_now";
  if (quietUntil !== "") return "aggregate";
  if (input.decision) return input.decision;
  if (preferenceMode === "quiet" || preferenceMode === "digest") return "aggregate";
  return "send_now";
}

export function quietResumeAt(db: RunnerDatabase, projectID: string, now: Date): string {
  if (projectID === "") return "";
  const policy = readProjectPiPolicy(db, projectID);
  return quietHoursResumeAt({
    mode: "daily",
    next_run_at: now.toISOString(),
    quiet_hours_json: policy.quiet_hours_json,
    time_of_day: "00:00",
    timezone: policy.timezone
  }, now);
}

export function preferenceChannels(policy: Record<string, unknown>): string[] {
  const value = policy.channels;
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

export function urgentSeverity(value: string): boolean {
  return ["actionable", "budget_exhausted", "needs_user", "pi_unavailable", "unsafe_or_external", "urgent"]
    .includes(value.toLowerCase());
}

export function withDeepLink(db: RunnerDatabase, intent: PiNotificationIntent, value: string | undefined): PiNotificationIntent {
  const deepLink = safeDeepLink(value);
  if (deepLink === "") return intent;
  const payload = parseRecord(intent.payload_json);
  if (payload.deep_link === deepLink) return intent;
  return updatePiNotificationIntent(db, intent.id, { payload_json: { ...payload, deep_link: deepLink } });
}

export function payloadWithDeepLink(payload: Record<string, unknown>, value: string): Record<string, unknown> {
  return value === "" ? payload : { ...payload, deep_link: value };
}

export function contentWithDeepLink(content: string, value: string | undefined): string {
  const link = safeDeepLink(value);
  return link === "" || content.includes(link) ? content : `${content}\n查看：${link}`;
}

export function safeDeepLink(value: unknown): string {
  const text = cleanString(value);
  if (text.startsWith("#/") || text.startsWith("/api/")) return text;
  return "";
}

export function uniqueRoutes(routes: NotificationRoute[]): NotificationRoute[] {
  const seen = new Set<string>();
  return routes.map(normalizeRoute).filter((route) => {
    const key = [route.channel, route.chatID, route.threadID, route.messageID].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function normalizeRoute(route: NotificationRoute): NotificationRoute {
  const normalized = {
    channel: requiredText(route.channel, "route.channel"),
    chatID: cleanString(route.chatID),
    eventID: positiveInteger(route.eventID),
    messageID: cleanString(route.messageID),
    threadID: cleanString(route.threadID)
  };
  if (normalized.chatID === "" && normalized.threadID === "" && normalized.messageID === "") {
    throw new Error(`notification route ${normalized.channel} requires a target`);
  }
  return normalized;
}

export function routeFromIntent(intent: PiNotificationIntent): NotificationRoute {
  return normalizeRoute({
    channel: intent.target_channel,
    chatID: intent.target_chat_id,
    messageID: intent.target_message_id,
    threadID: intent.target_thread_id
  });
}

export function duplicateResult(intent: PiNotificationIntent, route: NotificationRoute): UnifiedNotificationRouteResult {
  return {
    decision: decisionValue(intent.decision),
    intent,
    outboxID: intent.sent_outbox_id,
    queued: false,
    reason: "duplicate",
    route
  };
}

export function noQueueResult(
  intent: PiNotificationIntent,
  route: NotificationRoute,
  reason: "aggregated" | "channel_filtered" | "suppressed"
): UnifiedNotificationRouteResult {
  return {
    decision: decisionValue(intent.decision),
    intent,
    outboxID: 0,
    queued: false,
    reason,
    route
  };
}

export function decisionValue(value: string): NotificationDecision {
  return value === "send_now" || value === "suppress" ? value : "aggregate";
}

export function stateForDecision(decision: NotificationDecision): string {
  if (decision === "send_now") return "ready";
  if (decision === "suppress") return "suppressed";
  return "aggregated";
}

export function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function requiredText(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
