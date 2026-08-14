import {
  DEFAULT_EXECUTION_POLICY,
  PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  allPolicyCombinations,
  type ExecutionPolicyRequest,
  type ProviderExecutionPolicyCapabilities,
  type ProviderPolicyAdapter,
  type ProviderPolicyContext
} from "../core/policyContracts.ts";
import { requestEffectSet, resolvedPolicy } from "../core/policyResolution.ts";

export const PI_EXECUTION_POLICY_CAPABILITIES: ProviderExecutionPolicyCapabilities = {
  contract: PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  isolation: "tool-selection",
  combinations: allPolicyCombinations("adapter", ["rpc"]),
  defaultPolicy: DEFAULT_EXECUTION_POLICY,
  dynamicRestrictions: true,
  proofCapabilities: { nativeMode: "argument-passed", toolDecision: "adapter-enforced" }
};

export const piExecutionPolicyAdapter: ProviderPolicyAdapter = {
  resolvePolicy(request: ExecutionPolicyRequest, context: ProviderPolicyContext) {
    const readOnly = request.access === "read-only";
    const approvalBridge = !readOnly && request.approval !== "unattended";
    return resolvedPolicy(request, {
      effects: requestEffectSet(request),
      isolation: "tool-selection",
      nativeSummary: {
        tools: readOnly ? ["read", "grep", "find", "ls"] : [],
        approvalBridge,
        extension: approvalBridge ? "xuanwu-pi-policy-v1" : ""
      },
      proof: [{
        kind: approvalBridge ? "adapter-callback" : "tool-selection",
        strength: approvalBridge ? "adapter-enforced" : "argument-passed",
        ref: `pi:${context.providerVersion || "unknown"}`
      }],
      warnings: []
    });
  }
};
