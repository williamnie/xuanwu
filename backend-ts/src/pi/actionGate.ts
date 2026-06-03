export type PiRiskGate = "safe" | "confirm" | "high";
export type PiRiskLevel = "low" | "medium" | "high";
export type PiRiskClassification = {
  gate: PiRiskGate;
  requiresConfirmation: boolean;
  riskLevel: PiRiskLevel;
};
export type PiActionDecision = "execute" | "ask" | "deny" | "snooze";
export type PiActionMode = "attended" | "delegated";
export type PiActionEnvelope = {
  action_type: string;
  delegation_id?: string;
  heartbeat_id?: string;
  issue_id?: number;
  payload: Record<string, unknown>;
  project_id?: string;
  rationale?: string;
  requires_confirmation: boolean;
  risk_level: PiRiskClassification["riskLevel"];
  snoozed_until?: string;
  source: string;
};
export type PiAuthorizedAction = Partial<Pick<PiActionEnvelope,
  "action_type" | "delegation_id" | "heartbeat_id" | "issue_id" | "project_id"
>> & { payload?: Record<string, unknown> };
export type PiGatePolicy = {
  allowedMcpCapabilities?: string[];
  allowedSkillIntents?: string[];
  authorizedActions?: PiAuthorizedAction[];
  mode?: PiActionMode;
};
export type PiGateDecision = { decision: PiActionDecision; reason: string };

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
  if (cleanString(envelope.snoozed_until) !== "") return { decision: "snooze", reason: "action is snoozed" };
  if (!authorizedMcpCapabilities(envelope, policy.allowedMcpCapabilities)) {
    return { decision: "deny", reason: "MCP capability is not covered by authorization allowlist" };
  }
  if ((policy.mode ?? "attended") === "delegated") {
    if (!authorizedSkillIntents(envelope, policy.allowedSkillIntents)) {
      return { decision: "deny", reason: "delegated skill intent is not covered by authorization allowlist" };
    }
    if (!authorizedByEnvelope(envelope, policy.authorizedActions ?? [])) {
      return { decision: "deny", reason: "delegated action is not covered by authorization envelope" };
    }
    return { decision: "execute", reason: "delegated action is covered by authorization envelope" };
  }
  if (envelope.requires_confirmation) return { decision: "ask", reason: "risk requires user confirmation" };
  return { decision: "execute", reason: "low-risk action is allowed by gate" };
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

function authorizedMcpCapabilities(envelope: PiActionEnvelope, allowed: string[] | undefined): boolean {
  if (!allowed) return true;
  const requested = [
    ...stringList(envelope.payload.capability_id),
    ...stringList(envelope.payload.capability_ids),
    ...stringList(envelope.payload.required_mcp_capabilities),
    ...stringList(envelope.payload.recommended_mcp_capabilities)
  ];
  if (requested.length === 0) return true;
  const allowlist = new Set(allowed.map(cleanID).filter(Boolean));
  return requested.every((id) => allowlist.has(cleanID(id)));
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

function authorizedByEnvelope(envelope: PiActionEnvelope, authorized: PiAuthorizedAction[]): boolean {
  return authorized.some((candidate) => (
    optionalMatch(candidate.action_type, envelope.action_type) &&
    optionalMatch(candidate.project_id, envelope.project_id ?? "") &&
    optionalNumberMatch(candidate.issue_id, envelope.issue_id ?? 0) &&
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
