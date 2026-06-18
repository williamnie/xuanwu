import { describe, expect, test } from "bun:test";
import { evaluateApprovalFastPolicy } from "./approvalFastPolicy.ts";
import { unavailableApprovalPolicyCache } from "./approvalPolicyCache.ts";

describe("approval fast policy", () => {
  test("returns deny-now for deterministic safety hits before allow-list", () => {
    const decision = evaluateApprovalFastPolicy({
      method: "item/commandExecution/requestApproval",
      params: { command: "sudo git status CODEX_API_KEY=fixture-secret /Users/example/private", cwd: "/workspace/demo" }
    });

    if (decision.decision !== "deny-now") throw new Error("expected deny-now");
    const reason = decision.reason;
    expect(decision).toMatchObject({
      decision: "deny-now",
      resolver_decision: { decision: "deny" },
      reason: expect.stringContaining("CODEX_API_KEY=[redacted]"),
      rule_id: "pi_approval_deny_privilege_escalation"
    });
    expect(reason.includes("fixture-secret")).toBe(false);
    expect(reason.includes("/Users/example")).toBe(false);
  });

  test("approves exact current-repo low-risk commands once", () => {
    const cases = [
      ["git status", "pi_approval_allow_current_repo_git_read_once"],
      ["git diff ./src/../README.md", "pi_approval_allow_current_repo_git_read_once"],
      ["cat README.md", "pi_approval_allow_current_repo_read_only_once"],
      ["rg TODO src", "pi_approval_allow_current_repo_read_only_once"],
      ["bun test", "pi_approval_allow_current_repo_validation_once"],
      ["npm run lint", "pi_approval_allow_current_repo_validation_once"],
      ["pnpm build", "pi_approval_allow_current_repo_validation_once"],
      ["yarn typecheck", "pi_approval_allow_current_repo_validation_once"],
      ["bunx tsc -p tsconfig.json --noEmit", "pi_approval_allow_current_repo_validation_once"]
    ];

    for (const [command, ruleID] of cases) {
      expect(commandDecision(command)).toMatchObject({
        decision: "approve-now",
        resolver_decision: { decision: "approve", scope: "turn" },
        rule_id: ruleID
      });
    }
  });

  test("approves exact small file changes within cwd once", () => {
    expect(evaluateApprovalFastPolicy({
      method: "item/fileChange/requestApproval",
      params: {
        changes: [{ path: "src/App.tsx" }, { path: "./src/../README.md" }],
        cwd: "/workspace/demo"
      }
    })).toMatchObject({
      decision: "approve-now",
      resolver_decision: { decision: "approve", scope: "turn" },
      rule_id: "pi_approval_allow_current_repo_file_change_once"
    });
  });

  test("denies allow-list misses and paths that normalize outside cwd", () => {
    expect(commandDecision("python scripts/release.py")).toMatchObject({
      decision: "deny-now",
      rule_id: "pi_approval_deny_allowlist_miss"
    });
    expect(commandDecision("npm run lint -- --fix")).toMatchObject({
      decision: "deny-now",
      rule_id: "pi_approval_deny_allowlist_miss"
    });
    expect(commandDecision("cat $(pwd)/README.md")).toMatchObject({
      decision: "deny-now",
      rule_id: "pi_approval_deny_allowlist_miss"
    });

    expect(evaluateApprovalFastPolicy({
      method: "item/fileChange/requestApproval",
      params: { changes: [{ path: "./src/../../outside.txt" }], cwd: "/workspace/demo" }
    })).toMatchObject({
      decision: "deny-now",
      rule_id: "pi_approval_deny_allowlist_miss"
    });
  });

  test("denies ambiguous requests and unavailable policy cache", () => {
    expect(evaluateApprovalFastPolicy({
      method: "item/commandExecution/requestApproval",
      params: {}
    })).toMatchObject({
      decision: "deny-now",
      rule_id: "pi_approval_deny_ambiguous_request"
    });

    expect(evaluateApprovalFastPolicy({
      method: "item/commandExecution/requestApproval",
      params: { command: "git status", cwd: "/workspace/demo" },
      policyCache: unavailableApprovalPolicyCache("cache cold")
    })).toMatchObject({
      decision: "deny-now",
      reason: "cache cold",
      rule_id: "pi_approval_deny_policy_cache_unavailable"
    });
  });
});

function commandDecision(command: string) {
  return evaluateApprovalFastPolicy({
    method: "item/commandExecution/requestApproval",
    params: { command, cwd: "/workspace/demo" }
  });
}
