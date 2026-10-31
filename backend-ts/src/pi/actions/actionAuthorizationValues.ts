import { cleanString } from "../../util/values.ts";
import { type PiActionEnvelope, type PiAuthorizedAction, type PiRiskLevel, PiRiskGate, PiRiskClassification } from "./actionGate.ts";

export function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  const text = cleanString(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(cleanString).filter(Boolean);
  } catch {}
  return text.split(/\n|,/).map(cleanString).filter(Boolean);
}

export function authorizedByEnvelope(envelope: PiActionEnvelope, authorized: PiAuthorizedAction[]): boolean {
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

export function payloadCovered(payload: Record<string, unknown>, expected: Record<string, unknown> | undefined): boolean {
  if (!expected) return true;
  return Object.entries(expected).every(([key, value]) => JSON.stringify(payload[key]) === JSON.stringify(value));
}

export function optionalMatch(expected: string | undefined, actual: string): boolean {
  const text = cleanString(expected);
  return text === "" || text === cleanString(actual);
}

export function optionalNumberMatch(expected: number | undefined, actual: number): boolean {
  return expected === undefined || expected === 0 || expected === actual;
}

export function timeMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  const text = cleanString(value);
  if (text === "") return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

export function gateFor(riskLevel: PiRiskLevel, requiresConfirmation: boolean): PiRiskGate {
  if (riskLevel === "high") return "high";
  if (requiresConfirmation) return "confirm";
  return "safe";
}

export function risk(gate: PiRiskGate, riskLevel: PiRiskLevel): PiRiskClassification {
  return { gate, requiresConfirmation: gate !== "safe", riskLevel };
}

export function isRiskLevel(value: unknown): value is PiRiskLevel {
  return value === "low" || value === "medium" || value === "high";
}

export function cleanID(value: unknown): string {
  return cleanString(value).toLowerCase();
}

export function withScopeReason(reason: string, scopeReason: string): string {
  const scope = cleanString(scopeReason);
  return scope === "" ? reason : `${reason}; ${scope}`;
}
