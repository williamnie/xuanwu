import { type PiNotificationIntent } from "../db/repositories/pi.ts";
import { type NotificationOutboxTarget } from "./notificationOutbox.ts";

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
  reason: "agent_pending" | "aggregated" | "channel_filtered" | "duplicate" | "queued" | "suppressed";
  route: NotificationRoute;
};
