import { redactSensitiveText } from "../util/redact.ts";
import { resolve } from "node:path";

export type ApprovalSafetyInput = {
  method: string;
  params?: Record<string, unknown>;
};

export type ApprovalSafetyRuleID =
  | "pi_approval_deny_cross_workspace"
  | "pi_approval_ask_destructive_filesystem"
  | "pi_approval_ask_destructive_git"
  | "pi_approval_deny_privilege_escalation"
  | "pi_approval_deny_remote_script_execution"
  | "pi_approval_deny_secret_access"
  | "pi_approval_deny_system_path";

export type ApprovalSafetyDecision =
  | { decision: "none" }
  | { decision: "ask" | "deny"; reason: string; rule_id: ApprovalSafetyRuleID };

type ApprovalSafetyContext = {
  command: string;
  cwd: string;
  path: string;
  paths: string[];
};

type RuleMatch = {
  evidence: string;
  label: string;
  rule_id: ApprovalSafetyRuleID;
};

const COMMAND_BOUNDARY = String.raw`(?:^|[\s;&|()])`;
const PRIVILEGE_PATTERN = new RegExp(`${COMMAND_BOUNDARY}(?:sudo|su)(?:\\s|$|-)`, "i");
const RM_RF_PATTERN = new RegExp(`${COMMAND_BOUNDARY}rm\\s+(?=[^;&|]*-[^;&|\\s]*r)(?=[^;&|]*-[^;&|\\s]*f)`, "i");
const GIT_RESET_PATTERN = new RegExp(`${COMMAND_BOUNDARY}git\\s+reset(?:\\s|$)`, "i");
const GIT_FORCE_PUSH_PATTERN = new RegExp(`${COMMAND_BOUNDARY}git\\s+push(?=[^;&|]*(?:--force|-f(?:\\s|$)))`, "i");
const REMOTE_SCRIPT_PATTERNS = [
  /\b(?:curl|wget)\b[^;&]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|fish)\b/i,
  /\b(?:sh|bash|zsh|fish)\s+-c\s+["'`][^"'`]*(?:curl|wget)\b/i,
  /\beval\s+["'`$ ()]*(?:curl|wget)\b/i
];
const SECRET_PATTERN =
  /(?:^|[\s"'`=])(?:~\/)?\.ssh(?:\/|\s|$)|(?:^|[\s"'`=])\.env(?:[.\w-]*)?(?:\s|$)|\b(?:id_rsa|id_ed25519|known_hosts|authorized_keys|keychain|login\.keychain|credentials?|secrets?|token|api[_-]?key|access[_-]?key|password|\.pem|\.p12|\.pfx)\b/i;
const SYSTEM_COMMAND_PATTERN = new RegExp(`${COMMAND_BOUNDARY}(?:launchctl|systemctl|service)(?:\\s|$)`, "i");
const SYSTEM_PATH_PATTERN = /(?:^|[\s"'`=])\/(?:Library|System|etc)(?:\/|\s|$)|(?:^|[\s"'`=])\/usr\/local(?:\/|\s|$)/;
const PARENT_PATH_PATTERN = /(?:^|[\s"'`=])\.\.(?:\/|\s|$)/;
const ABSOLUTE_PATH_PATTERN = /(^|[\s"'`=])((?:\/|~\/)[^\s"'`,;|)]+)/g;
const REASON_MAX_LENGTH = 240;

export function evaluateApprovalSafetyPolicy(input: ApprovalSafetyInput): ApprovalSafetyDecision {
  const context = approvalSafetyContext(input);
  const denied = firstHardDenyRuleMatch(context);
  if (denied) return { decision: "deny", reason: policyReason(denied), rule_id: denied.rule_id };
  const review = firstReviewRuleMatch(context);
  if (!review) return { decision: "none" };
  return {
    decision: "ask",
    reason: policyReason(review),
    rule_id: review.rule_id
  };
}

function firstHardDenyRuleMatch(context: ApprovalSafetyContext): RuleMatch | null {
  return [
    privilegeEscalationRule(context),
    remoteScriptRule(context),
    secretAccessRule(context),
    systemPathRule(context),
    crossWorkspaceRule(context)
  ].find(Boolean) ?? null;
}

function firstReviewRuleMatch(context: ApprovalSafetyContext): RuleMatch | null {
  return [destructiveFilesystemRule(context), destructiveGitRule(context)].find(Boolean) ?? null;
}

function approvalSafetyContext(input: ApprovalSafetyInput): ApprovalSafetyContext {
  const params = input.params ?? {};
  const item = recordValue(params.item);
  const paths = [cleanString(params.path ?? item.path), ...changesPaths(params), ...changesPaths(item)].filter(Boolean);
  return {
    command: cleanString(params.command ?? item.command),
    cwd: cleanString(params.cwd ?? params.workingDirectory ?? params.workspace ?? item.cwd),
    path: paths.join(" "),
    paths
  };
}

function privilegeEscalationRule(context: ApprovalSafetyContext): RuleMatch | null {
  return PRIVILEGE_PATTERN.test(context.command)
    ? rule("pi_approval_deny_privilege_escalation", "privilege escalation", context.command)
    : null;
}

function destructiveFilesystemRule(context: ApprovalSafetyContext): RuleMatch | null {
  return RM_RF_PATTERN.test(context.command)
    ? rule("pi_approval_ask_destructive_filesystem", "destructive filesystem command requires user approval", context.command)
    : null;
}

function destructiveGitRule(context: ApprovalSafetyContext): RuleMatch | null {
  return GIT_RESET_PATTERN.test(context.command) || GIT_FORCE_PUSH_PATTERN.test(context.command)
    ? rule("pi_approval_ask_destructive_git", "destructive git command requires user approval", context.command)
    : null;
}

function remoteScriptRule(context: ApprovalSafetyContext): RuleMatch | null {
  return REMOTE_SCRIPT_PATTERNS.some((pattern) => pattern.test(context.command))
    ? rule("pi_approval_deny_remote_script_execution", "remote script execution", context.command)
    : null;
}

function secretAccessRule(context: ApprovalSafetyContext): RuleMatch | null {
  const text = targetText(context);
  return SECRET_PATTERN.test(text)
    ? rule("pi_approval_deny_secret_access", "secret or credential access", text)
    : null;
}

function systemPathRule(context: ApprovalSafetyContext): RuleMatch | null {
  const text = targetText(context);
  return SYSTEM_COMMAND_PATTERN.test(context.command) || SYSTEM_PATH_PATTERN.test(text)
    ? rule("pi_approval_deny_system_path", "system path or service access", text)
    : null;
}

function crossWorkspaceRule(context: ApprovalSafetyContext): RuleMatch | null {
  if (PARENT_PATH_PATTERN.test(targetText(context))) {
    return rule("pi_approval_deny_cross_workspace", "cross workspace path access", targetText(context));
  }
  const cwd = normalizeAbsolutePath(context.cwd);
  if (cwd === "") return null;
  const relativeOutside = context.paths.find((path) => {
    if (path.startsWith("/")) return false;
    return !isPathWithin(normalizeAbsolutePath(resolve(cwd, path)), cwd);
  });
  if (relativeOutside) return rule("pi_approval_deny_cross_workspace", "cross workspace path access", relativeOutside);
  const outside = absolutePaths(targetText(context)).find((path) => !isPathWithin(path, cwd));
  return outside ? rule("pi_approval_deny_cross_workspace", "cross workspace path access", outside) : null;
}

function targetText(context: ApprovalSafetyContext): string {
  return [context.command, context.path].filter(Boolean).join(" ");
}

function absolutePaths(text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(ABSOLUTE_PATH_PATTERN)) {
    const normalized = normalizeAbsolutePath(match[2] ?? "");
    if (normalized !== "") paths.push(normalized);
  }
  return paths;
}

function normalizeAbsolutePath(path: string): string {
  const trimmed = path.trim().replace(/[.,:]+$/g, "");
  if (!trimmed.startsWith("/")) return "";
  return trimmed.replace(/\/+/g, "/").replace(/\/$/g, "") || "/";
}

function isPathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}

function rule(rule_id: ApprovalSafetyRuleID, label: string, evidence: string): RuleMatch {
  return { evidence, label, rule_id };
}

function policyReason(match: RuleMatch): string {
  return truncateReason(`${match.label}: ${redactApprovalText(match.evidence)}`);
}

function redactApprovalText(text: string): string {
  return redactSensitiveText(text)
    .replace(ABSOLUTE_PATH_PATTERN, "$1[redacted-path]");
}

function truncateReason(text: string): string {
  return text.length > REASON_MAX_LENGTH ? `${text.slice(0, REASON_MAX_LENGTH - 1)}…` : text;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function changesPaths(raw: Record<string, unknown>): string[] {
  const changes = Array.isArray(raw.changes) ? raw.changes : [];
  return changes.map((value) => cleanString(recordValue(value).path)).filter(Boolean);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
