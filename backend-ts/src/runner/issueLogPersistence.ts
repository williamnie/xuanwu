import type { ProviderEvent } from "../providers/types.ts";

export const ISSUE_LOG_CHUNK_EVENT_LIMIT = 64;
export const ISSUE_LOG_CHUNK_TEXT_BYTES = 32 * 1024;

const CHUNK_IDLE_FLUSH_MS = 100;
const SAMPLE_IDLE_FLUSH_MS = 2_000;
const SAMPLE_INTERVALS = new Map<string, number>([
  ["turn/diff/updated", 16],
  ["thread/tokenUsage/updated", 20],
  ["turn/plan/updated", 10],
  ["turn/taskProgress/updated", 10]
]);
const CHUNK_METHODS = new Set([
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta"
]);

type EventWriter = (event: ProviderEvent) => void;
type PendingChunk = {
  bytes: number;
  count: number;
  event: ProviderEvent;
  key: string;
  text: string;
};
type PendingSample = { event: ProviderEvent; fingerprint: string; sequence: number };
type SampleState = {
  interval: number;
  lastPersistedFingerprint: string;
  pending?: PendingSample;
  seen: number;
};

export type IssueLogPersistence = {
  flush(): void;
  push(event: ProviderEvent): void;
};

/**
 * Reduces only the persisted issue.log projection. The original provider event still
 * flows through runtime hooks, approval handling, and terminal detection unchanged.
 */
export function createIssueLogPersistence(write: EventWriter): IssueLogPersistence {
  let chunk: PendingChunk | undefined;
  let chunkTimer: ReturnType<typeof setTimeout> | undefined;
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  const samples = new Map<string, SampleState>();

  const clearChunkTimer = () => {
    if (chunkTimer) clearTimeout(chunkTimer);
    chunkTimer = undefined;
  };
  const clearSampleTimer = () => {
    if (sampleTimer) clearTimeout(sampleTimer);
    sampleTimer = undefined;
  };
  const flushChunk = () => {
    clearChunkTimer();
    if (!chunk) return;
    write(chunk.count === 1 ? chunk.event : aggregatedChunk(chunk));
    chunk = undefined;
  };
  const flushSamples = () => {
    clearSampleTimer();
    const pending = [...samples.values()]
      .flatMap((state) => state.pending ? [{ state, ...state.pending }] : [])
      .sort((left, right) => left.sequence - right.sequence);
    for (const item of pending) {
      if (item.fingerprint !== item.state.lastPersistedFingerprint) {
        write(item.event);
        item.state.lastPersistedFingerprint = item.fingerprint;
      }
      item.state.pending = undefined;
    }
  };
  const scheduleChunkFlush = () => {
    clearChunkTimer();
    chunkTimer = setTimeout(flushChunk, CHUNK_IDLE_FLUSH_MS);
    chunkTimer.unref?.();
  };
  const scheduleSampleFlush = () => {
    clearSampleTimer();
    sampleTimer = setTimeout(flushSamples, SAMPLE_IDLE_FLUSH_MS);
    sampleTimer.unref?.();
  };

  return {
    push(event) {
      sequence += 1;
      if (isTerminalEvent(event)) {
        flushChunk();
        flushSamples();
        write(event);
        return;
      }

      const key = chunkKey(event);
      if (key !== "") {
        const text = event.text ?? "";
        const bytes = Buffer.byteLength(text);
        if (chunk && chunk.key === key &&
            chunk.count < ISSUE_LOG_CHUNK_EVENT_LIMIT &&
            chunk.bytes + bytes <= ISSUE_LOG_CHUNK_TEXT_BYTES) {
          chunk.count += 1;
          chunk.bytes += bytes;
          chunk.text += text;
          scheduleChunkFlush();
          return;
        }
        flushChunk();
        chunk = { bytes, count: 1, event, key, text };
        scheduleChunkFlush();
        return;
      }

      flushChunk();
      const interval = SAMPLE_INTERVALS.get(event.raw?.method ?? "");
      if (interval) {
        sampleEvent(event, interval, sequence, samples, write);
        if ([...samples.values()].some((state) => state.pending)) scheduleSampleFlush();
        return;
      }
      write(event);
    },
    flush() {
      flushChunk();
      flushSamples();
    }
  };
}

function sampleEvent(
  event: ProviderEvent,
  interval: number,
  sequence: number,
  samples: Map<string, SampleState>,
  write: EventWriter
): void {
  const key = sampleKey(event);
  const fingerprint = eventFingerprint(event);
  const state = samples.get(key) ?? {
    interval,
    lastPersistedFingerprint: "",
    seen: 0
  };
  state.seen += 1;
  samples.set(key, state);

  if (state.seen === 1 || state.seen % state.interval === 0) {
    if (fingerprint !== state.lastPersistedFingerprint) {
      write(event);
      state.lastPersistedFingerprint = fingerprint;
    }
    state.pending = undefined;
    return;
  }
  if (fingerprint === state.lastPersistedFingerprint) {
    state.pending = undefined;
    return;
  }
  state.pending = { event, fingerprint, sequence };
}

function aggregatedChunk(chunk: PendingChunk): ProviderEvent {
  return {
    ...chunk.event,
    text: chunk.text,
    payload: {
      aggregation: "concatenated_delta",
      chunk_count: chunk.count,
      raw_payloads_omitted: true
    },
    raw: { method: chunk.event.raw?.method }
  };
}

function chunkKey(event: ProviderEvent): string {
  const method = event.raw?.method ?? "";
  if (!CHUNK_METHODS.has(method) || typeof event.text !== "string") return "";
  return JSON.stringify([
    event.provider,
    event.type,
    method,
    event.session?.sessionId ?? "",
    event.session?.turnId ?? "",
    event.command ?? "",
    event.path ?? ""
  ]);
}

function sampleKey(event: ProviderEvent): string {
  return JSON.stringify([
    event.provider,
    event.raw?.method ?? "",
    event.session?.sessionId ?? "",
    event.session?.turnId ?? ""
  ]);
}

function eventFingerprint(event: ProviderEvent): string {
  return JSON.stringify([
    event.type,
    event.raw?.method ?? "",
    event.raw?.payload ?? null,
    event.payload ?? null,
    event.text ?? "",
    event.status ?? "",
    event.error ?? ""
  ]);
}

function isTerminalEvent(event: ProviderEvent): boolean {
  const method = event.raw?.method ?? "";
  return event.type === "done" || event.type === "error" ||
    method === "turn/completed" || method === "error" || method === "protocol/error";
}
