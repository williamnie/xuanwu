import type { RunnerDatabase } from "../db/database.ts";
import { createPiNotificationIntent, updatePiNotificationIntent, type PiNotificationIntent } from "../db/repositories/pi.ts";
import { resolvePiNotificationPreference } from "../pi/notifications/notificationPreferenceResolver.ts";
import { alreadyQueuedNotification } from "./notificationOutbox.ts";
import { applyNotificationSpeaker, notificationPresentation } from "./notificationPresentation.ts";
import { cleanString } from "../util/values.ts";
import type { UnifiedNotificationInput, UnifiedNotificationRouteResult, NotificationRoute } from "./unifiedNotificationPipeline.model.ts";
import { uniqueRoutes, routeFromIntent, withDeepLink, duplicateResult, noQueueResult, contentWithDeepLink, decisionValue, preferenceChannels, quietResumeAt, notificationDecision, payloadWithDeepLink, stateForDecision, parseRecord } from "./unifiedNotificationPipeline.presentation.ts";
import { normalizeInput } from "./unifiedNotificationPipeline.presentation.ts";

/**
 * pi_notification_intents is the intent authority. Each channel gets a stable
 * child idempotency key, then all external writes flow through sync_outbox.
 */
export function routeNotification(
  db: RunnerDatabase,
  input: UnifiedNotificationInput
): UnifiedNotificationRouteResult[] {
  const routes = uniqueRoutes(input.routes);
  const normalized = normalizeInput(db, input);
  return routes.map((route) => routeOne(db, normalized, route));
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
  if (updated.state === "agent_pending") return duplicateResult(updated, route);
  if (updated.state === "suppressed") {
    return noQueueResult(updated, route, "suppressed");
  }
  if (updated.state === "aggregated") {
    return noQueueResult(updated, route, "aggregated");
  }
  if (alreadyQueuedNotification(
    db,
    route.channel,
    input.notificationType,
    cleanString(input.notificationID) || updated.idempotency_key
  )) {
    const duplicate = updatePiNotificationIntent(db, updated.id, {
      decision: "suppress",
      error: "duplicate_notification_link",
      state: "suppressed"
    });
    return duplicateResult(duplicate, route);
  }
  const pending = stageAgentCommunication(db, updated, {
    approvalActionID: input.approvalActionID,
    content: applyNotificationSpeaker(
      contentWithDeepLink(input.content, input.deepLink),
      notificationPresentation(db)
    ),
    notificationID: cleanString(input.notificationID) || updated.idempotency_key,
    notificationType: input.notificationType,
    route
  });
  return {
    decision: decisionValue(pending.decision),
    intent: pending,
    outboxID: 0,
    queued: true,
    reason: "agent_pending",
    route
  };
}

export function routeOne(
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

export function stageAgentCommunication(
  db: RunnerDatabase,
  intent: PiNotificationIntent,
  input: {
    approvalActionID?: string;
    content: string;
    notificationID: string;
    notificationType: string;
    route: NotificationRoute;
  }
): PiNotificationIntent {
  const payload = parseRecord(intent.payload_json);
  return updatePiNotificationIntent(db, intent.id, {
    error: "",
    payload_json: {
      ...payload,
      agent_communication: {
        approval_action_id: cleanString(input.approvalActionID),
        content_seed: input.content,
        notification_id: input.notificationID,
        notification_type: input.notificationType,
        route: input.route
      }
    },
    state: "agent_pending"
  });
}
