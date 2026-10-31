import { type PiGuardianAlert } from "../../db/repositories/pi.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { type GuardianMissedOutageWindow } from "./guardianMissedIntentDigest.ts";
import { cleanString } from "../../util/values.ts";
import { DEFAULT_LIMIT, GuardianMissedIntentSweepResult } from "./guardianMissedIntentSweep.ts";
import { missedIntents } from "./guardianMissedIntentQueries.ts";

export function evidenceOldestAt(alert: PiGuardianAlert): string {
  const evidence = parseRecord(alert.evidence_json);
  return cleanString(evidence.oldest_created_at) || cleanString(evidence.created_at) || cleanString(evidence.deadline_at);
}

export function inWindow(value: string, window: GuardianMissedOutageWindow): boolean {
  const time = Date.parse(value);
  return Number.isFinite(time) && time >= Date.parse(window.startAt) && time <= Date.parse(window.endAt);
}

export function earliestText(values: string[]): string {
  return values.filter(validDate).sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? "";
}

export function latestText(values: string[]): string {
  return values.filter(validDate).sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? "";
}

export function validDate(value: string): boolean {
  return value !== "" && Number.isFinite(Date.parse(value));
}

export function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

export function parseRecord(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function boundedLimit(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? Math.min(value, 200) : DEFAULT_LIMIT;
}

export function iso(value: Date | string | undefined): string {
  if (value instanceof Date) return value.toISOString().replace(/\.\d{3}Z$/, "Z");
  if (typeof value === "string" && value.trim() !== "") return value.trim();
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

export function emptyResult(): GuardianMissedIntentSweepResult {
  return {
    errors: 0,
    missedIntents: 0,
    openAlerts: 0,
    pending: 0,
    pendingAlertIds: [],
    scannedAlerts: 0,
    skipped: 0,
    summaries: 0,
    windows: 0
  };
}
