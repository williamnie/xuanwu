import type { AppEvent } from "../events/bus.ts";
import { type ProviderEvent } from "../providers/types.ts";
import { cleanString } from "../util/values.ts";
import type { RunnerIssueExecutionInput } from "./providerRuntime.model.ts";

export function publishIssueLog(
  input: RunnerIssueExecutionInput,
  event: ProviderEvent,
  persisted: { created_at: string; id: number; payload: string; type: string }
): void {
  input.bus?.publish(compactAppEvent({
    id: persisted.id,
    type: persisted.type,
    issueId: input.issueId,
    projectId: input.projectId,
    provider: event.provider,
    threadId: event.session?.sessionId,
    turnId: event.session?.turnId,
    agent_event_type: event.type,
    raw_method: event.raw?.method,
    raw_payload: rawPayloadText(event.raw?.payload),
    command: event.command,
    path: event.path,
    status: event.status,
    text: event.text,
    error: event.error,
    payload: persisted.payload,
    created_at: persisted.created_at
  }));
}

export function compactAppEvent(event: AppEvent): AppEvent {
  return Object.fromEntries(
    Object.entries(event).filter(([, value]) => value !== undefined && value !== "")
  ) as AppEvent;
}

export function rawPayloadText(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

export function runtimeMetadata(
  input: RunnerIssueExecutionInput,
  metadata: Record<string, string>
): Record<string, unknown> {
  const serviceTier = cleanString(input.serviceTier);
  return {
    ...metadata,
    resolved_settings: {
      approval_policy: cleanString(input.approvalPolicy),
      model: cleanString(input.model),
      reasoning_effort: cleanString(input.reasoningEffort),
      sandbox: cleanString(input.sandbox),
      service_tier: serviceTier,
      service_tier_source: cleanString(input.serviceTierSource) || (serviceTier ? "unknown" : "standard")
    },
    ...(input.policy ? {
      requested_execution_policy: input.policy.requested,
      resolved_execution_policy: {
        contract: input.policy.contract,
        effects: input.policy.effects,
        isolation: input.policy.isolation,
        native_summary: input.policy.nativeSummary,
        proof: input.policy.proof
      },
      provider_policy_capability_revision: input.executionPolicyCapabilityRevision ?? "",
      provider_version: input.executionPolicyProviderVersion ?? "",
      transport: input.executionPolicyTransport ?? "",
      resolution_source: input.executionPolicyResolutionSource ?? (input.executionPolicyRequest ? "explicit" : "legacy"),
      classifier_authority: input.policy.proof.some((proof) => proof.kind === "adapter-callback") ? "host" : "provider",
      proof_strength: [...new Set(input.policy.proof.map((proof) => proof.strength))],
      warnings: input.policy.warnings
    } : {}),
    ...(serviceTier === "" ? {} : {
      service_tier: serviceTier,
      service_tier_source: cleanString(input.serviceTierSource) || "unknown"
    })
  };
}
