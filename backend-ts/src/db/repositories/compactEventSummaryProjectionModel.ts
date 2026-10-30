export const COMPACT_EVENT_SUMMARY_PROJECTION_ID = "issue_events_summary_v2";

export const COMPACT_EVENT_SUMMARY_PROJECTOR_VERSION = "xuanwu.event-summary-projector.v2";

export const SWITCH_ID = "issue_events_summary";

export const DEFAULT_BATCH_SIZE = 500;

export type EventSummaryProjectionSwitch = {
  cutover_at: string;
  observation_expires_at: string;
  observation_started_at: string;
  read_version: "v1" | "v2";
  revision: number;
  updated_at: string;
};

export type CompactRow = {
  created_at: string;
  event_type: string;
  issue_id: number;
  payload_codec: number;
  payload_ref: number;
  project_id: string;
  run_id: string;
  source_event_id: number;
  source_payload_bytes: number;
  source_sha256: Uint8Array;
  summary_payload: Uint8Array;
};
