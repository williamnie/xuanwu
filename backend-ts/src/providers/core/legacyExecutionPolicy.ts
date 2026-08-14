import {
  EXECUTION_POLICY_CONTRACT,
  type ExecutionAccess,
  type ExecutionApproval,
  type ExecutionPolicyRequest
} from "./policyContracts.ts";

export type LegacyExecutionPolicyInput = {
  sandbox?: unknown;
  approvalPolicy?: unknown;
  inherited?: ExecutionPolicyRequest;
  scope: "project" | "profile";
};

export type LegacyExecutionPolicyResult = {
  policy?: ExecutionPolicyRequest;
  source: "legacy" | "inherit";
  warnings: string[];
  unknown: Array<{ field: "sandbox" | "approval_policy"; value: string }>;
};

export function translateLegacyExecutionPolicy(input: LegacyExecutionPolicyInput): LegacyExecutionPolicyResult {
  const sandbox = clean(input.sandbox);
  const approval = clean(input.approvalPolicy);
  if (input.scope === "profile" && sandbox === "" && approval === "") {
    return { source: "inherit", warnings: [], unknown: [] };
  }

  const unknown: LegacyExecutionPolicyResult["unknown"] = [];
  const access = legacyAccess(sandbox, input.scope, input.inherited, unknown);
  const resolvedApproval = legacyApproval(approval, input.scope, input.inherited, unknown);
  const warnings = unknown.map(({ field }) => `legacy_policy_unknown:${field}`);
  return {
    policy: { contract: EXECUTION_POLICY_CONTRACT, access, approval: resolvedApproval },
    source: "legacy",
    warnings,
    unknown
  };
}

function legacyAccess(
  value: string,
  scope: LegacyExecutionPolicyInput["scope"],
  inherited: ExecutionPolicyRequest | undefined,
  unknown: LegacyExecutionPolicyResult["unknown"]
): ExecutionAccess {
  switch (value) {
    case "read-only": return "read-only";
    case "workspace-write": return "provider-native-development";
    case "danger-full-access": return "unrestricted-host";
    case "": return scope === "profile" ? inherited?.access ?? "read-only" : "provider-native-development";
    default:
      unknown.push({ field: "sandbox", value: bounded(value) });
      return "read-only";
  }
}

function legacyApproval(
  value: string,
  scope: LegacyExecutionPolicyInput["scope"],
  inherited: ExecutionPolicyRequest | undefined,
  unknown: LegacyExecutionPolicyResult["unknown"]
): ExecutionApproval {
  switch (value) {
    case "never": return "unattended";
    case "danger-only":
    case "on-request": return "ask-sensitive";
    case "always":
    case "untrusted": return "ask-every-side-effect";
    case "": return scope === "profile" ? inherited?.approval ?? "ask-every-side-effect" : "unattended";
    default:
      unknown.push({ field: "approval_policy", value: bounded(value) });
      return "ask-every-side-effect";
  }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function bounded(value: string): string {
  return value.slice(0, 128);
}
