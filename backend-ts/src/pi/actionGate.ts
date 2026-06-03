import type { PiGateDecisionValue, PiWorkMode } from "./policyTypes.ts";
import { matchPiAuthorizationPolicyScope } from "./authorizationScope.ts";

export type PiRiskGate = "safe" | "confirm" | "high";
export type PiRiskLevel = "low" | "medium" | "high";
export type PiRiskClassification = {
  gate: PiRiskGate;
  requiresConfirmation: boolean;
  riskLevel: PiRiskLevel;
};
export type PiActionEnvelopeRisk = {
  gate: PiRiskGate | "forbidden";
  level: PiRiskLevel;
  requires_confirmation: boolean;
};
export type PiActionDecision = PiGateDecisionValue;
export type PiActionMode = PiWorkMode;
export type PiActionEnvelope = {
  action_type: string;
  delegation_id?: string;
  goal_id?: string;
  heartbeat_id?: string;
  issue_id?: number;
  payload: Record<string, unknown>;
  project_id?: string;
  rationale?: string;
  requires_confirmation: boolean;
  risk?: PiActionEnvelopeRisk;
  risk_gate?: PiRiskGate | "forbidden";
  risk_level: PiRiskClassification["riskLevel"];
  snoozed_until?: string;
  source: string;
};
export type PiAuthorizedAction = Partial<Pick<PiActionEnvelope,
  "action_type" | "delegation_id" | "goal_id" | "heartbeat_id" | "issue_id" | "project_id"
>> & { payload?: Record<string, unknown> };
export type PiGatePolicy = {
  allowedActions?: string[];
  allowed_actions?: string[];
  allowedMcpCapabilities?: string[];
  allowed_mcp_capabilities?: string[];
  allowedSkillIntents?: string[];
  allowed_skill_intents?: string[];
  authorizedActions?: PiAuthorizedAction[];
  expiresAt?: string;
  expires_at?: string;
  forbiddenActions?: string[];
  forbidden_actions?: string[];
  mode?: PiActionMode;
  now?: Date | string;
  scope?: PiAuthorizationScope | PiAuthorizationScope[];
  scopes?: PiAuthorizationScope[];
  startsAt?: string;
  starts_at?: string;
};
export type PiGateDecision = { decision: PiActionDecision; reason: string };
export type PiAuthorizationScope = {
  delegation_id?: string;
  delegationId?: string;
  goal_id?: string;
  goalId?: string;
  heartbeat_id?: string;
  heartbeatId?: string;
  issue_id?: number | string;
  issueId?: number | string;
  issue_ids?: Array<number | string> | string;
  issueIds?: Array<number | string> | string;
  project_id?: string;
  projectId?: string;
};

const SAFE_ACTIONS = new Set([
  "agent.profile_recommend",
  "issue.comment", "issue.list", "issue.read", "issue.state_diagnose", "project.list", "project.status",
  "session.list", "session.read_summary", "memory.search", "memory.write_candidate",
  "sdk.read", "sdk.grep", "sdk.find", "sdk.ls",
  "skill.list", "skill.read", "skill.recommend", "skill.intent_audit",
  "mcp.registry.list", "mcp.capability.read", "mcp.requirement.recommend", "mcp.resource.list", "mcp.resource.read"
]);
const CONFIRM_ACTIONS = new Set([
  "agent.executor_assign", "agent.workflow_request", "issue.create", "issue.enqueue",
  "issue.update_refinement", "issue.state_repair", "needs_user.escalate"
]);
const HIGH_RISK_ACTIONS = new Set(["session.steer", "mcp.tool.call"]);

export function classifyPiActionRisk(actionType: string, override: Partial<PiRiskClassification> = {}): PiRiskClassification {
  const base = baseRisk(actionType);
  const riskLevel = isRiskLevel(override.riskLevel) ? override.riskLevel : base.riskLevel;
  const requiresConfirmation = override.requiresConfirmation ?? base.requiresConfirmation;
  return { gate: gateFor(riskLevel, requiresConfirmation), requiresConfirmation, riskLevel };
}

function baseRisk(actionType: string): PiRiskClassification {
  if (SAFE_ACTIONS.has(actionType)) return risk("safe", "low");
  if (CONFIRM_ACTIONS.has(actionType)) return risk("confirm", "medium");
  if (HIGH_RISK_ACTIONS.has(actionType)) return risk("high", "high");
  return risk("high", "high");
}

export function gatePiActionEnvelope(
  envelope: PiActionEnvelope,
  policy: PiGatePolicy = {}
): PiGateDecision {
  return decidePiAuthorization(envelope, policy);
}

export function decidePiAuthorization(
  envelope: PiActionEnvelope,
  policy: PiGatePolicy = {}
): PiGateDecision {
  const riskGate = actionRiskGate(envelope);
  if (riskGate === "forbidden" || forbiddenByPolicy(envelope, policy)) {
    return { decision: "deny", reason: "action is forbidden by policy" };
  }
  if (cleanString(envelope.snoozed_until) !== "") return { decision: "snooze", reason: "action is snoozed" };
  const windowDecision = authorizationWindowDecision(policy);
  if (windowDecision) return windowDecision;
  if (!allowedActionType(envelope, policy)) return { decision: "deny", reason: "action is not covered by allowed_actions" };
  const scopeDecision = matchPiAuthorizationPolicyScope(envelope, policy);
  if (!scopeDecision.matched) return { decision: "deny", reason: scopeDecision.reason };
  if (!authorizedMcpCapabilities(envelope, policy)) {
    return { decision: "deny", reason: "MCP capability is not covered by authorization allowlist" };
  }
  const mode = policy.mode ?? "attended";
  if (mode === "manual") return { decision: "ask", reason: "manual mode requires user approval" };
  if (mode === "delegated" || mode === "autonomous") {
    if (!authorizedSkillIntents(envelope, policy.allowedSkillIntents ?? policy.allowed_skill_intents)) {
      return { decision: "deny", reason: "delegated skill intent is not covered by authorization allowlist" };
    }
    if (!delegatedActionCovered(envelope, policy)) {
      return { decision: "deny", reason: "delegated action is not covered by authorization envelope" };
    }
    if (riskGate === "high") return { decision: "ask", reason: "high-risk action requires user confirmation" };
    return { decision: "execute", reason: withScopeReason("delegated action is covered by authorization envelope", scopeDecision.reason) };
  }
  if (riskGate === "confirm" || riskGate === "high") return { decision: "ask", reason: "risk requires user confirmation" };
  return { decision: "execute", reason: withScopeReason("low-risk action is allowed by gate", scopeDecision.reason) };
}

function authorizedSkillIntents(envelope: PiActionEnvelope, allowed: string[] | undefined): boolean {
  if (!allowed) return true;
  const requested = skillIntentsFromPayload(envelope.payload);
  if (requested.length === 0) return true;
  const allowlist = new Set(allowed.map(cleanString).filter(Boolean));
  return requested.every((id) => allowlist.has(id));
}

function skillIntentsFromPayload(payload: Record<string, unknown>): string[] {
  return [
    ...stringList(payload.skill_intents),
    ...stringList(payload.required_skill_intents),
    ...stringList(payload.recommended_skill_intents)
  ];
}

function authorizedMcpCapabilities(envelope: PiActionEnvelope, policy: PiGatePolicy): boolean {
  const allowed = mcpCapabilityAllowlist(policy);
  if (allowed === undefined) return true;
  const requested = mcpCapabilitiesFromPayload(envelope.payload);
  if (requested.length === 0) return true;
  const allowlist = new Set(allowed.map(cleanID).filter(Boolean));
  return requested.every((id) => allowlist.has(cleanID(id)));
}

function mcpCapabilitiesFromPayload(payload: Record<string, unknown>): string[] {
  const patch = objectPayload(payload.patch);
  return [
    ...stringList(payload.capability_id),
    ...stringList(payload.capability_ids),
    ...stringList(payload.required_mcp_capabilities),
    ...stringList(payload.recommended_mcp_capabilities),
    ...stringList(patch.required_mcp_capabilities),
    ...stringList(patch.recommended_mcp_capabilities)
  ];
}

function mcpCapabilityAllowlist(policy: PiGatePolicy): string[] | undefined {
  if (policy.allowedMcpCapabilities === undefined && policy.allowed_mcp_capabilities === undefined) return undefined;
  return [
    ...stringList(policy.allowedMcpCapabilities),
    ...stringList(policy.allowed_mcp_capabilities)
  ];
}

function actionRiskGate(envelope: PiActionEnvelope): PiRiskGate | "forbidden" {
  const explicit = cleanString(envelope.risk_gate);
  if (explicit === "safe" || explicit === "confirm" || explicit === "high" || explicit === "forbidden") return explicit;
  if (cleanString(envelope.risk_level) === "forbidden") return "forbidden";
  return gateFor(envelope.risk_level, envelope.requires_confirmation);
}

function forbiddenByPolicy(envelope: PiActionEnvelope, policy: PiGatePolicy): boolean {
  const forbidden = actionList(policy.forbidden_actions ?? policy.forbiddenActions);
  return forbidden.length > 0 && forbidden.includes(envelope.action_type);
}

function allowedActionType(envelope: PiActionEnvelope, policy: PiGatePolicy): boolean {
  const allowed = actionList(policy.allowed_actions ?? policy.allowedActions);
  return allowed.length === 0 || allowed.includes(envelope.action_type);
}

function actionList(value: unknown): string[] {
  return stringList(value);
}

function authorizationWindowDecision(policy: PiGatePolicy): PiGateDecision | undefined {
  const nowMs = timeMs(policy.now ?? new Date()) ?? Date.now();
  const startsAt = timeMs(policy.starts_at ?? policy.startsAt);
  const expiresAt = timeMs(policy.expires_at ?? policy.expiresAt);
  if (startsAt !== undefined && nowMs < startsAt) {
    return { decision: "snooze", reason: "authorization window has not started" };
  }
  if (expiresAt !== undefined && nowMs >= expiresAt) {
    return { decision: "deny", reason: "authorization window has expired" };
  }
  return undefined;
}

function delegatedActionCovered(envelope: PiActionEnvelope, policy: PiGatePolicy): boolean {
  const authorized = policy.authorizedActions ?? [];
  if (authorized.length > 0) return authorizedByEnvelope(envelope, authorized);
  return actionList(policy.allowed_actions ?? policy.allowedActions).length > 0;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  const text = cleanString(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(cleanString).filter(Boolean);
  } catch {}
  return text.split(/\n|,/).map(cleanString).filter(Boolean);
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function authorizedByEnvelope(envelope: PiActionEnvelope, authorized: PiAuthorizedAction[]): boolean {
  return authorized.some((candidate) => (
    optionalMatch(candidate.action_type, envelope.action_type) &&
    optionalMatch(candidate.project_id, envelope.project_id ?? "") &&
    optionalNumberMatch(candidate.issue_id, envelope.issue_id ?? 0) &&
    optionalMatch(candidate.goal_id, envelope.goal_id ?? "") &&
    optionalMatch(candidate.delegation_id, envelope.delegation_id ?? "") &&
    optionalMatch(candidate.heartbeat_id, envelope.heartbeat_id ?? "") &&
    payloadCovered(envelope.payload, candidate.payload)
  ));
}

function payloadCovered(payload: Record<string, unknown>, expected: Record<string, unknown> | undefined): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => JSON.stringify(payload[key]) === JSON.stringify(value));
}

function optionalMatch(expected: string | undefined, actual: string): boolean {
  const text = cleanString(expected);
  return text === "" || text === cleanString(actual);
}

function optionalNumberMatch(expected: number | undefined, actual: number): boolean {
  return expected === undefined || expected === 0 || expected === actual;
}

function timeMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  const text = cleanString(value);
  if (text === "") return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

function gateFor(riskLevel: PiRiskLevel, requiresConfirmation: boolean): PiRiskGate {
  if (riskLevel === "high") return "high";
  if (requiresConfirmation) return "confirm";
  return "safe";
}

function risk(gate: PiRiskGate, riskLevel: PiRiskLevel): PiRiskClassification {
  return { gate, requiresConfirmation: gate !== "safe", riskLevel };
}

function isRiskLevel(value: unknown): value is PiRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

function cleanID(value: unknown): string {
  return cleanString(value).toLowerCase();
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function withScopeReason(reason: string, scopeReason: string): string {
  const scope = cleanString(scopeReason);
  return scope === "" ? reason : `${reason}; ${scope}`;
}
