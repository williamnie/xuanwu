import {
  DEFAULT_EXECUTION_POLICY,
  PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  EXECUTION_ACCESS_VALUES,
  EXECUTION_APPROVAL_VALUES,
  type ExecutionPolicyRequest,
  type ProviderExecutionPolicyCapabilities,
  type ProviderPolicyAdapter,
  type ProviderPolicyContext
} from "../core/policyContracts.ts";
import { requestEffectSet, resolvedPolicy } from "../core/policyResolution.ts";

export const CLAUDE_EXECUTION_POLICY_CAPABILITIES: ProviderExecutionPolicyCapabilities = {
  contract: PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  isolation: "tool-policy",
  combinations: EXECUTION_ACCESS_VALUES.flatMap((access) => EXECUTION_APPROVAL_VALUES.flatMap((approval) => [
    { access, approval, support: "adapter" as const, transports: ["sdk" as const] },
    {
      access,
      approval,
      support: approval === "unattended" && (access === "read-only" || access === "unrestricted-host") ? "native" as const : "unsupported" as const,
      transports: ["stdio-json" as const],
      ...(approval === "unattended" && (access === "read-only" || access === "unrestricted-host")
        ? {}
        : { reason: "Claude CLI fallback cannot provide the required host approval or project access ceiling" })
    }
  ])),
  defaultPolicy: DEFAULT_EXECUTION_POLICY,
  dynamicRestrictions: true,
  proofCapabilities: { nativeMode: "argument-passed", toolDecision: "adapter-enforced" }
};

export const claudeExecutionPolicyAdapter: ProviderPolicyAdapter = {
  resolvePolicy(request: ExecutionPolicyRequest, context: ProviderPolicyContext) {
    const readOnly = request.access === "read-only";
    const unattendedFull = request.access === "unrestricted-host" && request.approval === "unattended";
    const approvalBridge = request.access !== "read-only" && request.approval !== "unattended";
    const hostToolGate = request.access === "provider-native-development" || approvalBridge;
    const tools = readOnly ? ["Read", "Grep", "Glob"] : ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
    return resolvedPolicy(request, {
      effects: requestEffectSet(request),
      isolation: "tool-policy",
      nativeSummary: {
        tools,
        permissionMode: readOnly ? "dontAsk" : unattendedFull ? "bypassPermissions" : "default",
        allowDangerouslySkipPermissions: unattendedFull,
        approvalBridge,
        hostToolGate
      },
      proof: [{
        kind: hostToolGate ? "adapter-callback" : "provider-native",
        strength: hostToolGate ? "adapter-enforced" : "argument-passed",
        ref: `claude:${context.transport}:${context.providerVersion || "unknown"}`
      }],
      warnings: []
    });
  }
};
