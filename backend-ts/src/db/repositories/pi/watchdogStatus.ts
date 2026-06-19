import type { RunnerDatabase } from "../../database.ts";
import {
  cleanString,
  integerValue,
  jsonText,
  now,
  optionalString,
  requiredString,
  type PatchInput
} from "./common.ts";
import { redactAuditJsonText, redactAuditText } from "./auditRedaction.ts";

export type PiGuardianWatchdogStatus = {
  checked_components_json: string; last_error: string; last_seen_at: string;
  last_success_at: string; singleton_id: 1; updated_at: string;
};
export type PiGuardianWatchdogStatusInput = PatchInput<PiGuardianWatchdogStatus>;

const TABLE = "pi_guardian_watchdog_status";
const COLUMNS = `singleton_id, last_seen_at, last_success_at, last_error,
  checked_components_json, updated_at`;

export function upsertPiGuardianWatchdogStatus(
  db: RunnerDatabase,
  input: PiGuardianWatchdogStatusInput
): PiGuardianWatchdogStatus {
  const record = normalizeStatus(input);
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (?, ?, ?, ?, ?, ?)
    on conflict(singleton_id) do update set
      last_seen_at=excluded.last_seen_at,
      last_success_at=excluded.last_success_at,
      last_error=excluded.last_error,
      checked_components_json=excluded.checked_components_json,
      updated_at=excluded.updated_at`, [
    record.singleton_id, record.last_seen_at, record.last_success_at,
    record.last_error, record.checked_components_json, record.updated_at
  ]);
  const status = getPiGuardianWatchdogStatus(db);
  if (!status) throw new Error("PI guardian watchdog status missing after write");
  return status;
}

export function getPiGuardianWatchdogStatus(
  db: RunnerDatabase
): PiGuardianWatchdogStatus | null {
  const row = db.sqlite.query<Record<string, unknown>, []>(
    `select ${COLUMNS} from ${TABLE} where singleton_id=1`
  ).get();
  return row ? mapStatus(row) : null;
}

function normalizeStatus(input: PiGuardianWatchdogStatusInput): PiGuardianWatchdogStatus {
  const timestamp = now();
  return {
    checked_components_json: redactedJsonPayload(input.checked_components_json, "[]"),
    last_error: redactAuditText(cleanString(input.last_error)),
    last_seen_at: requiredString(input.last_seen_at, "last_seen_at"),
    last_success_at: cleanString(input.last_success_at),
    singleton_id: 1,
    updated_at: timestamp
  };
}

function mapStatus(row: Record<string, unknown>): PiGuardianWatchdogStatus {
  const singletonID = integerValue(row.singleton_id, `${TABLE}.singleton_id`);
  if (singletonID !== 1) throw new Error("PI guardian watchdog status singleton_id must be 1");
  return {
    checked_components_json: redactAuditJsonText(optionalString(row.checked_components_json) || "[]"),
    last_error: redactAuditText(optionalString(row.last_error)),
    last_seen_at: requiredString(row.last_seen_at, `${TABLE}.last_seen_at`),
    last_success_at: optionalString(row.last_success_at),
    singleton_id: 1,
    updated_at: requiredString(row.updated_at, `${TABLE}.updated_at`)
  };
}

function redactedJsonPayload(value: unknown, fallback: string): string {
  if (typeof value === "string") return redactAuditJsonText(jsonText(value, fallback));
  return redactAuditJsonText(JSON.stringify(value ?? JSON.parse(fallback)));
}
