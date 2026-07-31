import type { ProviderEvent } from "../providers/types.ts";
import { codexDynamicExecObservation } from "../providers/codex/dynamicExec.ts";

export const ISSUE_LOG_CHUNK_EVENT_LIMIT = 64;
export const ISSUE_LOG_CHUNK_TEXT_BYTES = 32 * 1024;
export const ISSUE_LOG_DELTA_ROWS_PER_METHOD = 64;
export const ISSUE_LOG_DELTA_TEXT_BYTES_PER_METHOD = 2 * 1024 * 1024;
export const ISSUE_LOG_SAMPLE_ROWS_PER_METHOD = 64;
export const ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE = 256;
export const ISSUE_LOG_PROTECTED_ROWS_PER_METHOD = 1024;
export const ISSUE_LOG_BUDGET_MARKER_METHOD = "runner/issueLogBudget/truncated";

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
  method: string;
  text: string;
};
type PendingSample = { event: ProviderEvent; fingerprint: string; sequence: number };
type SampleState = {
  interval: number;
  lastPersistedFingerprint: string;
  pending?: PendingSample;
  persisted: number;
  seen: number;
};
type DeltaBudget = { omittedBytes: number; omittedEvents: number; rows: number; textBytes: number };
type SampleBudget = { omittedEvents: number; rows: number };
type DirectBudget = { markerWritten: boolean; omittedEvents: number; rows: number };

export type IssueLogPersistence = {
  flush(): void;
  push(event: ProviderEvent): void;
};

export type IssueLogMode = "debug" | "normal";

/**
 * Reduces only the persisted issue.log projection. The original provider event still
 * flows through runtime hooks, approval handling, and terminal detection unchanged.
 */
export function createIssueLogPersistence(
  write: EventWriter,
  options: { mode?: IssueLogMode } = {}
): IssueLogPersistence {
  const mode = options.mode ?? "debug";
  let chunk: PendingChunk | undefined;
  let chunkTimer: ReturnType<typeof setTimeout> | undefined;
  let sampleTimer: ReturnType<typeof setTimeout> | undefined;
  let sequence = 0;
  const deltaBudgets = new Map<string, DeltaBudget>();
  const directBudgets = new Map<string, DirectBudget>();
  const sampleBudgets = new Map<string, SampleBudget>();
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
    writeBoundedChunk(chunk, deltaBudgets, write);
    chunk = undefined;
  };
  const flushSamples = (final: boolean) => {
    clearSampleTimer();
    const pending = [...samples.values()]
      .flatMap((state) => state.pending ? [{ state, ...state.pending }] : [])
      .sort((left, right) => left.sequence - right.sequence);
    for (const item of pending) {
      if (item.fingerprint === item.state.lastPersistedFingerprint) {
        item.state.pending = undefined;
        continue;
      }
      const method = item.event.raw?.method ?? "unknown";
      const budget = sampleBudgets.get(method) ?? { omittedEvents: 0, rows: 0 };
      const reserveFinalRow = !final && budget.rows >= ISSUE_LOG_SAMPLE_ROWS_PER_METHOD - 1;
      if (!reserveFinalRow && budget.rows < ISSUE_LOG_SAMPLE_ROWS_PER_METHOD) {
        write(item.event);
        item.state.lastPersistedFingerprint = item.fingerprint;
        item.state.persisted += 1;
        budget.omittedEvents -= 1;
        budget.rows += 1;
        item.state.pending = undefined;
      }
      sampleBudgets.set(method, budget);
    }
  };
  const flushBudgetMarkers = () => {
    for (const [method, budget] of deltaBudgets) {
      if (budget.omittedEvents <= 0) continue;
      write(budgetMarker("delta", method, budget.omittedEvents, budget.omittedBytes, budget.rows));
      budget.omittedBytes = 0;
      budget.omittedEvents = 0;
    }
    for (const [method, budget] of sampleBudgets) {
      if (budget.omittedEvents <= 0) continue;
      write(budgetMarker("sample", method, budget.omittedEvents, 0, budget.rows));
      budget.omittedEvents = 0;
    }
    for (const [key, budget] of directBudgets) {
      if (budget.omittedEvents <= 0 || budget.markerWritten) continue;
      write(budgetMarker("lifecycle", key, budget.omittedEvents, 0, budget.rows));
      budget.markerWritten = true;
      budget.omittedEvents = 0;
    }
  };
  const scheduleChunkFlush = () => {
    clearChunkTimer();
    chunkTimer = setTimeout(flushChunk, CHUNK_IDLE_FLUSH_MS);
    chunkTimer.unref?.();
  };
  const scheduleSampleFlush = () => {
    clearSampleTimer();
    sampleTimer = setTimeout(() => flushSamples(false), SAMPLE_IDLE_FLUSH_MS);
    sampleTimer.unref?.();
  };

  return {
    push(sourceEvent) {
      if (mode === "normal" && !normalModeEvent(sourceEvent)) return;
      sequence += 1;
      const sourceMethod = sourceEvent.raw?.method ?? "";
      const sourceItemType = lifecycleItemType(sourceEvent);
      if (sourceMethod === "item/completed" && sourceItemType === "agentMessage") flushChunk();
      const messageBudget = deltaBudgets.get("item/agentMessage/delta");
      const preserveAgentFinal = sourceMethod === "item/completed" && sourceItemType === "agentMessage" &&
        (!messageBudget || messageBudget.rows === 0 || messageBudget.omittedEvents > 0);
      const event = compactLifecycleEvent(sourceEvent, preserveAgentFinal);
      if (isTerminalEvent(event)) {
        flushChunk();
        flushSamples(true);
        flushBudgetMarkers();
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
        chunk = { bytes, count: 1, event, key, method: event.raw?.method ?? "unknown", text };
        scheduleChunkFlush();
        return;
      }

      flushChunk();
      const interval = SAMPLE_INTERVALS.get(event.raw?.method ?? "");
      if (interval) {
        sampleEvent(event, interval, sequence, samples, sampleBudgets, write);
        if ([...samples.values()].some((state) => state.pending && state.persisted < ISSUE_LOG_SAMPLE_ROWS_PER_METHOD - 1)) {
          scheduleSampleFlush();
        }
        return;
      }
      writeDirectEvent(event, directBudgets, write);
    },
    flush() {
      flushChunk();
      flushSamples(true);
      flushBudgetMarkers();
    }
  };
}

/**
 * Normal mode stores only replay-independent operational evidence. Detailed
 * provider protocol traffic remains available to live hooks but is persisted
 * only when the Issue explicitly opts into debug mode.
 */
function normalModeEvent(event: ProviderEvent): boolean {
  const method = event.raw?.method ?? "";
  if (event.type === "error" || event.type === "done") return true;
  if (event.runEvent?.cost) return true;
  if (method === "item/completed") return normalCompletedItem(event);
  if (method === "turn/completed" || method === "error" || method === "protocol/error") return true;
  return method === "thread/status/changed" &&
    ["error", "failed", "systemerror"].includes((event.status ?? "").trim().toLowerCase());
}

function normalCompletedItem(event: ProviderEvent): boolean {
  const item = objectValue(rawObject(event.raw?.payload).item);
  const itemType = stringValue(item.type);
  if (itemType === "agentMessage") return true;
  const dynamicExec = codexDynamicExecObservation(item);
  // Every terminal command is a current-Run fact. Whether it verifies the
  // Issue is a semantic PI decision made from the completion card; persistence
  // must not silently discard successful commands based on shell-text regexes.
  return itemType === "commandExecution" || Boolean(dynamicExec);
}

function writeBoundedChunk(
  chunk: PendingChunk,
  budgets: Map<string, DeltaBudget>,
  write: EventWriter
): void {
  const budget = budgets.get(chunk.method) ?? { omittedBytes: 0, omittedEvents: 0, rows: 0, textBytes: 0 };
  const remainingBytes = Math.max(0, ISSUE_LOG_DELTA_TEXT_BYTES_PER_METHOD - budget.textBytes);
  if (budget.rows >= ISSUE_LOG_DELTA_ROWS_PER_METHOD || remainingBytes === 0) {
    budget.omittedBytes += chunk.bytes;
    budget.omittedEvents += chunk.count;
    budgets.set(chunk.method, budget);
    return;
  }
  const keptText = boundedUtf8(chunk.text, remainingBytes);
  const keptBytes = Buffer.byteLength(keptText);
  const keptEvents = keptBytes === chunk.bytes ? chunk.count : Math.max(1, Math.floor(chunk.count * keptBytes / Math.max(1, chunk.bytes)));
  write(aggregatedChunk({ ...chunk, bytes: keptBytes, count: keptEvents, text: keptText }));
  budget.rows += 1;
  budget.textBytes += keptBytes;
  budget.omittedBytes += chunk.bytes - keptBytes;
  budget.omittedEvents += chunk.count - keptEvents;
  budgets.set(chunk.method, budget);
}

function writeDirectEvent(
  event: ProviderEvent,
  budgets: Map<string, DirectBudget>,
  write: EventWriter
): void {
  const method = event.raw?.method ?? "unknown";
  const snapshotType = lifecycleSnapshotType(event);
  const key = snapshotType === "" ? method : `${method}:${snapshotType}`;
  const budget = budgets.get(key) ?? { markerWritten: false, omittedEvents: 0, rows: 0 };
  const limit = snapshotType === "" ? ISSUE_LOG_PROTECTED_ROWS_PER_METHOD : ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE;
  if (budget.rows < limit) {
    write(event);
    budget.rows += 1;
    budgets.set(key, budget);
    return;
  }
  budget.omittedEvents += 1;
  budgets.set(key, budget);
  if (snapshotType !== "") return;
  if (!budget.markerWritten) {
    write(budgetMarker("protected", key, budget.omittedEvents, 0, budget.rows));
    budget.markerWritten = true;
  }
  throw new Error(`issue.log protected event budget exceeded for ${method}`);
}

function sampleEvent(
  event: ProviderEvent,
  interval: number,
  sequence: number,
  samples: Map<string, SampleState>,
  budgets: Map<string, SampleBudget>,
  write: EventWriter
): void {
  const key = sampleKey(event);
  const method = event.raw?.method ?? "unknown";
  const fingerprint = eventFingerprint(event);
  const state = samples.get(key) ?? {
    interval,
    lastPersistedFingerprint: "",
    persisted: 0,
    seen: 0
  };
  const budget = budgets.get(method) ?? { omittedEvents: 0, rows: 0 };
  budget.omittedEvents += 1;
  state.seen += 1;
  samples.set(key, state);

  const scheduled = state.seen === 1 || state.seen % state.interval === 0;
  if (scheduled && budget.rows < ISSUE_LOG_SAMPLE_ROWS_PER_METHOD - 1) {
    if (fingerprint !== state.lastPersistedFingerprint) {
      write(event);
      state.lastPersistedFingerprint = fingerprint;
      state.persisted += 1;
      budget.omittedEvents -= 1;
      budget.rows += 1;
    }
    state.pending = undefined;
    budgets.set(method, budget);
    return;
  }
  if (fingerprint === state.lastPersistedFingerprint) {
    state.pending = undefined;
    budgets.set(method, budget);
    return;
  }
  state.pending = { event, fingerprint, sequence };
  budgets.set(method, budget);
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

function budgetMarker(
  category: "delta" | "lifecycle" | "protected" | "sample",
  method: string,
  omittedEvents: number,
  omittedBytes: number,
  persistedRows: number
): ProviderEvent {
  return {
    provider: "codex",
    type: "raw",
    status: "truncated",
    payload: {
      budget: category === "delta"
        ? { max_rows: ISSUE_LOG_DELTA_ROWS_PER_METHOD, max_text_bytes: ISSUE_LOG_DELTA_TEXT_BYTES_PER_METHOD }
        : category === "sample"
          ? { max_rows: ISSUE_LOG_SAMPLE_ROWS_PER_METHOD }
          : category === "lifecycle"
            ? { max_rows: ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE }
            : { max_rows: ISSUE_LOG_PROTECTED_ROWS_PER_METHOD, overflow: "fail_closed" },
      category,
      full_state_carrier: terminalCarrier(method),
      omitted_bytes: omittedBytes,
      omitted_events: omittedEvents,
      persisted_rows: persistedRows,
      schema_version: "issue-log-budget-marker.v1",
      source_method: method
    },
    raw: { method: ISSUE_LOG_BUDGET_MARKER_METHOD }
  };
}

function terminalCarrier(method: string): string {
  if (method === "item/agentMessage/delta") return "item/completed agentMessage";
  if (method === "item/commandExecution/outputDelta") return "item/completed commandExecution";
  if (method === "item/fileChange/outputDelta" || method === "turn/diff/updated") return "item/completed fileChange";
  if (method === "thread/tokenUsage/updated") return "turn/completed normalized cost";
  return "latest bounded sample plus terminal event";
}

function compactLifecycleEvent(event: ProviderEvent, preserveAgentFinal: boolean): ProviderEvent {
  const method = event.raw?.method ?? "";
  if (method !== "item/started" && method !== "item/completed") return event;
  const raw = rawObject(event.raw?.payload);
  const item = objectValue(raw.item);
  const itemType = stringValue(item.type);
  const snapshot = compactObject({
    item_id: boundedUtf8(stringValue(item.id), 512),
    item_type: boundedUtf8(itemType, 128),
    phase: boundedUtf8(stringValue(item.phase), 128),
    process_id: boundedUtf8(stringValue(item.processId), 512),
    representation: "necessary_snapshot",
    raw_payload_omitted: true
  });
  if (method === "item/started" && ["agentMessage", "commandExecution", "fileChange", "reasoning"].includes(itemType)) {
    return { ...event, payload: snapshot, raw: { method } };
  }
  if (method === "item/completed" && itemType === "reasoning") {
    return { ...event, payload: snapshot, raw: { method } };
  }
  if (method === "item/completed" && itemType === "agentMessage") {
    return {
      ...event,
      payload: snapshot,
      raw: { method },
      ...(preserveAgentFinal ? { text: event.text || stringValue(item.text) } : { text: undefined })
    };
  }
  return event;
}

function lifecycleItemType(event: ProviderEvent): string {
  const method = event.raw?.method ?? "";
  if (method !== "item/started" && method !== "item/completed") return "";
  return stringValue(objectValue(rawObject(event.raw?.payload).item).type);
}

function lifecycleSnapshotType(event: ProviderEvent): string {
  const payload = objectValue(event.payload);
  const itemType = stringValue(payload.item_type);
  if (event.raw?.method === "item/completed" && itemType === "agentMessage") return "";
  return payload.representation === "necessary_snapshot" && payload.raw_payload_omitted === true
    ? itemType || "unknown" : "";
}

function rawObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return objectValue(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== "" && item !== undefined));
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function boundedUtf8(value: string, byteLimit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= byteLimit) return value;
  let end = Math.max(0, byteLimit);
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
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
