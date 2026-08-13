import {
  DEFAULT_EXECUTION_POLICY,
  PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  allPolicyCombinations,
  type ProviderExecutionPolicyCapabilities,
  type ProviderPolicyAdapter,
  type ProviderPolicyContext,
  type ExecutionPolicyRequest
} from "../core/policyContracts.ts";
import { requestEffectSet, resolvedPolicy } from "../core/policyResolution.ts";

export const CODEX_EXECUTION_POLICY_CAPABILITIES: ProviderExecutionPolicyCapabilities = {
  contract: PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  isolation: "os-sandbox",
  combinations: allPolicyCombinations("native", ["rpc", "stdio-json"]),
  defaultPolicy: DEFAULT_EXECUTION_POLICY,
  dynamicRestrictions: true,
  proofCapabilities: { nativeMode: "argument-passed", toolDecision: "provider-observed" }
};

export const codexExecutionPolicyAdapter: ProviderPolicyAdapter = {
  resolvePolicy(request: ExecutionPolicyRequest, context: ProviderPolicyContext) {
    const effects = requestEffectSet(request);
    for (const effect of effects.toolEffects) {
      if (effect.decision === "host_prompt") effect.decision = "provider_prompt";
    }
    const sandbox = request.access === "read-only"
      ? "read-only"
      : request.access === "unrestricted-host" ? "danger-full-access" : "workspace-write";
    const approvalPolicy = request.approval === "unattended"
      ? "never"
      : request.approval === "ask-every-side-effect" ? "untrusted" : "on-request";
    return resolvedPolicy(request, {
      effects,
      isolation: request.access === "unrestricted-host" ? "none" : "os-sandbox",
      nativeSummary: { sandbox, approvalPolicy },
      proof: [{ kind: "provider-native", strength: "argument-passed", ref: `codex:${context.providerVersion || "unknown"}` }],
      warnings: request.approval === "unattended" ? [] : ["provider_decides_additional_prompt_boundary"]
    });
  }
};
