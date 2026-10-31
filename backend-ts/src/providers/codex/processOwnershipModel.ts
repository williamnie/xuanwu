import { sleep } from "./processOwnershipInspection.ts";

export const CODEX_PROCESS_OWNERSHIP_CONTRACT = "codex-process-group-ownership.v1" as const;

export const DEFAULT_CODEX_PROCESS_STOP_GRACE_MS = 1_000;

export const DEFAULT_CODEX_PROCESS_MIN_SCAN_INTERVAL_MS = 1_000;

export const PROCESS_TABLE_MAX_BYTES = 8 * 1024 * 1024;

export const PROCESS_TABLE_TIMEOUT_MS = 5_000;

export type ProcessSignal = "SIGKILL" | "SIGTERM";

export type ProcessTreeEntry = { command: string; pgid: number; pid: number; ppid: number; rss_bytes: number };

export type ProcessInspectionFailureReason = "exit_nonzero" | "output_too_large" | "parse_failed" | "spawn_failed";

export type ProcessInspectionResult =
  | { ok: true; rows: ProcessTreeEntry[] }
  | { ok: false; reason_code: ProcessInspectionFailureReason };

export type ProcessRefreshMode = "coalesced" | "force";

export type ProcessRefreshOptions = { mode?: ProcessRefreshMode; reason?: string };

export type ProcessLifecycleMetrics = {
  last_scan_age_ms: number;
  ownership_persisted_total: number;
  scan_executed_total: number;
  scan_failed_total: Record<ProcessInspectionFailureReason, number>;
  scan_requested_total: Record<string, number>;
  scan_throttled_total: number;
  scan_unchanged_total: number;
};

export type CodexProcessOwnership = {
  command: string[];
  contract: typeof CODEX_PROCESS_OWNERSHIP_CONTRACT;
  observed_at: string;
  processes: ProcessTreeEntry[];
  root_pgid: number;
  root_pid: number;
  runner_pid: number;
  started_at: string;
};

export type StaleProcessReconciliation = {
  action: "killed" | "none" | "ownership_mismatch" | "scan_failed";
  killed_process_groups: number[];
  ownership_file: string;
  stale_root_pid: number;
};

export type OwnedProcess = { exited: Promise<number>; kill(signal?: string | number): unknown; pid?: number };

export type Inspector = () => ProcessInspectionResult | ProcessTreeEntry[] | Promise<ProcessInspectionResult | ProcessTreeEntry[]>;

export type ProcessLifecycleOptions = {
  inspect?: Inspector;
  minScanIntervalMs?: number;
  monotonicNow?: () => number;
  now?: () => Date;
  onDiagnostic?: (input: { reason_code: ProcessInspectionFailureReason; reason: string }) => void;
  runnerPid?: number;
  signalGroup?: (pgid: number, signal: ProcessSignal) => void;
  sleep?: (ms: number) => Promise<void>;
  stopGraceMs?: number;
};

export type RefreshOperation = { generation: number; phase: "queued" | "scanning"; promise: Promise<void>; rootPID: number };
