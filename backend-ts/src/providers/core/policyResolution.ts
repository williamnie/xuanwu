import {
  RESOLVED_EXECUTION_POLICY_CONTRACT,
  executionPolicyError,
  type ExecutionAccess,
  type ExecutionApproval,
  type ExecutionPolicyRequest,
  type PolicyDecision,
  type PolicyRiskClass,
  type PolicySensitivity,
  type ProviderExecutionPolicyCapabilities,
  type ProviderPolicyAdapter,
  type ProviderPolicyContext,
  type ResolvedExecutionPolicy,
  type ResolvedPolicyEffectSet,
  type ResolvedToolEffect
} from "./policyContracts.ts";

const ACCESS_FILESYSTEM_EFFECTS: Record<ExecutionAccess, readonly string[]> = {
  "read-only": ["project:read"],
  "provider-native-development": ["project:read", "project:write"],
  "unrestricted-host": ["project:read", "project:write", "host:read", "host:write"]
};

const ACCESS_NETWORK_EFFECTS: Record<ExecutionAccess, readonly string[]> = {
  "read-only": [],
  "provider-native-development": ["network:read"],
  "unrestricted-host": ["network:read", "network:write"]
};

export function requestEffectSet(request: ExecutionPolicyRequest): ResolvedPolicyEffectSet {
  return {
    toolEffects: [
      effect("read", "read", "read", "project", request),
      effect("write", "write", "routine", "project", request),
      effect("write-sensitive", "write", "sensitive", "project", request),
      effect("command", "command", "routine", "project", request),
      effect("command-sensitive", "command", "sensitive", "project", request),
      effect("network", "network", "sensitive", "network", request),
      effect("external-path", "write", "sensitive", "host", request)
    ],
    filesystem: { allowedEffects: [...ACCESS_FILESYSTEM_EFFECTS[request.access]] },
    network: { allowedEffects: [...ACCESS_NETWORK_EFFECTS[request.access]] }
  };
}

export function resolveExecutionPolicy(
  request: ExecutionPolicyRequest,
  context: ProviderPolicyContext,
  capabilities: ProviderExecutionPolicyCapabilities,
  adapter: ProviderPolicyAdapter
): ResolvedExecutionPolicy {
  const combination = capabilities.combinations.find((item) =>
    item.access === request.access && item.approval === request.approval &&
    (!item.transports || item.transports.includes(context.transport))
  );
  if (!combination || combination.support === "unsupported") {
    throw executionPolicyError(
      "policy_combination_unsupported",
      combination?.reason ?? `${context.providerId}/${context.transport} does not support ${request.access} + ${request.approval}`,
      {
        alternatives: supportedAlternatives(capabilities, context),
        providerId: String(context.providerId),
        transport: context.transport
      }
    );
  }
  const resolved = adapter.resolvePolicy(request, context);
  validateResolvedExecutionPolicy(request, resolved);
  if (request.access === "read-only" && request.approval !== "unattended") {
    resolved.warnings = [...new Set([...resolved.warnings, "approval_has_no_additional_effect"])];
  }
  return resolved;
}

export function validateResolvedExecutionPolicy(
  request: ExecutionPolicyRequest,
  resolved: ResolvedExecutionPolicy
): void {
  if (resolved.contract !== RESOLVED_EXECUTION_POLICY_CONTRACT) {
    throw executionPolicyError("policy_mapping_unsafe", "resolved execution policy contract is invalid");
  }
  assertSubset(resolved.effects.filesystem.allowedEffects, ACCESS_FILESYSTEM_EFFECTS[request.access], "filesystem");
  assertSubset(resolved.effects.network.allowedEffects, ACCESS_NETWORK_EFFECTS[request.access], "network");
  for (const effect of resolved.effects.toolEffects) validateToolEffect(request, effect);
}

export function resolvedPolicy(
  request: ExecutionPolicyRequest,
  input: Omit<ResolvedExecutionPolicy, "contract" | "requested" | "effects"> & { effects?: ResolvedPolicyEffectSet }
): ResolvedExecutionPolicy {
  return {
    contract: RESOLVED_EXECUTION_POLICY_CONTRACT,
    requested: request,
    effects: input.effects ?? requestEffectSet(request),
    isolation: input.isolation,
    nativeSummary: input.nativeSummary,
    proof: input.proof,
    warnings: input.warnings
  };
}

function effect(
  toolFamily: string,
  riskClass: PolicyRiskClass,
  sensitivity: PolicySensitivity,
  scope: string,
  request: ExecutionPolicyRequest
): ResolvedToolEffect {
  return { toolFamily, riskClass, sensitivity, scope, decision: decisionFor(request, riskClass, sensitivity, scope) };
}

function decisionFor(
  request: ExecutionPolicyRequest,
  riskClass: PolicyRiskClass,
  sensitivity: PolicySensitivity,
  scope: string
): PolicyDecision {
  if (riskClass === "read") return "auto_allow";
  if (request.access === "read-only") return "deny";
  if (request.access === "provider-native-development" && scope === "host") return "deny";
  if (request.approval === "unattended") return "auto_allow";
  if (request.approval === "ask-every-side-effect") return "host_prompt";
  return sensitivity === "sensitive" ? "host_prompt" : "auto_allow";
}

function validateToolEffect(request: ExecutionPolicyRequest, effect: ResolvedToolEffect): void {
  if (request.access === "read-only" && effect.riskClass !== "read" && effect.decision !== "deny") {
    throw executionPolicyError("policy_mapping_unsafe", `read-only effect ${effect.toolFamily} must be denied`);
  }
  if (request.access === "provider-native-development" && effect.scope === "host" && effect.decision !== "deny") {
    throw executionPolicyError("policy_mapping_unsafe", `host effect ${effect.toolFamily} exceeds provider-native-development`);
  }
  if (request.approval === "ask-every-side-effect" && effect.riskClass !== "read" && effect.decision === "auto_allow") {
    throw executionPolicyError("policy_mapping_unsafe", `side effect ${effect.toolFamily} cannot auto-allow`);
  }
  if (request.approval === "ask-sensitive" && effect.sensitivity === "sensitive" && effect.decision === "auto_allow") {
    throw executionPolicyError("policy_mapping_unsafe", `sensitive effect ${effect.toolFamily} cannot auto-allow`);
  }
}

function assertSubset(actual: readonly string[], ceiling: readonly string[], label: string): void {
  const allowed = new Set(ceiling);
  const extra = actual.find((value) => !allowed.has(value));
  if (extra) throw executionPolicyError("policy_mapping_unsafe", `${label} effect ${extra} exceeds requested access`);
}

function supportedAlternatives(
  capabilities: ProviderExecutionPolicyCapabilities,
  context: ProviderPolicyContext
): Array<{ access: ExecutionAccess; approval: ExecutionApproval }> {
  const seen = new Set<string>();
  return capabilities.combinations.flatMap((item) => {
    if (item.support === "unsupported" || (item.transports && !item.transports.includes(context.transport))) return [];
    const key = `${item.access}|${item.approval}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ access: item.access, approval: item.approval }];
  });
}
