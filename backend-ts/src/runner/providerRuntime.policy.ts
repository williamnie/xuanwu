import { updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { type ExecutorProvider, type ProviderRecoveryInput, type ProviderRunInput } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { ExecutionPolicyError, type ProviderPolicyContext } from "../providers/core/policyContracts.ts";
import type { ProviderTransport } from "../providers/core/manifest.ts";
import { translateLegacyExecutionPolicy } from "../providers/core/legacyExecutionPolicy.ts";
import { resolveExecutionPolicy } from "../providers/core/policyResolution.ts";
import type { RunnerIssueExecutionInput, RunnerIssueRecoveryInput } from "./providerRuntime.model.ts";
import { providerEventSink } from "./providerRuntime.events.ts";
import { policyResolutionErrorEvent } from "./providerRuntime.errors.ts";
import { resetDebugIssueLogMode } from "./providerRuntime.outcomes.ts";

export function providerInput(input: RunnerIssueExecutionInput, onEvent: ProviderRunInput["onEvent"]): ProviderRunInput {
  return {
    issueId: input.issueId,
    projectId: input.projectId,
    cwd: input.cwd,
    images: input.images,
    prompt: input.prompt,
    model: input.model,
    reasoningEffort: input.reasoningEffort,
    serviceTier: input.serviceTier,
    serviceTierSource: input.serviceTierSource,
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    policy: input.policy,
    ...(input.skillPackages?.length ? { skillPackages: input.skillPackages } : {}),
    onEvent
  };
}

export function withResolvedExecutionPolicy(
  provider: Pick<ExecutorProvider, "id" | "manifest" | "policyAdapter" | "runtimeStatus">,
  input: RunnerIssueExecutionInput,
  activeRunID: string,
  source: ProviderPolicyContext["source"]
): RunnerIssueExecutionInput {
  if (input.policy) return input;
  const capabilities = provider.manifest?.executionPolicy;
  if (!capabilities || !provider.policyAdapter) return input;
  const translated = input.executionPolicyRequest
    ? { policy: input.executionPolicyRequest, warnings: [] as string[] }
    : translateLegacyExecutionPolicy({
      scope: "project",
      sandbox: input.sandbox,
      approvalPolicy: input.approvalPolicy
    });
  if (!translated.policy) return input;
  const runtime = provider.runtimeStatus?.();
  const transport = selectedProviderTransport(provider);
  const providerVersion = runtime?.version ?? "";
  const policy = resolveExecutionPolicy(translated.policy, {
    cwd: input.cwd,
    invocationRef: activeRunID || `issue:${input.issueId}:pending`,
    projectId: input.projectId,
    providerId: provider.manifest!.id,
    providerVersion,
    source,
    transport
  }, capabilities, provider.policyAdapter);
  if (translated.warnings.length > 0) {
    policy.warnings = [...new Set([...policy.warnings, ...translated.warnings])];
  }
  return {
    ...input,
    executionPolicyRequest: translated.policy,
    executionPolicyCapabilityRevision: capabilities.contract,
    executionPolicyProviderVersion: providerVersion,
    executionPolicyTransport: transport,
    policy
  };
}

export async function resolveRuntimePolicyOrPersist(
  provider: Pick<ExecutorProvider, "id" | "manifest" | "policyAdapter" | "runtimeStatus">,
  input: RunnerIssueExecutionInput,
  activeRunID: string,
  activeAttempt: number,
  source: ProviderPolicyContext["source"]
): Promise<RunnerIssueExecutionInput> {
  try {
    return withResolvedExecutionPolicy(provider, input, activeRunID, source);
  } catch (error) {
    const code = error instanceof ExecutionPolicyError ? error.code : "policy_resolution_failed";
    const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
    if (input.database) {
      updateIssueRuntime(input.database, input.issueId, {
        agent_profile_id: input.agentProfileId,
        capability_summary: input.capabilitySummary,
        issue_run_id: activeRunID,
        metadata: {
          source: source === "recovery" ? "provider_recovery_policy_error" : "provider_policy_error",
          configuration_error: { code, message },
          requested_execution_policy: input.executionPolicyRequest ?? null,
          provider: provider.id,
          provider_version: input.executionPolicyProviderVersion ?? provider.runtimeStatus?.().version ?? "",
          transport: input.executionPolicyTransport ?? selectedProviderTransport(provider),
          resolution_source: input.executionPolicyResolutionSource ?? (input.executionPolicyRequest ? "explicit" : "legacy")
        },
        provider: provider.id,
        selection_reason: input.selectionReason
      });
    }
    const eventSink = providerEventSink(input, activeRunID, activeAttempt);
    eventSink.push(policyResolutionErrorEvent(provider.id, code, message));
    await eventSink.flush();
    resetDebugIssueLogMode(input, eventSink.mode, provider.id);
    throw error;
  }
}

export function selectedProviderTransport(
  provider: Pick<ExecutorProvider, "manifest" | "runtimeStatus">
): ProviderTransport {
  const transports = provider.manifest?.transports ?? [];
  const mode = provider.runtimeStatus?.().mode?.trim() ?? "";
  const mapped = mode === "cli-fallback" ? "stdio-json" : mode;
  return (transports.includes(mapped as ProviderTransport) ? mapped : transports[0] ?? "sdk") as ProviderTransport;
}

export function providerRecoveryInput(
  input: RunnerIssueRecoveryInput,
  onEvent: ProviderRunInput["onEvent"]
): ProviderRecoveryInput {
  return { ...providerInput(input, onEvent), session: input.session };
}
