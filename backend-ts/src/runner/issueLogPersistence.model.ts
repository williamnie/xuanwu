import type { ProviderEvent } from "../providers/types.ts";

export const ISSUE_LOG_CHUNK_EVENT_LIMIT = 64;

export const ISSUE_LOG_CHUNK_TEXT_BYTES = 32 * 1024;

export const ISSUE_LOG_DELTA_ROWS_PER_METHOD = 64;

export const ISSUE_LOG_DELTA_TEXT_BYTES_PER_METHOD = 2 * 1024 * 1024;

export const ISSUE_LOG_SAMPLE_ROWS_PER_METHOD = 64;

export const ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE = 256;

export const ISSUE_LOG_PROTECTED_ROWS_PER_METHOD = 1024;

export const ISSUE_LOG_BUDGET_MARKER_METHOD = "runner/issueLogBudget/truncated";

export const TOOL_OBSERVATION_SCHEMA_VERSION = "xw.tool-observation.v1" as const;

export const RUN_COST_OBSERVATION_SCHEMA_VERSION = "xw.run-cost-observation.v1" as const;

export const CHUNK_IDLE_FLUSH_MS = 100;

export const SAMPLE_IDLE_FLUSH_MS = 2_000;

export const TOOL_COMMAND_BYTES = 4 * 1024;

export const TOOL_CWD_BYTES = 1_000;

export const TOOL_OUTPUT_BYTES = 1_200;

export const SAMPLE_INTERVALS = new Map<string, number>([
  ["turn/diff/updated", 16],
  ["thread/tokenUsage/updated", 20],
  ["turn/plan/updated", 10],
  ["turn/taskProgress/updated", 10]
]);

export const CHUNK_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta"
]);

export type EventWriter = (event: ProviderEvent) => void;

export type PendingChunk = {
  bytes: number;
  count: number;
  event: ProviderEvent;
  key: string;
  method: string;
  text: string;
};

export type PendingSample = { event: ProviderEvent; fingerprint: string; sequence: number };

export type SampleState = {
  interval: number;
  lastPersistedFingerprint: string;
  pending?: PendingSample;
  persisted: number;
  seen: number;
};

export type DeltaBudget = { omittedBytes: number; omittedEvents: number; rows: number; textBytes: number };

export type SampleBudget = { omittedEvents: number; rows: number };

export type DirectBudget = { markerWritten: boolean; omittedEvents: number; rows: number };

export type IssueLogPersistence = {
  flush(): void;
  push(event: ProviderEvent): void;
};

export type IssueLogMode = "debug" | "normal";
