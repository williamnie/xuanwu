import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../database.ts";
import { DEFAULT_PI_AGENT_ID } from "../../defaultPiAgent.ts";
import { createPiActionEvent } from "./actions.ts";

export const PI_PERSONA_VERBOSITY = ["adaptive", "concise", "detailed"] as const;
export const PI_PERSONA_LANGUAGE_MODES = ["system", "follow_user"] as const;
export const PI_PERSONA_TOTAL_CHAR_LIMIT = 3_000;
export const PI_PERSONA_PERSONALITY_CHAR_LIMIT = 1_000;
export const PI_PERSONA_COMMUNICATION_STYLE_CHAR_LIMIT = 2_000;

export type PiPersona = {
  supervisor_id: string;
  enabled: number;
  personality: string;
  communication_style: string;
  verbosity: typeof PI_PERSONA_VERBOSITY[number];
  language_mode: typeof PI_PERSONA_LANGUAGE_MODES[number];
  revision: number;
  created_at: string;
  updated_at: string;
};

export type PiPersonaPatch = Partial<Pick<PiPersona,
  "enabled" | "personality" | "communication_style" | "verbosity" | "language_mode"
>> & { expected_revision: number };

export type PiPersonaAuditInput = {
  actor: string;
  reason: string;
  requestedAt: string;
  source?: string;
};

export class PiPersonaRevisionConflictError extends Error {
  constructor(readonly expectedRevision: number, readonly actualRevision: number) {
    super(`persona revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    this.name = "PiPersonaRevisionConflictError";
  }
}

const COLUMNS = `supervisor_id, enabled, personality, communication_style, verbosity,
  language_mode, revision, created_at, updated_at`;

export function getPiPersona(db: RunnerDatabase, supervisorID = DEFAULT_PI_AGENT_ID): PiPersona | null {
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from pi_persona where supervisor_id=?`
  ).get(supervisorID);
  return row ? mapPersona(row) : null;
}

export function updatePiPersona(
  db: RunnerDatabase,
  input: PiPersonaPatch,
  audit: PiPersonaAuditInput
): PiPersona {
  const current = requirePersona(db);
  const expectedRevision = integer(input.expected_revision, "expected_revision");
  if (expectedRevision !== current.revision) {
    throw new PiPersonaRevisionConflictError(expectedRevision, current.revision);
  }
  const next = validatePersona({
    ...current,
    enabled: input.enabled === undefined ? current.enabled : flag(input.enabled),
    personality: input.personality === undefined ? current.personality : cleanString(input.personality),
    communication_style: input.communication_style === undefined
      ? current.communication_style
      : cleanString(input.communication_style),
    verbosity: (input.verbosity === undefined ? current.verbosity : cleanString(input.verbosity)) as PiPersona["verbosity"],
    language_mode: (input.language_mode === undefined ? current.language_mode : cleanString(input.language_mode)) as PiPersona["language_mode"],
    revision: current.revision + 1
  });
  const changedFields = personaChangedFields(current, next);
  const timestamp = new Date().toISOString();
  db.sqlite.run(`update pi_persona set enabled=?, personality=?, communication_style=?, verbosity=?,
    language_mode=?, revision=?, updated_at=? where supervisor_id=? and revision=?`, [
    next.enabled,
    next.personality,
    next.communication_style,
    next.verbosity,
    next.language_mode,
    next.revision,
    timestamp,
    current.supervisor_id,
    current.revision
  ]);
  if (db.sqlite.query<{ changes: number }, []>("select changes() as changes").get()?.changes !== 1) {
    throw new PiPersonaRevisionConflictError(expectedRevision, requirePersona(db).revision);
  }
  const saved = requirePersona(db);
  createPiActionEvent(db, {
    action_id: `supervisor-persona:${saved.supervisor_id}:${saved.revision}:${crypto.randomUUID()}`,
    actor: cleanString(audit.actor) || "operator",
    event_type: "supervisor_persona_updated",
    reason: cleanString(audit.reason) || "Supervisor persona settings updated",
    payload_json: JSON.stringify({
      schema_version: "xw.supervisor-persona-audit.v1",
      supervisor_id: saved.supervisor_id,
      source: cleanString(audit.source) || "supervisor_settings_http",
      requested_at: cleanString(audit.requestedAt) || timestamp,
      before_revision: current.revision,
      after_revision: saved.revision,
      changed_fields: changedFields,
      enabled: saved.enabled === 1,
      verbosity: saved.verbosity,
      language_mode: saved.language_mode,
      text_fields: {
        personality: textAudit(saved.personality),
        communication_style: textAudit(saved.communication_style)
      }
    }),
    result_json: JSON.stringify({ status: "updated", revision: saved.revision })
  });
  return saved;
}

function requirePersona(db: RunnerDatabase): PiPersona {
  const persona = getPiPersona(db);
  if (!persona) throw new Error("Supervisor persona configuration is unavailable");
  return persona;
}

function validatePersona(input: PiPersona): PiPersona {
  if (input.personality.length > PI_PERSONA_PERSONALITY_CHAR_LIMIT) {
    throw new Error(`personality must be at most ${PI_PERSONA_PERSONALITY_CHAR_LIMIT} characters`);
  }
  if (input.communication_style.length > PI_PERSONA_COMMUNICATION_STYLE_CHAR_LIMIT) {
    throw new Error(`communication_style must be at most ${PI_PERSONA_COMMUNICATION_STYLE_CHAR_LIMIT} characters`);
  }
  if (input.personality.length + input.communication_style.length > PI_PERSONA_TOTAL_CHAR_LIMIT) {
    throw new Error(`persona text must be at most ${PI_PERSONA_TOTAL_CHAR_LIMIT} characters`);
  }
  if (!PI_PERSONA_VERBOSITY.includes(input.verbosity as typeof PI_PERSONA_VERBOSITY[number])) {
    throw new Error(`verbosity must be one of: ${PI_PERSONA_VERBOSITY.join(", ")}`);
  }
  if (!PI_PERSONA_LANGUAGE_MODES.includes(input.language_mode as typeof PI_PERSONA_LANGUAGE_MODES[number])) {
    throw new Error(`language_mode must be one of: ${PI_PERSONA_LANGUAGE_MODES.join(", ")}`);
  }
  return input;
}

function personaChangedFields(before: PiPersona, after: PiPersona): string[] {
  return (["enabled", "personality", "communication_style", "verbosity", "language_mode"] as const)
    .filter((field) => before[field] !== after[field]);
}

function textAudit(value: string): { chars: number; sha256: string } {
  return { chars: value.length, sha256: createHash("sha256").update(value).digest("hex") };
}

function mapPersona(row: Record<string, unknown>): PiPersona {
  return validatePersona({
    supervisor_id: cleanString(row.supervisor_id),
    enabled: flag(row.enabled),
    personality: cleanString(row.personality),
    communication_style: cleanString(row.communication_style),
    verbosity: cleanString(row.verbosity) as PiPersona["verbosity"],
    language_mode: cleanString(row.language_mode) as PiPersona["language_mode"],
    revision: integer(row.revision, "revision"),
    created_at: cleanString(row.created_at),
    updated_at: cleanString(row.updated_at)
  });
}

function flag(value: unknown): number {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0) return 0;
  throw new Error("enabled must be a boolean or 0/1");
}

function integer(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(`${field} must be a non-negative integer`);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
