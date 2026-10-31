import { type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../../db/database.ts";
import type { PiRuntimeContextEnvelope } from "../../pi/runtime/runtimeContextEnvelope.ts";
import type { PiRuntimeResourceSnapshot } from "./piRuntimeResources.ts";
import { cleanString } from "../../util/values.ts";
import type { ObservationInput, PreflightObservation } from "./piContextBudgetObservation.model.ts";
import { buildPiContextBudgetPreflight, recordObservation, elapsedMilliseconds, warnObservationFailure, PI_CONTEXT_BUDGET_OBSERVATION_SCHEMA, piRuntimeSurface, positiveInteger, percentage } from "./piContextBudgetObservation.buildPiContextBudgetPreflight.ts";

export function installPiContextBudgetObservation(
  db: RunnerDatabase,
  input: ObservationInput,
  options: {
    baseSystemPrompt: string;
    compactionReserveTokens: number;
    resourceSnapshot: PiRuntimeResourceSnapshot;
    runtimeContextEnvelope: PiRuntimeContextEnvelope;
    session: AgentSession;
  }
): () => void {
  try {
    const assemblyStartedAt = performance.now();
    const preflight = buildPiContextBudgetPreflight(input, options);
    recordObservation(db, input, "preflight", {
      ...preflight,
      observer: { assembly_duration_ms: elapsedMilliseconds(assemblyStartedAt) }
    }, 0);
    let providerCallIndex = 0;
    return options.session.subscribe((event) => {
      try {
        if (event.type === "compaction_start" || event.type === "compaction_end") {
          recordObservation(db, input, event.type, buildPiCompactionObservation(input, event), 0);
          return;
        }
        if (!isAssistantMessageEnd(event)) return;
        providerCallIndex += 1;
        recordObservation(
          db,
          input,
          "postflight",
          buildPiContextBudgetPostflight(preflight, event, providerCallIndex),
          providerCallIndex
        );
      } catch (error) {
        warnObservationFailure(error);
      }
    });
  } catch (error) {
    warnObservationFailure(error);
    return () => {};
  }
}

export function buildPiCompactionObservation(
  input: Pick<ObservationInput, "conversationID" | "promptProfile" | "source">,
  event: Extract<AgentSessionEvent, { type: "compaction_end" | "compaction_start" }>
) {
  if (event.type === "compaction_start") return {
    observe_only: true,
    phase: "compaction_start",
    profile: input.promptProfile,
    reason: event.reason,
    schema_version: PI_CONTEXT_BUDGET_OBSERVATION_SCHEMA,
    surface: piRuntimeSurface(input)
  };
  const usage = event.result?.usage;
  return {
    aborted: event.aborted,
    error_present: cleanString(event.errorMessage) !== "",
    observe_only: true,
    phase: "compaction_end",
    profile: input.promptProfile,
    reason: event.reason,
    result: {
      estimated_tokens_after: positiveInteger(event.result?.estimatedTokensAfter),
      tokens_before: positiveInteger(event.result?.tokensBefore),
      usage: {
        cache_read_tokens: positiveInteger(usage?.cacheRead),
        cache_write_tokens: positiveInteger(usage?.cacheWrite),
        input_tokens: positiveInteger(usage?.input),
        output_tokens: positiveInteger(usage?.output),
        total_tokens: positiveInteger(usage?.totalTokens)
      }
    },
    schema_version: PI_CONTEXT_BUDGET_OBSERVATION_SCHEMA,
    surface: piRuntimeSurface(input),
    will_retry: event.willRetry
  };
}

export function buildPiContextBudgetPostflight(
  preflight: PreflightObservation,
  event: Extract<AgentSessionEvent, { type: "message_end" }>,
  providerCallIndex: number
) {
  const usage = event.message.role === "assistant" ? event.message.usage : undefined;
  const observedInputTokens = usage
    ? positiveInteger(usage.input) + positiveInteger(usage.cacheRead) + positiveInteger(usage.cacheWrite)
    : 0;
  const compareToPreflight = providerCallIndex === 1 && observedInputTokens > 0;
  const differenceTokens = compareToPreflight
    ? preflight.context.projected_input_tokens - observedInputTokens
    : null;
  return {
    comparison: {
      absolute_error_percent: compareToPreflight
        ? percentage(Math.abs(differenceTokens ?? 0), observedInputTokens)
        : null,
      compared_to_preflight: compareToPreflight,
      difference_tokens: differenceTokens,
      underestimated_by_tokens: compareToPreflight
        ? Math.max(0, observedInputTokens - preflight.context.projected_input_tokens)
        : null
    },
    observe_only: true,
    observed_usage: {
      cache_read_tokens: positiveInteger(usage?.cacheRead),
      cache_write_tokens: positiveInteger(usage?.cacheWrite),
      input_context_tokens: observedInputTokens,
      input_tokens: positiveInteger(usage?.input),
      output_tokens: positiveInteger(usage?.output),
      reasoning_tokens: positiveInteger(usage?.reasoning),
      total_tokens: positiveInteger(usage?.totalTokens)
    },
    phase: "postflight",
    profile: preflight.profile,
    projected_input_tokens: compareToPreflight ? preflight.context.projected_input_tokens : null,
    provider_call_index: providerCallIndex,
    schema_version: PI_CONTEXT_BUDGET_OBSERVATION_SCHEMA,
    surface: preflight.surface
  };
}

export function isAssistantMessageEnd(
  event: AgentSessionEvent
): event is Extract<AgentSessionEvent, { type: "message_end" }> {
  return event.type === "message_end" && event.message.role === "assistant";
}
