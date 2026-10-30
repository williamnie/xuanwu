import type { ProviderEvent } from "../providers/types.ts";
import { ISSUE_LOG_SAMPLE_ROWS_PER_METHOD, CHUNK_IDLE_FLUSH_MS, SAMPLE_IDLE_FLUSH_MS, ISSUE_LOG_CHUNK_EVENT_LIMIT, ISSUE_LOG_CHUNK_TEXT_BYTES, SAMPLE_INTERVALS } from "./issueLogPersistence.model.ts";
import type { EventWriter, IssueLogMode, IssueLogPersistence, PendingChunk, DeltaBudget, DirectBudget, SampleBudget, SampleState } from "./issueLogPersistence.model.ts";
import { writeBoundedChunk, budgetMarker, normalModeEvent, sampleEvent, writeDirectEvent } from "./issueLogPersistence.budget.ts";
import { compactRunCostEvent, isRunCostTelemetry, lifecycleItemType, compactLifecycleEvent } from "./issueLogPersistence.telemetry.ts";
import { isTerminalEvent, chunkKey } from "./issueLogPersistence.values.ts";

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
  let pendingNormalCost: ProviderEvent | undefined;
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
  const flushNormalCost = () => {
    if (!pendingNormalCost) return;
    write(compactRunCostEvent(pendingNormalCost));
    pendingNormalCost = undefined;
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
      if (mode === "normal" && isRunCostTelemetry(sourceEvent)) {
        pendingNormalCost = sourceEvent;
        return;
      }
      if (mode === "normal" && !normalModeEvent(sourceEvent)) return;
      sequence += 1;
      const sourceMethod = sourceEvent.raw?.method ?? "";
      const sourceItemType = lifecycleItemType(sourceEvent);
      if (sourceMethod === "item/completed" && sourceItemType === "agentMessage") flushChunk();
      const messageBudget = deltaBudgets.get("item/agentMessage/delta");
      const preserveAgentFinal = sourceMethod === "item/completed" && sourceItemType === "agentMessage" &&
        (!messageBudget || messageBudget.rows === 0 || messageBudget.omittedEvents > 0);
      const event = compactLifecycleEvent(sourceEvent, preserveAgentFinal, mode);
      if (isTerminalEvent(event)) {
        flushChunk();
        flushSamples(true);
        flushNormalCost();
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
      flushNormalCost();
      flushBudgetMarkers();
    }
  };
}
