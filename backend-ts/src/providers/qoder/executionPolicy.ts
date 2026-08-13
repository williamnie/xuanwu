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

export const QODER_EXECUTION_POLICY_CAPABILITIES: ProviderExecutionPolicyCapabilities = {
  contract: PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  isolation: "tool-policy",
  combinations: allPolicyCombinations("adapter", ["sdk"]),
  defaultPolicy: DEFAULT_EXECUTION_POLICY,
  dynamicRestrictions: true,
  proofCapabilities: { nativeMode: "provider-observed", toolDecision: "adapter-enforced" }
};

export const qoderExecutionPolicyAdapter: ProviderPolicyAdapter = {
  resolvePolicy(request: ExecutionPolicyRequest, context: ProviderPolicyContext) {
    const readOnly = request.access === "read-only";
    const unattendedFull = request.access === "unrestricted-host" && request.approval === "unattended";
    const approvalBridge = request.access !== "read-only" && request.approval !== "unattended";
    const tools = readOnly
      ? ["Read", "Grep", "Glob"]
      : ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "NotebookEdit"];
    return resolvedPolicy(request, {
      effects: requestEffectSet(request),
      isolation: "tool-policy",
      nativeSummary: {
        tools,
        permissionMode: readOnly ? "dontAsk" : unattendedFull ? "bypassPermissions" : "default",
        allowDangerouslySkipPermissions: unattendedFull,
        approvalBridge
      },
      proof: [
        { kind: "provider-native", strength: "provider-observed", ref: `qoder:${context.providerVersion || "unknown"}` },
        ...(approvalBridge ? [{
          kind: "adapter-callback" as const,
          strength: "adapter-enforced" as const,
          ref: "qoder:canUseTool"
        }] : [])
      ],
      warnings: []
    });
  }
};
