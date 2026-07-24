import type { RunnerDatabase } from "../db/database.ts";
import type { PiGuardianEvent } from "../db/repositories/pi.ts";

export function guardianDecisionActionsJson(
  event: PiGuardianEvent,
  payload: Record<string, unknown>,
  db?: RunnerDatabase
): string {
  const explicit = recordArray(payload.actions ?? payload.action_candidates);
  if (explicit.length > 0) return JSON.stringify(explicit);
  void db;
  return heartbeatActionJson(event, payload);
}

function heartbeatActionJson(event: PiGuardianEvent, payload: Record<string, unknown>): string {
  const actionType = clean(payload.action_type);
  const original = jsonRecord(payload.original_payload);
  if (event.event_type !== "guardian.heartbeat.action_candidate" || actionType === "" ||
    Object.keys(original).length === 0) {
    return "[]";
  }
  return JSON.stringify([{
    action_type: actionType,
    issue_id: event.issue_id,
    payload: original,
    project_id: event.project_id,
    rationale: clean(payload.rationale),
    risk_level: clean(payload.risk_level)
  }]);
}

function recordArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.map(jsonRecord).filter((item) => Object.keys(item).length > 0);
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return jsonRecord(JSON.parse(value) as unknown);
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
