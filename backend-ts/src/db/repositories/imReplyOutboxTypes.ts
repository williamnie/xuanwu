export type ImReplyDraftRecord = {
  approval_action_id: string;
  content: string;
  created_at: string;
  created_by: string;
  external_event_id: number;
  id: number;
  issue_id: number;
  rejection_reason: string;
  risk: string;
  source: string;
  status: string;
  target_chat_id: string;
  target_message_id: string;
  target_thread_id: string;
  updated_at: string;
};

export type SyncOutboxRecord = Omit<ImReplyDraftRecord, "rejection_reason"> & {
  attempt_count: number;
  cooldown_until: string;
  feishu_message_id: string;
  last_error: string;
  max_attempts: number;
  reply_draft_id: number;
  retry_after_seconds: number;
  sent_at: string;
};

export type ImReplyDraftInput = Partial<Omit<ImReplyDraftRecord, "created_at" | "id" | "updated_at">>;
export type ImReplyDraftFilter = { source?: string; status?: string };
export type SQLValue = number | string;
