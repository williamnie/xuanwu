import type { ProviderEvent } from "../providers/types.ts";
import { codexDynamicExecObservation } from "../providers/codex/dynamicExec.ts";
import { objectValue } from "../util/values.ts";
import { rawObject, stringValue, boundedUtf8, sampleKey, eventFingerprint } from "./issueLogPersistence.values.ts";
import { ISSUE_LOG_DELTA_TEXT_BYTES_PER_METHOD, ISSUE_LOG_DELTA_ROWS_PER_METHOD, ISSUE_LOG_PROTECTED_ROWS_PER_METHOD, ISSUE_LOG_LIFECYCLE_ROWS_PER_TYPE, ISSUE_LOG_SAMPLE_ROWS_PER_METHOD, ISSUE_LOG_BUDGET_MARKER_METHOD } from "./issueLogPersistence.model.ts";
import type { PendingChunk, DeltaBudget, EventWriter, DirectBudget, SampleState, SampleBudget } from "./issueLogPersistence.model.ts";
import { lifecycleSnapshotType, terminalCarrier } from "./issueLogPersistence.telemetry.ts";

/**
 * Normal mode stores only replay-independent operational evidence. Detailed
 * provider protocol traffic remains available to live hooks but is persisted
 * only when the Issue explicitly opts into debug mode.
 */
export function normalModeEvent(event: ProviderEvent): boolean {
  const method = event.raw?.method ?? "";
  if (event.type === "error" || event.type === "done") return true;
  if (method === "item/completed") return normalCompletedItem(event);
  if (method === "turn/completed" || method === "error" || method === "protocol/error") return true;
  return method === "thread/status/changed" &&
    ["error", "failed", "systemerror"].includes((event.status ?? "").trim().toLowerCase());
}

export function normalCompletedItem(event: ProviderEvent): boolean {
  const item = objectValue(rawObject(event.raw?.payload).item);
  const itemType = stringValue(item.type);
  if (itemType === "agentMessage") return true;
  const dynamicExec = codexDynamicExecObservation(item);
  // Every terminal command is a current-Run fact. Whether it verifies the
  // Issue is a semantic PI decision made from the completion card; persistence
  // must not silently discard successful commands based on shell-text regexes.
  return itemType === "commandExecution" || Boolean(dynamicExec);
}

export function writeBoundedChunk(
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

export function writeDirectEvent(
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

export function sampleEvent(
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

export function aggregatedChunk(chunk: PendingChunk): ProviderEvent {
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

export function budgetMarker(
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
