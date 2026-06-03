import type { RunnerDatabase } from "../db/database.ts";
import { readProjectPiPolicy } from "../db/repositories/pi.ts";

export type VerificationTimeoutAction = "escalate" | "request_verifier";
export type VerificationPolicy = {
  evidence_required: boolean;
  on_timeout: VerificationTimeoutAction;
  pending_timeout_ms: number;
};

const DEFAULT_TIMEOUT_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
const TIMEOUT_ACTIONS = new Set(["escalate", "request_verifier"]);

export function projectVerificationPolicy(db: RunnerDatabase, projectID: string): VerificationPolicy {
  return normalizeVerificationPolicy(readProjectPiPolicy(db, projectID).verification_policy_json);
}

export function normalizeVerificationPolicy(value: unknown): VerificationPolicy {
  const input = objectValue(value);
  return {
    evidence_required: input.evidence_required !== false,
    on_timeout: timeoutAction(input.on_timeout),
    pending_timeout_ms: positiveInteger(input.pending_timeout_minutes, DEFAULT_TIMEOUT_MINUTES) * MINUTE_MS
  };
}

function timeoutAction(value: unknown): VerificationTimeoutAction {
  const text = cleanString(value);
  return TIMEOUT_ACTIONS.has(text) ? text as VerificationTimeoutAction : "escalate";
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  const text = cleanString(value);
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
