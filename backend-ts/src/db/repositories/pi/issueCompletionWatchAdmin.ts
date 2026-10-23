import { type SyncOutboxRecord } from "../imReplyOutbox.ts";
import { type PiNotificationIntent } from "./notificationIntents.ts";
export type PiIssueCompletionWatchNotification = {
  intent: PiNotificationIntent;
  outbox: SyncOutboxRecord | null;
};
