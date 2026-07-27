import { parseCodexApprovalRequest, type NormalizedApprovalRequest } from "./approvalRequestParser.ts";
import { approvalPolicyCacheSnapshot, type ApprovalPolicyCacheSnapshot } from "./approvalPolicyCache.ts";
import {
  evaluateApprovalSafetyPolicy,
  type ApprovalSafetyDecision,
  type ApprovalSafetyInput,
  type ApprovalSafetyRuleID
} from "./approvalSafetyPolicy.ts";
import type { ApprovalDecision } from "../providers/types.ts";

export type ApprovalFastDecision =
  | {
      decision: "approve-now";
      reason: string;
      resolver_decision: ApprovalDecision;
      rule_id: ApprovalAllowRuleID;
      session_grant: ApprovalFastSessionGrant;
    }
  | {
      decision: "deny-now";
      reason: string;
      resolver_decision: ApprovalDecision;
      rule_id: ApprovalSafetyRuleID | ApprovalUnknownRuleID;
      session_grant: ApprovalFastSessionGrant;
    }
  | {
      decision: "ask-user";
      reason: string;
      rule_id: ApprovalSafetyRuleID | ApprovalUnknownRuleID;
    };

export type ApprovalFastInput = ApprovalSafetyInput & {
  jsonRpcId?: string | number;
  policyCache?: ApprovalPolicyCacheSnapshot;
};

export type ApprovalAllowRuleID =
  | "pi_approval_allow_current_repo_file_change_once"
  | "pi_approval_allow_current_repo_git_read_once"
  | "pi_approval_allow_current_repo_read_only_once"
  | "pi_approval_allow_current_repo_validation_once";

export type ApprovalUnknownRuleID =
  | "pi_approval_deny_ambiguous_request"
  | "pi_approval_deny_allowlist_miss"
  | "pi_approval_deny_policy_cache_unavailable";

type AllowMatch = { reason: string; rule_id: ApprovalAllowRuleID };
export type ApprovalFastSessionGrant = {
  enabled: false;
  expires_at: "";
  reason: string;
  reusable: false;
  ttl_ms: 0;
};

const DISABLED_SESSION_GRANT: ApprovalFastSessionGrant = {
  enabled: false,
  expires_at: "",
  reason: "provider acceptForSession semantics are not proven narrow",
  reusable: false,
  ttl_ms: 0
};

export function evaluateApprovalFastPolicy(input: ApprovalFastInput): ApprovalFastDecision {
  const safetyDecision = fastSafetyDecision(evaluateApprovalSafetyPolicy(input));
  if (safetyDecision) return safetyDecision;
  return allowListDecision(input);
}

function fastSafetyDecision(decision: ApprovalSafetyDecision): ApprovalFastDecision | null {
  if (decision.decision === "deny") return denyNow(decision.reason, decision.rule_id);
  if (decision.decision === "ask") return askUser(decision.reason, decision.rule_id);
  return null;
}

function allowListDecision(input: ApprovalFastInput): ApprovalFastDecision {
  const cache = input.policyCache ?? approvalPolicyCacheSnapshot();
  if (!cache.available) {
    return denyNow(cache.unavailable_reason ?? "policy cache unavailable", "pi_approval_deny_policy_cache_unavailable");
  }
  const parsed = parseCodexApprovalRequest({ jsonRpcId: input.jsonRpcId, method: input.method, params: input.params });
  if (parsed.parse_status !== "ok") return denyNow("approval request is ambiguous", "pi_approval_deny_ambiguous_request");
  const match = allowListMatch(parsed, cache);
  if (!match) {
    if (parsed.request_type === "command" || parsed.request_type === "fileChange") {
      return askUser("approval request requires explicit user confirmation", "pi_approval_deny_allowlist_miss");
    }
    return denyNow("approval request is not an exact low-risk allow-list match", "pi_approval_deny_allowlist_miss");
  }
  return {
    decision: "approve-now",
    reason: match.reason,
    resolver_decision: { decision: "approve", scope: "turn" },
    rule_id: match.rule_id,
    session_grant: DISABLED_SESSION_GRANT
  };
}

function allowListMatch(request: NormalizedApprovalRequest, cache: ApprovalPolicyCacheSnapshot): AllowMatch | null {
  if (request.request_type === "fileChange") return smallFileChangeMatch(request, cache);
  if (request.request_type !== "command") return null;
  if (!commandScopeWithinCwd(request)) return null;
  return commandAllowMatch(request.command, cache);
}

function commandAllowMatch(command: string, cache: ApprovalPolicyCacheSnapshot): AllowMatch | null {
  if (hasAmbiguousShellSyntax(command)) return null;
  const argv = shellWords(command);
  if (argv.length === 0) return null;
  if (isGitReadOnlyCommand(argv, cache.git_read_only_subcommands)) {
    return allow("pi_approval_allow_current_repo_git_read_once", "current repo git read-only command");
  }
  if (isReadOnlyCommand(argv, cache.read_only_commands)) {
    return allow("pi_approval_allow_current_repo_read_only_once", "current repo read-only command");
  }
  if (isValidationCommand(argv, cache)) {
    return allow("pi_approval_allow_current_repo_validation_once", "current repo validation command");
  }
  return null;
}

function hasAmbiguousShellSyntax(command: string): boolean {
  return /(?:&&|\|\||[;&|<>`]|\$\(|\$\{|\$[A-Za-z_])/.test(command);
}

function smallFileChangeMatch(request: NormalizedApprovalRequest, cache: ApprovalPolicyCacheSnapshot): AllowMatch | null {
  return request.normalized_scope.all_paths_within_cwd && request.paths.length <= cache.small_file_change_max_paths
    ? allow("pi_approval_allow_current_repo_file_change_once", "current repo small file change")
    : null;
}

function commandScopeWithinCwd(request: NormalizedApprovalRequest): boolean {
  if (request.normalized_scope.cwd === "") return false;
  return request.paths.length === 0 || request.normalized_scope.all_paths_within_cwd;
}

function isGitReadOnlyCommand(argv: string[], allowedSubcommands: readonly string[]): boolean {
  if (argv[0] !== "git") return false;
  const subcommand = argv.find((item, index) => index > 0 && !item.startsWith("-")) ?? "";
  return allowedSubcommands.includes(subcommand);
}

function isReadOnlyCommand(argv: string[], readOnlyCommands: readonly string[]): boolean {
  const command = argv[0] ?? "";
  if (!readOnlyCommands.includes(command)) return false;
  if (command === "find") return !argv.some((item) => item === "-delete" || item === "-exec" || item === "-execdir");
  if (command === "sed") return !argv.some((item) => item === "-i" || item.startsWith("-i"));
  return true;
}

function isValidationCommand(argv: string[], cache: ApprovalPolicyCacheSnapshot): boolean {
  if (hasMutatingValidationFlag(argv)) return false;
  const command = argv[0] ?? "";
  if (cache.typecheck_commands.includes(command)) return true;
  if (!cache.package_managers.includes(command)) return false;
  const script = packageScriptName(argv);
  return script !== "" && (cache.package_scripts.includes(script) || cache.typecheck_commands.includes(script));
}

function hasMutatingValidationFlag(argv: string[]): boolean {
  return argv.some((item) => {
    const flag = item.trim();
    return flag === "-u" ||
      flag === "-w" ||
      flag === "--watch" ||
      flag === "--watchAll" ||
      flag.startsWith("--fix") ||
      flag.startsWith("--update") ||
      flag.startsWith("--write");
  });
}

function packageScriptName(argv: string[]): string {
  if (argv.length < 2) return "";
  if (argv[0] === "yarn") return argv[1] === "run" ? argv[2] ?? "" : argv[1] ?? "";
  if (argv[1] === "run") return argv[2] ?? "";
  return argv[1] ?? "";
}

function shellWords(command: string): string[] {
  const words: string[] = [];
  const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)'|`([^`]*)`|(\S+)/g;
  for (const match of command.matchAll(pattern)) {
    const token = match[1] ?? match[2] ?? match[3] ?? match[4] ?? "";
    if (token !== "") words.push(token.replace(/\\([\s"'`\\])/g, "$1"));
  }
  return words;
}

function allow(rule_id: ApprovalAllowRuleID, reason: string): AllowMatch {
  return { reason, rule_id };
}

function denyNow(
  reason: string,
  rule_id: ApprovalSafetyRuleID | ApprovalUnknownRuleID
): ApprovalFastDecision {
  return {
    decision: "deny-now",
    reason,
    resolver_decision: { decision: "deny", scope: "turn" },
    rule_id,
    session_grant: DISABLED_SESSION_GRANT
  };
}

function askUser(
  reason: string,
  rule_id: ApprovalSafetyRuleID | ApprovalUnknownRuleID
): ApprovalFastDecision {
  return { decision: "ask-user", reason, rule_id };
}
