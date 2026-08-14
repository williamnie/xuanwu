import type { ProviderId } from "../types.ts";
import type { ProviderTransport } from "./manifest.ts";

export const EXECUTION_POLICY_CONTRACT = "xw.execution-policy.v1" as const;
export const RESOLVED_EXECUTION_POLICY_CONTRACT = "xw.resolved-execution-policy.v1" as const;
export const PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT =
  "xw.provider-execution-policy-capabilities.v1" as const;

export const EXECUTION_ACCESS_VALUES = [
  "read-only",
  "provider-native-development",
  "unrestricted-host"
] as const;

export const EXECUTION_APPROVAL_VALUES = [
  "unattended",
  "ask-sensitive",
  "ask-every-side-effect"
] as const;

export type ExecutionAccess = (typeof EXECUTION_ACCESS_VALUES)[number];
export type ExecutionApproval = (typeof EXECUTION_APPROVAL_VALUES)[number];

export type ExecutionPolicyRequest = {
  contract: typeof EXECUTION_POLICY_CONTRACT;
  access: ExecutionAccess;
  approval: ExecutionApproval;
};

export const DEFAULT_EXECUTION_POLICY: ExecutionPolicyRequest = Object.freeze({
  contract: EXECUTION_POLICY_CONTRACT,
  access: "unrestricted-host",
  approval: "unattended"
});

export type ProviderIsolationKind = "os-sandbox" | "tool-policy" | "tool-selection" | "none";
export type ProviderPolicySupport = "native" | "adapter" | "unsupported";

export type ProviderPolicyCombination = {
  access: ExecutionAccess;
  approval: ExecutionApproval;
  support: ProviderPolicySupport;
  transports?: readonly ProviderTransport[];
  reason?: string;
};

export type ProviderPolicyProofCapabilities = {
  nativeMode: "provider-observed" | "argument-passed" | "documented-only";
  toolDecision: "adapter-enforced" | "provider-observed" | "argument-passed" | "none";
};

export type ProviderExecutionPolicyCapabilities = {
  contract: typeof PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT;
  isolation: ProviderIsolationKind;
  combinations: readonly ProviderPolicyCombination[];
  defaultPolicy: ExecutionPolicyRequest;
  dynamicRestrictions?: boolean;
  proofCapabilities: ProviderPolicyProofCapabilities;
};

export type PolicyDecision = "deny" | "host_prompt" | "provider_prompt" | "auto_allow";
export type PolicyRiskClass = "read" | "write" | "network" | "command";
export type PolicySensitivity = "read" | "routine" | "sensitive";

export type ResolvedToolEffect = {
  toolFamily: string;
  decision: PolicyDecision;
  scope: string;
  riskClass: PolicyRiskClass;
  sensitivity: PolicySensitivity;
  ttl?: string;
};

export type ResolvedPolicyEffectSet = {
  toolEffects: ResolvedToolEffect[];
  filesystem: { allowedEffects: string[] };
  network: { allowedEffects: string[] };
};

export type PolicyProof = {
  kind: "provider-native" | "adapter-callback" | "tool-selection" | "action-gate";
  strength: "provider-observed" | "adapter-enforced" | "argument-passed" | "documented-only";
  ref: string;
};

export type NativePolicySummaryValue = boolean | number | string | string[];

export type ResolvedExecutionPolicy = {
  contract: typeof RESOLVED_EXECUTION_POLICY_CONTRACT;
  requested: ExecutionPolicyRequest;
  effects: ResolvedPolicyEffectSet;
  isolation: ProviderIsolationKind;
  nativeSummary: Record<string, NativePolicySummaryValue>;
  proof: PolicyProof[];
  warnings: string[];
};

export type ProviderPolicyContext = {
  cwd: string;
  invocationRef: string;
  projectId: string;
  providerId: ProviderId;
  providerVersion: string;
  source: "local-user" | "automation" | "external-channel" | "recovery";
  transport: ProviderTransport;
};

export interface ProviderPolicyAdapter {
  resolvePolicy(request: ExecutionPolicyRequest, context: ProviderPolicyContext): ResolvedExecutionPolicy;
}

export function isExecutionAccess(value: unknown): value is ExecutionAccess {
  return typeof value === "string" && (EXECUTION_ACCESS_VALUES as readonly string[]).includes(value);
}

export function isExecutionApproval(value: unknown): value is ExecutionApproval {
  return typeof value === "string" && (EXECUTION_APPROVAL_VALUES as readonly string[]).includes(value);
}

export function executionPolicyRequest(value: unknown): ExecutionPolicyRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw executionPolicyError("policy_invalid", "execution policy must be an object");
  }
  const input = value as Record<string, unknown>;
  if (input.contract !== EXECUTION_POLICY_CONTRACT) {
    throw executionPolicyError("policy_invalid", `execution policy contract must be ${EXECUTION_POLICY_CONTRACT}`);
  }
  if (!isExecutionAccess(input.access)) {
    throw executionPolicyError("policy_invalid", `unknown execution access ${JSON.stringify(input.access)}`);
  }
  if (!isExecutionApproval(input.approval)) {
    throw executionPolicyError("policy_invalid", `unknown execution approval ${JSON.stringify(input.approval)}`);
  }
  return { contract: EXECUTION_POLICY_CONTRACT, access: input.access, approval: input.approval };
}

export function allPolicyCombinations(
  support: ProviderPolicySupport,
  transports?: readonly ProviderTransport[]
): ProviderPolicyCombination[] {
  return EXECUTION_ACCESS_VALUES.flatMap((access) => EXECUTION_APPROVAL_VALUES.map((approval) => ({
    access,
    approval,
    support,
    ...(transports ? { transports } : {})
  })));
}

export type ExecutionPolicyErrorCode =
  | "policy_invalid"
  | "policy_combination_unsupported"
  | "policy_mapping_unsafe"
  | "legacy_policy_unknown";

export class ExecutionPolicyError extends Error {
  override readonly name = "ExecutionPolicyError";
  constructor(
    readonly code: ExecutionPolicyErrorCode,
    message: string,
    readonly details: {
      alternatives?: Array<{ access: ExecutionAccess; approval: ExecutionApproval }>;
      providerId?: string;
      transport?: ProviderTransport;
    } = {}
  ) {
    super(message);
  }
}

export function executionPolicyError(
  code: ExecutionPolicyErrorCode,
  message: string,
  details?: ExecutionPolicyError["details"]
): ExecutionPolicyError {
  return new ExecutionPolicyError(code, message, details);
}
