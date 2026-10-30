import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent } from "../../db/repositories/pi.ts";
import type { PiRuntimeContextEnvelope } from "../../pi/runtime/runtimeContextEnvelope.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { PiRuntimeResourceSnapshot } from "./piRuntimeResources.ts";
import { cleanString, sha256 } from "../../util/values.ts";
import type { ObservationInput, PiRuntimeSurface, ObservationPhase } from "./piContextBudgetObservation.model.ts";

export const PI_CONTEXT_BUDGET_OBSERVATION_SCHEMA = "xw.pi-context-budget-observation.v1" as const;

export const PI_CONTEXT_BUDGET_OBSERVATION_EVENT = "runtime_context_budget_observed" as const;

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
  const currentUserPrompt = cleanString(input.sourceTurn?.userPrompt);
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
      id: cleanString(options.session.model?.id),
      max_tokens: positiveInteger(options.session.model?.maxTokens),
      provider: cleanString(options.session.model?.provider)
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
      channel_context: measuredText(cleanString(input.channelContext)),
      durable_memory: measuredText(JSON.stringify(options.runtimeContextEnvelope.durable_context)),
      supervisor_context: measuredText(JSON.stringify(input.supervisorContext ?? {}))
    },
    surface: piRuntimeSurface(input)
  };
}

export function piRuntimeSurface(input: Pick<ObservationInput, "conversationID" | "promptProfile" | "source">): PiRuntimeSurface {
  if (input.promptProfile !== "chat") return "internal";
  const source = cleanString(input.source).toLowerCase();
  const conversationID = cleanString(input.conversationID).toLowerCase();
  if (source.includes("feishu") || conversationID.startsWith("feishu-")) return "feishu";
  if (source.includes("telegram") || conversationID.startsWith("telegram-")) return "telegram";
  return "runner_chat";
}

export function recordObservation(
  db: RunnerDatabase,
  input: ObservationInput,
  phase: ObservationPhase,
  payload: unknown,
  providerCallIndex: number
): void {
  try {
    const turnID = cleanString(input.sourceTurn?.id) || "runtime";
    createPiActionEvent(db, {
      action_id: `context-budget:${input.conversationID}:${turnID}:${phase}:${providerCallIndex}:${crypto.randomUUID()}`,
      actor: "pi_context_budget_observer",
      conversation_id: input.conversationID,
      delegation_id: cleanString(input.delegationID),
      decision: "observed",
      event_type: PI_CONTEXT_BUDGET_OBSERVATION_EVENT,
      heartbeat_id: cleanString(input.heartbeatID),
      issue_id: positiveInteger(input.issueID),
      payload_json: JSON.stringify(payload),
      project_id: cleanString(input.projectID),
      reason: `observe-only PI context budget ${phase}`
    });
  } catch (error) {
    warnObservationFailure(error);
  }
}

export function measuredMessages(messages: AgentSession["state"]["messages"]) {
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

export function measuredText(value: string) {
  const utf8Bytes = Buffer.byteLength(value, "utf8");
  return { estimated_tokens: estimatedTokensFromBytes(utf8Bytes), utf8_bytes: utf8Bytes };
}

export function estimatedTokensFromBytes(bytes: number): number {
  return bytes === 0 ? 0 : Math.ceil(bytes / 4);
}

export function percentage(value: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((value / total) * 10_000) / 100;
}

export function elapsedMilliseconds(startedAt: number): number {
  return Math.round(Math.max(0, performance.now() - startedAt) * 1000) / 1000;
}

export function nullablePositiveInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : positiveInteger(value);
}

export function positiveInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

export function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function warnObservationFailure(error: unknown): void {
  console.warn("[pi-runtime] failed to audit context budget observation:", redactSensitiveText(safeError(error)));
}
