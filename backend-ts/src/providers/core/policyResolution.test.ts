import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { translateLegacyExecutionPolicy } from "./legacyExecutionPolicy.ts";
import {
  EXECUTION_POLICY_CONTRACT,
  PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  RESOLVED_EXECUTION_POLICY_CONTRACT,
  ExecutionPolicyError,
  type ExecutionPolicyRequest,
  type ProviderExecutionPolicyCapabilities,
  type ProviderPolicyContext
} from "./policyContracts.ts";
import { requestEffectSet, resolveExecutionPolicy, validateResolvedExecutionPolicy } from "./policyResolution.ts";

const context: ProviderPolicyContext = {
  cwd: "/tmp/project",
  invocationRef: "inv-1",
  projectId: "demo",
  providerId: asProviderId("codex"),
  providerVersion: "test",
  source: "local-user",
  transport: "rpc"
};

const capabilities: ProviderExecutionPolicyCapabilities = {
  contract: PROVIDER_EXECUTION_POLICY_CAPABILITIES_CONTRACT,
  isolation: "os-sandbox",
  combinations: [
    { access: "read-only", approval: "unattended", support: "native" },
    { access: "provider-native-development", approval: "ask-sensitive", support: "native" }
  ],
  defaultPolicy: policy("unrestricted-host", "unattended"),
  proofCapabilities: { nativeMode: "argument-passed", toolDecision: "provider-observed" }
};

describe("execution policy core", () => {
  test("access is a hard ceiling for every read-only approval value", () => {
    for (const approval of ["unattended", "ask-sensitive", "ask-every-side-effect"] as const) {
      const effects = requestEffectSet(policy("read-only", approval));
      expect(effects.toolEffects.filter((item) => item.riskClass !== "read").every((item) => item.decision === "deny")).toBe(true);
      expect(effects.filesystem.allowedEffects).toEqual(["project:read"]);
      expect(effects.network.allowedEffects).toEqual([]);
    }
  });

  test("ask-sensitive and ask-every-side-effect have different deterministic effects", () => {
    const sensitive = requestEffectSet(policy("provider-native-development", "ask-sensitive"));
    const every = requestEffectSet(policy("provider-native-development", "ask-every-side-effect"));
    expect(sensitive.toolEffects.find((item) => item.toolFamily === "write")?.decision).toBe("auto_allow");
    expect(sensitive.toolEffects.find((item) => item.toolFamily === "write-sensitive")?.decision).toBe("host_prompt");
    expect(every.toolEffects.find((item) => item.toolFamily === "write")?.decision).toBe("host_prompt");
  });

  test("rejects a mapper that expands read-only to a prompt", () => {
    const request = policy("read-only", "unattended");
    const effects = requestEffectSet(request);
    effects.toolEffects.find((item) => item.toolFamily === "write")!.decision = "host_prompt";
    expect(() => validateResolvedExecutionPolicy(request, {
      contract: RESOLVED_EXECUTION_POLICY_CONTRACT,
      requested: request,
      effects,
      isolation: "os-sandbox",
      nativeSummary: {},
      proof: [],
      warnings: []
    })).toThrow(ExecutionPolicyError);
  });

  test("unsupported combination is local to the requested provider policy", () => {
    expect(() => resolveExecutionPolicy(policy("unrestricted-host", "unattended"), context, capabilities, {
      resolvePolicy: () => { throw new Error("not called"); }
    })).toThrow("does not support");
  });

  test("legacy known values map deterministically and unknown values fail to safe effects", () => {
    expect(translateLegacyExecutionPolicy({ scope: "project", sandbox: "workspace-write", approvalPolicy: "never" }).policy)
      .toEqual(policy("provider-native-development", "unattended"));
    const unknown = translateLegacyExecutionPolicy({ scope: "project", sandbox: "future", approvalPolicy: "future" });
    expect(unknown.policy).toEqual(policy("read-only", "ask-every-side-effect"));
    expect(unknown.warnings).toEqual(["legacy_policy_unknown:sandbox", "legacy_policy_unknown:approval_policy"]);
  });
});

function policy(access: ExecutionPolicyRequest["access"], approval: ExecutionPolicyRequest["approval"]): ExecutionPolicyRequest {
  return { contract: EXECUTION_POLICY_CONTRACT, access, approval };
}
