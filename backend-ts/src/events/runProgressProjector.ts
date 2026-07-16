import type {
  NormalizedRunEvent,
  NormalizedRunEventKind,
  NormalizedRunEventOutcome
} from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";

export const RUN_PROGRESS_PROJECTOR_VERSION = "xuanwu.run-progress-projector.v1" as const;
export const RUN_PROGRESS_TIMELINE_LIMIT = 64;

export type RunProgressPhase =
  | "queued"
  | "starting"
  | "running"
  | "waiting_approval"
  | "recovering"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "unknown";

export type RunProgressSourceEvent = {
  attempt_id: string;
  attempt_sequence: number;
  event: NormalizedRunEvent;
  occurred_at: string;
  source_event_id: number;
  summary: string;
};

export type RunProgressLatest = {
  attempt_id: string;
  attempt_sequence: number;
  kind: NormalizedRunEventKind;
  occurred_at: string;
  outcome: NormalizedRunEventOutcome;
  phase: RunProgressPhase;
  source_event_id: number;
  source_ref: string;
  summary: string;
};

export type RunProgressPhaseSummary = {
  attempt_id: string;
  attempt_sequence: number;
  event_count: number;
  first_event_id: number;
  first_occurred_at: string;
  last_event_id: number;
  last_occurred_at: string;
  phase: RunProgressPhase;
};

export type RunProgressTimelineItem = RunProgressLatest & {
  event_count: number;
  first_event_id: number;
  first_occurred_at: string;
};

export type AttemptProgressProjection = {
  current_phase: RunProgressPhase;
  duplicate_event_count: number;
  ignored_event_count: number;
  latest: RunProgressLatest | null;
  phase_summary: RunProgressPhaseSummary[];
  projected_by: typeof RUN_PROGRESS_PROJECTOR_VERSION;
  source_event_count: number;
  timeline: RunProgressTimelineItem[];
  timeline_truncated: number;
  unique_event_count: number;
};

export function projectRunAttemptProgress(input: {
  events: readonly RunProgressSourceEvent[];
  initialPhase: RunProgressPhase;
  timelineLimit?: number;
}): AttemptProgressProjection {
  const events = [...input.events].sort(compareEvent);
  const timelineLimit = nonNegativeInteger(input.timelineLimit ?? RUN_PROGRESS_TIMELINE_LIMIT, "timelineLimit");
  const seen = new Set<string>();
  const phases = new Map<string, RunProgressPhaseSummary>();
  const timeline: RunProgressTimelineItem[] = [];
  let currentPhase = input.initialPhase;
  let duplicateEventCount = 0;
  let ignoredEventCount = 0;
  let latest: RunProgressLatest | null = null;

  for (const source of events) {
    const key = eventFingerprint(source);
    if (seen.has(key)) {
      duplicateEventCount += 1;
      continue;
    }
    seen.add(key);
    const nextPhase = eventPhase(currentPhase, source.event);
    if (nextPhase === null) {
      ignoredEventCount += 1;
      continue;
    }
    currentPhase = nextPhase;
    latest = latestProgress(source, currentPhase);
    addPhaseSummary(phases, latest);
    addTimelineItem(timeline, latest);
  }

  const truncated = Math.max(0, timeline.length - timelineLimit);
  return {
    current_phase: currentPhase,
    duplicate_event_count: duplicateEventCount,
    ignored_event_count: ignoredEventCount,
    latest,
    phase_summary: [...phases.values()],
    projected_by: RUN_PROGRESS_PROJECTOR_VERSION,
    source_event_count: events.length,
    timeline: timelineLimit === 0 ? [] : timeline.slice(-timelineLimit),
    timeline_truncated: truncated,
    unique_event_count: seen.size
  };
}

function eventPhase(current: RunProgressPhase, event: NormalizedRunEvent): RunProgressPhase | null {
  if (terminalPhase(current)) return terminalEventPhase(event) === current ? current : null;
  const terminal = terminalEventPhase(event);
  if (terminal) return terminal;
  if (event.kind === "unknown") return null;
  if (event.kind === "approval_requested") return "waiting_approval";
  if (event.kind === "approval_resolved") return "running";
  if (event.kind === "started") return current === "queued" || current === "unknown" ? "starting" : current;
  if (event.kind === "progress") return current === "waiting_approval" ? current : "running";
  return current;
}

function terminalEventPhase(event: NormalizedRunEvent): RunProgressPhase | null {
  if (!event.terminal) return null;
  if (["succeeded", "failed", "cancelled", "interrupted"].includes(event.outcome)) {
    return event.outcome as RunProgressPhase;
  }
  return null;
}

function terminalPhase(phase: RunProgressPhase): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(phase);
}

function latestProgress(source: RunProgressSourceEvent, phase: RunProgressPhase): RunProgressLatest {
  return {
    attempt_id: source.attempt_id,
    attempt_sequence: source.attempt_sequence,
    kind: source.event.kind,
    occurred_at: source.occurred_at,
    outcome: source.event.outcome,
    phase,
    source_event_id: source.source_event_id,
    source_ref: source.event.source.ref,
    summary: boundedSummary(source.summary || source.event.source.method)
  };
}

function addPhaseSummary(phases: Map<string, RunProgressPhaseSummary>, latest: RunProgressLatest): void {
  const key = `${latest.attempt_id}\u0000${latest.phase}`;
  const existing = phases.get(key);
  if (!existing) {
    phases.set(key, {
      attempt_id: latest.attempt_id,
      attempt_sequence: latest.attempt_sequence,
      event_count: 1,
      first_event_id: latest.source_event_id,
      first_occurred_at: latest.occurred_at,
      last_event_id: latest.source_event_id,
      last_occurred_at: latest.occurred_at,
      phase: latest.phase
    });
    return;
  }
  existing.event_count += 1;
  existing.last_event_id = latest.source_event_id;
  existing.last_occurred_at = latest.occurred_at;
}

function addTimelineItem(timeline: RunProgressTimelineItem[], latest: RunProgressLatest): void {
  const previous = timeline.at(-1);
  if (previous && previous.attempt_id === latest.attempt_id && previous.phase === latest.phase) {
    previous.event_count += 1;
    previous.kind = latest.kind;
    previous.occurred_at = latest.occurred_at;
    previous.outcome = latest.outcome;
    previous.source_event_id = latest.source_event_id;
    previous.source_ref = latest.source_ref;
    previous.summary = latest.summary;
    return;
  }
  timeline.push({
    ...latest,
    event_count: 1,
    first_event_id: latest.source_event_id,
    first_occurred_at: latest.occurred_at
  });
}

function eventFingerprint(source: RunProgressSourceEvent): string {
  return JSON.stringify([
    source.attempt_id,
    source.event.provider,
    source.event.kind,
    source.event.outcome,
    source.event.terminal,
    source.event.retryable ?? null,
    source.event.source.method,
    source.event.source.ref,
    Object.entries(source.event.metadata).sort(([left], [right]) => left.localeCompare(right)),
    source.event.cost ?? null,
    source.event.unknown ?? null,
    boundedSummary(source.summary)
  ]);
}

function compareEvent(left: RunProgressSourceEvent, right: RunProgressSourceEvent): number {
  const time = timestamp(left.occurred_at) - timestamp(right.occurred_at);
  if (time !== 0) return time;
  return left.source_event_id - right.source_event_id;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function boundedSummary(value: string): string {
  const redacted = redactSensitiveText(value.trim()).replace(/\s+/g, " ");
  return redacted.length <= 240 ? redacted : `${redacted.slice(0, 237)}...`;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
