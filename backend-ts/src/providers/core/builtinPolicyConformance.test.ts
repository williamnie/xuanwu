import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { CODEX_EXECUTION_POLICY_CAPABILITIES, codexExecutionPolicyAdapter } from "../codex/executionPolicy.ts";
import { CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter } from "../claude/executionPolicy.ts";
import { PI_EXECUTION_POLICY_CAPABILITIES, piExecutionPolicyAdapter } from "../pi/executionPolicy.ts";
import { QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter } from "../qoder/executionPolicy.ts";
import { EXECUTION_ACCESS_VALUES, EXECUTION_APPROVAL_VALUES, EXECUTION_POLICY_CONTRACT } from "./policyContracts.ts";
import { resolveExecutionPolicy } from "./policyResolution.ts";

const providers = [
  ["codex", "rpc", CODEX_EXECUTION_POLICY_CAPABILITIES, codexExecutionPolicyAdapter],
  ["claude", "sdk", CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter],
  ["pi-coding-agent", "rpc", PI_EXECUTION_POLICY_CAPABILITIES, piExecutionPolicyAdapter],
  ["qoder", "sdk", QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter]
] as const;

describe("built-in provider execution policy conformance", () => {
  for (const [provider, transport, capabilities, adapter] of providers) {
    test(`${provider} resolves its declared 3 x 3 matrix without expanding access`, () => {
      for (const access of EXECUTION_ACCESS_VALUES) {
        for (const approval of EXECUTION_APPROVAL_VALUES) {
          const resolved = resolveExecutionPolicy(
            { contract: EXECUTION_POLICY_CONTRACT, access, approval },
            {
              cwd: "/tmp/project",
              invocationRef: `inv-${provider}`,
              projectId: "demo",
              providerId: asProviderId(provider),
              providerVersion: "test",
              source: "local-user",
              transport
            },
            capabilities,
            adapter
          );
          expect(resolved.requested).toEqual({ contract: EXECUTION_POLICY_CONTRACT, access, approval });
        }
      }
    });
  }

  test("unrestricted ask modes do not use native bypass", () => {
    for (const [provider, transport, capabilities, adapter] of providers.filter(([id]) => id === "claude" || id === "qoder")) {
      const resolved = resolveExecutionPolicy(
        { contract: EXECUTION_POLICY_CONTRACT, access: "unrestricted-host", approval: "ask-every-side-effect" },
        {
          cwd: "/tmp/project",
          invocationRef: `inv-${provider}`,
          projectId: "demo",
          providerId: asProviderId(provider),
          providerVersion: "test",
          source: "local-user",
          transport
        },
        capabilities,
        adapter
      );
      expect(resolved.nativeSummary.permissionMode).not.toBe("bypassPermissions");
    }
  });

  test("read-only approval variants preserve the hard ceiling and report that approval has no effect", () => {
    for (const [provider, transport, capabilities, adapter] of providers) {
      for (const approval of ["ask-sensitive", "ask-every-side-effect"] as const) {
        const resolved = resolveExecutionPolicy(
          { contract: EXECUTION_POLICY_CONTRACT, access: "read-only", approval },
          {
            cwd: "/tmp/project",
            invocationRef: `inv-${provider}`,
            projectId: "demo",
            providerId: asProviderId(provider),
            providerVersion: "test",
            source: "local-user",
            transport
          },
          capabilities,
          adapter
        );
        expect(resolved.warnings).toContain("approval_has_no_additional_effect");
        expect(resolved.effects.toolEffects.filter((effect) => effect.riskClass !== "read").every((effect) => effect.decision === "deny")).toBe(true);
      }
    }
  });
});
