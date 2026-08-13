import {
  DEFAULT_EXECUTION_POLICY,
  executionPolicyRequest,
  type ExecutionPolicyRequest
} from "./policyContracts.ts";
import { translateLegacyExecutionPolicy } from "./legacyExecutionPolicy.ts";

export type StoredExecutionPolicy = {
  policy?: ExecutionPolicyRequest;
  source: "default" | "legacy" | "profile" | "project" | "inherit";
  warnings: string[];
};

export function parseExecutionPolicyWrite(value: unknown, options: { allowEmpty: boolean }): ExecutionPolicyRequest | undefined {
  if (value === undefined || value === null || value === "") {
    if (options.allowEmpty) return undefined;
    return structuredClone(DEFAULT_EXECUTION_POLICY);
  }
  let raw = value;
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "" || text === "{}") {
      if (options.allowEmpty) return undefined;
      return structuredClone(DEFAULT_EXECUTION_POLICY);
    }
    try { raw = JSON.parse(text); } catch { throw new Error("execution_policy_json must be valid JSON"); }
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw as Record<string, unknown>).length === 0) {
    if (options.allowEmpty) return undefined;
    return structuredClone(DEFAULT_EXECUTION_POLICY);
  }
  return executionPolicyRequest(raw);
}

export function executionPolicyJSON(policy: ExecutionPolicyRequest | undefined): string {
  return policy ? JSON.stringify(policy) : "{}";
}

export function readStoredExecutionPolicy(input: {
  approvalPolicy?: unknown;
  json?: unknown;
  sandbox?: unknown;
  scope: "profile" | "project";
}): StoredExecutionPolicy {
  const json = typeof input.json === "string" ? input.json.trim() : "";
  if (json !== "" && json !== "{}") {
    try {
      const policy = executionPolicyRequest(JSON.parse(json));
      return { policy, source: input.scope, warnings: [] };
    } catch {
      const fallback = translateLegacyExecutionPolicy({
        approvalPolicy: input.approvalPolicy,
        sandbox: input.sandbox,
        scope: input.scope
      });
      return {
        policy: fallback.policy ?? (input.scope === "project" ? structuredClone(DEFAULT_EXECUTION_POLICY) : undefined),
        source: fallback.policy ? "legacy" : input.scope === "project" ? "default" : "inherit",
        warnings: ["stored_execution_policy_invalid", ...fallback.warnings]
      };
    }
  }
  const legacy = translateLegacyExecutionPolicy({
    approvalPolicy: input.approvalPolicy,
    sandbox: input.sandbox,
    scope: input.scope
  });
  if (legacy.policy) return { policy: legacy.policy, source: "legacy", warnings: legacy.warnings };
  return input.scope === "project"
    ? { policy: structuredClone(DEFAULT_EXECUTION_POLICY), source: "default", warnings: legacy.warnings }
    : { source: "inherit", warnings: legacy.warnings };
}

export function legacyProjection(policy: ExecutionPolicyRequest): { approval_policy: string; sandbox: string } {
  return {
    approval_policy: policy.approval === "unattended"
      ? "never"
      : policy.approval === "ask-sensitive" ? "danger-only" : "always",
    sandbox: policy.access === "read-only"
      ? "read-only"
      : policy.access === "provider-native-development" ? "workspace-write" : "danger-full-access"
  };
}

export function policyFromLegacyWrite(input: { approvalPolicy?: unknown; sandbox?: unknown; scope: "profile" | "project" }): ExecutionPolicyRequest | undefined {
  const translated = translateLegacyExecutionPolicy(input);
  if (translated.unknown.length > 0) {
    throw new Error(`unknown legacy execution policy value for ${translated.unknown.map((item) => item.field).join(", ")}`);
  }
  return translated.policy;
}

export function executionPolicyInput(input: Record<string, unknown>): unknown {
  if (Object.hasOwn(input, "execution_policy")) return input.execution_policy;
  if (Object.hasOwn(input, "execution_policy_json")) return input.execution_policy_json;
  return undefined;
}
