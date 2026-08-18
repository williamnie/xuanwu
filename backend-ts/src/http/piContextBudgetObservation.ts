import { createHash } from "node:crypto";
import {
  estimateTokens,
  type AgentSession,
  type AgentSessionEvent
} from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import type { PiRuntimeContextEnvelope } from "../pi/runtimeContextEnvelope.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { RuntimeSessionInput } from "./piRuntime.ts";
import type { PiRuntimeResourceSnapshot } from "./piRuntimeResources.ts";

export const PI_CONTEXT_BUDGET_OBSERVATION_SCHEMA = "xw.pi-context-budget-observation.v1" as const;
export const PI_CONTEXT_BUDGET_OBSERVATION_EVENT = "runtime_context_budget_observed" as const;

export type PiRuntimeSurface = "feishu" | "internal" | "runner_chat" | "telegram";

type ObservationInput = Pick<RuntimeSessionInput,
  "conversationID" | "delegationID" | "heartbeatID" | "issueID" | "promptProfile" |
  "source" | "sourceTurn" | "supervisorContext"> & {
    channelContext?: string;
    projectID?: string;
  };

type PreflightObservation = ReturnType<typeof buildPiContextBudgetPreflight>;
type ObservationPhase = "compaction_end" | "compaction_start" | "postflight" | "preflight";

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
    error_present: clean(event.errorMessage) !== "",
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

export function buildPiContextBudgetPreflight(
  input: ObservationInput,
  options: {
    baseSystemPrompt: string;
    compactionReserveTokens: number;
    resourceSnapshot: PiRuntimeResourceSnapshot;
    runtimeContextEnvelope: PiRuntimeContextEnvelope;
    session: AgentSession;
  }
) {
  const activeToolNames = new Set(options.session.getActiveToolNames());
  const serializedTools = JSON.stringify(options.session.getAllTools()
    .filter((tool) => activeToolNames.has(tool.name))
    .map((tool) => ({
      description: tool.description,
      name: tool.name,
      parameters: tool.parameters,
      promptGuidelines: tool.promptGuidelines
    }))
    .sort((left, right) => left.name.localeCompare(right.name)));
  const effectiveSystemPrompt = options.session.systemPrompt;
  const currentUserPrompt = clean(input.sourceTurn?.userPrompt);
  const baseSystem = measuredText(options.baseSystemPrompt);
  const effectiveSystem = measuredText(effectiveSystemPrompt);
  const toolDefinitions = measuredText(serializedTools);
  const sessionMessages = measuredMessages(options.session.state.messages);
  const currentPrompt = measuredText(currentUserPrompt);
  const projectedInputTokens = effectiveSystem.estimated_tokens +
    toolDefinitions.estimated_tokens + sessionMessages.estimated_tokens + currentPrompt.estimated_tokens;
  const contextWindow = positiveInteger(options.session.model?.contextWindow);
  const sdkContextUsage = options.session.getContextUsage();
  return {
    behavior: {
      observe_only: true,
      projector_changed: false,
      session_changed: false,
      tool_surface_changed: false
    },
    breakdown: {
      base_system_prompt: baseSystem,
      current_user_prompt: currentPrompt,
      effective_system_prompt: effectiveSystem,
      runtime_prompt_overhead: {
        estimated_tokens: Math.max(0, effectiveSystem.estimated_tokens - baseSystem.estimated_tokens),
        utf8_bytes: Math.max(0, effectiveSystem.utf8_bytes - baseSystem.utf8_bytes)
      },
      session_messages: sessionMessages,
      tool_definitions: toolDefinitions
    },
    context: {
      compaction_reserve_tokens: positiveInteger(options.compactionReserveTokens),
      context_window: contextWindow,
      projected_input_percent: percentage(projectedInputTokens, contextWindow),
      projected_input_tokens: projectedInputTokens,
      sdk_context_tokens: nullablePositiveInteger(sdkContextUsage?.tokens),
      sdk_context_window: positiveInteger(sdkContextUsage?.contextWindow)
    },
    counts: {
      active_tools: activeToolNames.size,
      resource_agents: options.resourceSnapshot.counts.agents,
      resource_diagnostics: options.resourceSnapshot.counts.diagnostics,
      resource_extensions: options.resourceSnapshot.counts.extensions,
      resource_prompts: options.resourceSnapshot.counts.prompts,
      resource_skills: options.resourceSnapshot.counts.skills,
      session_messages: options.session.state.messages.length
    },
    hashes: {
      effective_system_prompt_sha256: sha256(effectiveSystemPrompt),
      tool_definitions_sha256: sha256(serializedTools)
    },
    measurement: {
      confidence: "estimated",
      method: "sdk_messages_plus_serialized_utf8_div_4"
    },
    model: {
      context_window: contextWindow,
      id: clean(options.session.model?.id),
      max_tokens: positiveInteger(options.session.model?.maxTokens),
      provider: clean(options.session.model?.provider)
    },
    observe_only: true,
    phase: "preflight",
    profile: input.promptProfile,
    resource: {
      generation: options.resourceSnapshot.generation,
      outcome: options.resourceSnapshot.outcome
    },
    schema_version: PI_CONTEXT_BUDGET_OBSERVATION_SCHEMA,
    subsets: {
      channel_context: measuredText(clean(input.channelContext)),
      durable_memory: measuredText(JSON.stringify(options.runtimeContextEnvelope.durable_context)),
      supervisor_context: measuredText(JSON.stringify(input.supervisorContext ?? {}))
    },
    surface: piRuntimeSurface(input)
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

export function piRuntimeSurface(input: Pick<ObservationInput, "conversationID" | "promptProfile" | "source">): PiRuntimeSurface {
  if (input.promptProfile !== "chat") return "internal";
  const source = clean(input.source).toLowerCase();
  const conversationID = clean(input.conversationID).toLowerCase();
  if (source.includes("feishu") || conversationID.startsWith("feishu-")) return "feishu";
  if (source.includes("telegram") || conversationID.startsWith("telegram-")) return "telegram";
  return "runner_chat";
}

function recordObservation(
  db: RunnerDatabase,
  input: ObservationInput,
  phase: ObservationPhase,
  payload: unknown,
  providerCallIndex: number
): void {
  try {
    const turnID = clean(input.sourceTurn?.id) || "runtime";
    createPiActionEvent(db, {
      action_id: `context-budget:${input.conversationID}:${turnID}:${phase}:${providerCallIndex}:${crypto.randomUUID()}`,
      actor: "pi_context_budget_observer",
      conversation_id: input.conversationID,
      delegation_id: clean(input.delegationID),
      decision: "observed",
      event_type: PI_CONTEXT_BUDGET_OBSERVATION_EVENT,
      heartbeat_id: clean(input.heartbeatID),
      issue_id: positiveInteger(input.issueID),
      payload_json: JSON.stringify(payload),
      project_id: clean(input.projectID),
      reason: `observe-only PI context budget ${phase}`
    });
  } catch (error) {
    warnObservationFailure(error);
  }
}

function isAssistantMessageEnd(
  event: AgentSessionEvent
): event is Extract<AgentSessionEvent, { type: "message_end" }> {
  return event.type === "message_end" && event.message.role === "assistant";
}

function measuredMessages(messages: AgentSession["state"]["messages"]) {
  let estimatedTokens = 0;
  for (const message of messages) {
    try {
      estimatedTokens += Math.max(0, estimateTokens(message));
    } catch {
      estimatedTokens += estimatedTokensFromBytes(Buffer.byteLength(JSON.stringify(message), "utf8"));
    }
  }
  return {
    estimated_tokens: estimatedTokens,
    utf8_bytes: Buffer.byteLength(JSON.stringify(messages), "utf8")
  };
}

function measuredText(value: string) {
  const utf8Bytes = Buffer.byteLength(value, "utf8");
  return { estimated_tokens: estimatedTokensFromBytes(utf8Bytes), utf8_bytes: utf8Bytes };
}

function estimatedTokensFromBytes(bytes: number): number {
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

function percentage(value: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((value / total) * 10_000) / 100;
}

function elapsedMilliseconds(startedAt: number): number {
  return Math.round(Math.max(0, performance.now() - startedAt) * 1000) / 1000;
}

function nullablePositiveInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : positiveInteger(value);
}

function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnObservationFailure(error: unknown): void {
  console.warn("[pi-runtime] failed to audit context budget observation:", redactSensitiveText(safeError(error)));
}
