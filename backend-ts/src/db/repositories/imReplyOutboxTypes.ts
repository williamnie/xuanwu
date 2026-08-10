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
  correlation_id: string;
  dedupe_key: string;
  /**
   * Compatibility carrier only: the authoritative delivery receipt for
   * `operation_kind='im_reply'` rows is `provider_request_ref` + `result_json`.
   * New sends keep dual-writing this column during the bounded W1 window so
   * legacy readers keep working; no production decision may read it first.
   */
  feishu_message_id: string;
  last_error: string;
  max_attempts: number;
  operation_kind: string;
  payload_json: string;
  /** Authoritative provider-neutral receipt reference (W1 cutover). */
  provider_request_ref: string;
  reply_draft_id: number;
  /** Bounded `xuanwu.im-delivery-receipt.v1` JSON for im_reply rows. */
  result_json: string;
  retry_after_seconds: number;
  sent_at: string;
};

export type ImReplyDraftInput = Partial<Omit<ImReplyDraftRecord, "created_at" | "id" | "updated_at">>;
export type ImReplyDraftFilter = { source?: string; status?: string };
export type SQLValue = number | string;
