import type { RunnerDatabase } from "../db/database.ts";
import {
  getEventSummaryProjectionSwitch,
  projectPendingCompactEventSummaries
} from "../db/repositories/compactEventSummaryProjection.ts";
import { projectPendingEventSummaries } from "./eventSummaryProjector.ts";
import { redactSensitiveText } from "../util/redact.ts";

export const BACKGROUND_PROJECTION_POLICY = {
  batch_size: 100,
  backpressure_delay_ms: 25,
  idle_delay_ms: 1000,
  max_wall_ms: 100,
  projection_id: "issue_events_summary",
  source_of_truth: "issue_events"
} as const;

export type ProjectionWorkerSnapshot = {
  backpressure: boolean;
  completed_batches: number;
  completed_rows: number;
  error: string;
  last_completed_at: string;
  last_duration_ms: number;
  paused: boolean;
  running: boolean;
};

export class BackgroundProjectionWorker {
  readonly #database: RunnerDatabase;
  readonly #delayMs: number;
  readonly #maxWallMs: number;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = true;
  #snapshot: ProjectionWorkerSnapshot = {
    backpressure: false,
    completed_batches: 0,
    completed_rows: 0,
    error: "",
    last_completed_at: "",
    last_duration_ms: 0,
    paused: false,
    running: false
  };

  constructor(database: RunnerDatabase, options: { delayMs?: number; maxWallMs?: number } = {}) {
    if (database.readonly) throw new Error("background projection worker requires the Core writer connection");
    this.#database = database;
    this.#delayMs = positiveInteger(options.delayMs ?? BACKGROUND_PROJECTION_POLICY.idle_delay_ms, "delayMs");
    this.#maxWallMs = positiveInteger(options.maxWallMs ?? BACKGROUND_PROJECTION_POLICY.max_wall_ms, "maxWallMs");
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#schedule(0);
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  pause(): void {
    this.#snapshot.paused = true;
  }

  resume(): void {
    this.#snapshot.paused = false;
    if (!this.#stopped && !this.#timer && !this.#snapshot.running) this.#schedule(0);
  }

  snapshot(): ProjectionWorkerSnapshot {
    return { ...this.#snapshot };
  }

  runOnce(): ProjectionWorkerSnapshot {
    if (this.#snapshot.running || this.#snapshot.paused) return this.snapshot();
    const started = performance.now();
    this.#snapshot.running = true;
    this.#snapshot.error = "";
    try {
      const legacy = projectPendingEventSummaries(this.#database, {
        batchSize: BACKGROUND_PROJECTION_POLICY.batch_size,
        maxBatches: 1
      });
      let batches = legacy.batches;
      let rows = legacy.projected_rows;
      let backpressure = legacy.paused;
      if (performance.now() - started < this.#maxWallMs) {
        const state = getEventSummaryProjectionSwitch(this.#database);
        if (state.read_version === "v2" || state.observation_started_at) {
          const compact = projectPendingCompactEventSummaries(this.#database, {
            batchSize: BACKGROUND_PROJECTION_POLICY.batch_size,
            maxBatches: 1
          });
          batches += compact.batches;
          rows += compact.projected_rows;
          backpressure ||= compact.paused;
        }
      } else {
        backpressure = true;
      }
      this.#snapshot.completed_batches += batches;
      this.#snapshot.completed_rows += rows;
      this.#snapshot.backpressure = backpressure;
      this.#snapshot.last_completed_at = new Date().toISOString();
    } catch (error) {
      this.#snapshot.backpressure = true;
      this.#snapshot.error = boundedError(error);
    } finally {
      this.#snapshot.last_duration_ms = Math.round((performance.now() - started) * 1000) / 1000;
      this.#snapshot.running = false;
    }
    return this.snapshot();
  }

  #schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#stopped) return;
      this.runOnce();
      this.#schedule(this.#snapshot.backpressure ? BACKGROUND_PROJECTION_POLICY.backpressure_delay_ms : this.#delayMs);
    }, delay);
  }
}

function boundedError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error)).slice(0, 240);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
