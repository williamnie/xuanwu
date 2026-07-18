import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiNotificationIntent,
  readProjectPiPolicy,
  updatePiNotificationIntent,
  type PiNotificationIntent
} from "../db/repositories/pi.ts";
import { resolvePiNotificationPreference } from "../pi/notificationPreferenceResolver.ts";
import { quietHoursResumeAt } from "../schedule/cronSchedule.ts";
import { redactSensitiveText } from "../util/redact.ts";
import {
  queueNotificationOutbox,
  type NotificationOutboxTarget
} from "./notificationOutbox.ts";

export type NotificationRoute = NotificationOutboxTarget & { channel: string };
export type NotificationDecision = "aggregate" | "send_now" | "suppress";

export type UnifiedNotificationInput = {
  approvalActionID?: string;
  content: string;
  conversationID?: string;
  decision?: NotificationDecision;
  deepLink?: string;
  idempotencyKey: string;
  issueID?: number;
  kind: string;
  notificationID?: string;
  notificationType: string;
  now?: Date;
  payload?: Record<string, unknown>;
  projectID?: string;
  requiresUser?: boolean;
  routes: NotificationRoute[];
  runGroupID?: string;
  severity?: string;
  sourceEventID?: string;
  sourceEventSequenceID?: number;
  sourceEventType?: string;
  summary: string;
};

export type UnifiedNotificationRouteResult = {
  decision: NotificationDecision;
  intent: PiNotificationIntent;
  outboxID: number;
  queued: boolean;
  reason: "aggregated" | "channel_filtered" | "duplicate" | "queued" | "suppressed";
  route: NotificationRoute;
};

/**
 * pi_notification_intents is the intent authority. Each channel gets a stable
 * child idempotency key, then all external writes flow through sync_outbox.
 */
export function routeNotification(
  db: RunnerDatabase,
  input: UnifiedNotificationInput
): UnifiedNotificationRouteResult[] {
  const routes = uniqueRoutes(input.routes);
  return routes.map((route) => routeOne(db, normalizeInput(input), route));
}

export function queueExistingNotificationIntent(
  db: RunnerDatabase,
  input: {
    approvalActionID?: string;
    content: string;
    deepLink?: string;
    intent: PiNotificationIntent;
    notificationID?: string;
    notificationType: string;
    route?: NotificationRoute;
  }
): UnifiedNotificationRouteResult {
  const route = input.route ?? routeFromIntent(input.intent);
  const updated = withDeepLink(db, input.intent, input.deepLink);
  if (updated.sent_outbox_id > 0) return duplicateResult(updated, route);
  const queued = queueNotificationOutbox(db, {
    approvalActionID: input.approvalActionID,
    channel: route.channel,
    content: contentWithDeepLink(input.content, input.deepLink),
    issueID: updated.issue_id,
    notificationID: cleanString(input.notificationID) || updated.idempotency_key,
    notificationType: input.notificationType,
    projectID: updated.project_id,
    target: route
  });
  if (!queued.queued) return duplicateResult(updated, route);
  const sent = updatePiNotificationIntent(db, updated.id, {
    error: "",
    sent_at: new Date().toISOString(),
    sent_outbox_id: queued.outboxID,
    state: "sent"
  });
  return {
    decision: decisionValue(sent.decision),
    intent: sent,
    outboxID: queued.outboxID,
    queued: true,
    reason: "queued",
    route
  };
}

function routeOne(
  db: RunnerDatabase,
  input: ReturnType<typeof normalizeInput>,
  route: NotificationRoute
): UnifiedNotificationRouteResult {
  const preference = resolvePiNotificationPreference(db, {
    conversationID: input.conversationID,
    eventSequence: input.sourceEventSequenceID,
    projectID: input.projectID,
    referenceTime: input.now.toISOString(),
    runGroupID: input.runGroupID
  });
  const allowedChannels = preferenceChannels(preference.effective.digest_policy);
  const channelFiltered = allowedChannels.length > 0 && !allowedChannels.includes(route.channel);
  const quietUntil = quietResumeAt(db, input.projectID, input.now);
  const decision = channelFiltered
    ? "suppress"
    : notificationDecision(input, preference.effective.mode, quietUntil);
  const intent = createPiNotificationIntent(db, {
    conversation_id: input.conversationID,
    decision,
    error: channelFiltered ? "channel_filtered_by_preference" : "",
    flush_after_at: decision === "aggregate" ? quietUntil : "",
    idempotency_key: `${input.idempotencyKey}:${route.channel}`,
    issue_id: input.issueID,
    kind: input.kind,
    payload_json: payloadWithDeepLink(input.payload, input.deepLink),
    preference_id: preference.preferenceID,
    project_id: input.projectID,
    ready_at: decision === "send_now" ? input.now.toISOString() : "",
    requires_user: input.requiresUser ? 1 : 0,
    run_group_id: input.runGroupID,
    severity: input.severity,
    source_event_id: input.sourceEventID,
    source_event_sequence_id: input.sourceEventSequenceID,
    source_event_type: input.sourceEventType,
    state: stateForDecision(decision),
    summary: input.summary,
    target_channel: route.channel,
    target_chat_id: route.chatID,
    target_message_id: route.messageID,
    target_thread_id: route.threadID
  });
  if (intent.sent_outbox_id > 0) return duplicateResult(intent, route);
  if (intent.state === "suppressed" || intent.decision === "suppress") {
    const reason = intent.error === "channel_filtered_by_preference" ? "channel_filtered" : "suppressed";
    return noQueueResult(intent, route, reason);
  }
  if (intent.state === "aggregated" || intent.decision === "aggregate") {
    return noQueueResult(intent, route, "aggregated");
  }
  return queueExistingNotificationIntent(db, {
    approvalActionID: input.approvalActionID,
    content: input.content,
    deepLink: input.deepLink,
    intent,
    notificationID: input.notificationID,
    notificationType: input.notificationType,
    route
  });
}

function normalizeInput(input: UnifiedNotificationInput) {
  return {
    approvalActionID: cleanString(input.approvalActionID),
    content: requiredText(redactSensitiveText(input.content), "content"),
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

function notificationDecision(
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

function quietResumeAt(db: RunnerDatabase, projectID: string, now: Date): string {
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

function preferenceChannels(policy: Record<string, unknown>): string[] {
  const value = policy.channels;
  return Array.isArray(value) ? value.map(cleanString).filter(Boolean) : [];
}

function urgentSeverity(value: string): boolean {
  return ["actionable", "budget_exhausted", "needs_user", "pi_unavailable", "unsafe_or_external", "urgent"]
    .includes(value.toLowerCase());
}

function withDeepLink(db: RunnerDatabase, intent: PiNotificationIntent, value: string | undefined): PiNotificationIntent {
  const deepLink = safeDeepLink(value);
  if (deepLink === "") return intent;
  const payload = parseRecord(intent.payload_json);
  if (payload.deep_link === deepLink) return intent;
  return updatePiNotificationIntent(db, intent.id, { payload_json: { ...payload, deep_link: deepLink } });
}

function payloadWithDeepLink(payload: Record<string, unknown>, value: string): Record<string, unknown> {
  return value === "" ? payload : { ...payload, deep_link: value };
}

function contentWithDeepLink(content: string, value: string | undefined): string {
  const link = safeDeepLink(value);
  return link === "" || content.includes(link) ? content : `${content}\n查看：${link}`;
}

function safeDeepLink(value: unknown): string {
  const text = cleanString(value);
  if (text.startsWith("#/") || text.startsWith("/api/")) return text;
  return "";
}

function uniqueRoutes(routes: NotificationRoute[]): NotificationRoute[] {
  const seen = new Set<string>();
  return routes.map(normalizeRoute).filter((route) => {
    const key = [route.channel, route.chatID, route.threadID, route.messageID].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeRoute(route: NotificationRoute): NotificationRoute {
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

function routeFromIntent(intent: PiNotificationIntent): NotificationRoute {
  return normalizeRoute({
    channel: intent.target_channel,
    chatID: intent.target_chat_id,
    messageID: intent.target_message_id,
    threadID: intent.target_thread_id
  });
}

function duplicateResult(intent: PiNotificationIntent, route: NotificationRoute): UnifiedNotificationRouteResult {
  return {
    decision: decisionValue(intent.decision),
    intent,
    outboxID: intent.sent_outbox_id,
    queued: false,
    reason: "duplicate",
    route
  };
}

function noQueueResult(
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

function decisionValue(value: string): NotificationDecision {
  return value === "send_now" || value === "suppress" ? value : "aggregate";
}

function stateForDecision(decision: NotificationDecision): string {
  if (decision === "send_now") return "ready";
  if (decision === "suppress") return "suppressed";
  return "aggregated";
}

function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function requiredText(value: unknown, label: string): string {
  const text = cleanString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}
