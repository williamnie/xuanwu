export type PiRiskGate = "safe" | "confirm" | "high";
export type PiRiskClassification = {
  gate: PiRiskGate;
  requiresConfirmation: boolean;
  riskLevel: "low" | "medium" | "high";
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
export type PiGatePolicy = { authorizedActions?: PiAuthorizedAction[]; mode?: PiActionMode };
export type PiGateDecision = { decision: PiActionDecision; reason: string };

const SAFE_ACTIONS = new Set([
  "issue.comment", "issue.list", "issue.read", "issue.state_diagnose", "project.list", "project.status",
  "session.list", "session.read_summary", "memory.search", "memory.write_candidate",
  "sdk.read", "sdk.grep", "sdk.find", "sdk.ls"
]);
const CONFIRM_ACTIONS = new Set(["issue.create", "issue.enqueue", "issue.update_refinement", "issue.state_repair"]);
const HIGH_RISK_ACTIONS = new Set(["session.steer"]);

export function classifyPiActionRisk(actionType: string): PiRiskClassification {
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
  if ((policy.mode ?? "attended") === "delegated") {
    if (!authorizedByEnvelope(envelope, policy.authorizedActions ?? [])) {
      return { decision: "deny", reason: "delegated action is not covered by authorization envelope" };
    }
    return { decision: "execute", reason: "delegated action is covered by authorization envelope" };
  }
  if (envelope.requires_confirmation) return { decision: "ask", reason: "risk requires user confirmation" };
  return { decision: "execute", reason: "low-risk action is allowed by gate" };
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

function risk(gate: PiRiskGate, riskLevel: PiRiskClassification["riskLevel"]): PiRiskClassification {
  return { gate, requiresConfirmation: gate !== "safe", riskLevel };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
