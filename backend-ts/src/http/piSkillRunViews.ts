import type { IntakeRunRecord } from "../db/repositories/intakeRuns.ts";
import { redactAuditJsonText, redactAuditText } from "../db/repositories/pi/auditRedaction.ts";

type JsonObject = Record<string, unknown>;

export function publicIntakeRun(run: IntakeRunRecord): JsonObject {
  const error = redactAuditText(run.error);
  return {
    id: run.id,
    kind: "intake",
    bundle_id: run.bundle_id,
    input_id: run.bundle_id,
    input_object: "context_bundle",
    skill_id: run.skill_id,
    model: run.model,
    model_policy_id: run.model_policy_id,
    status: run.status,
    input_summary: redactedJsonValue(run.input_summary),
    schema_output: redactedJsonValue(run.schema_output),
    ignored_groups: redactedJsonValue(run.ignored_groups),
    ignored_count: run.ignored_groups.length,
    error,
    diagnostics: runDiagnostics(error),
    links: {
      context_bundle: `/api/pi/attention-inbox/context-bundles/${run.bundle_id}`,
      inbox_items: `/api/pi/attention-inbox/items?intake_run_id=${run.id}`
    },
    created_at: run.created_at,
    updated_at: run.updated_at
  };
}

export function redactedJsonObject(value: unknown): JsonObject {
  const redacted = redactedJsonValue(value);
  return redacted && typeof redacted === "object" && !Array.isArray(redacted) ? redacted as JsonObject : {};
}

export function redactedJsonValue(value: unknown): unknown {
  try {
    return JSON.parse(redactAuditJsonText(JSON.stringify(value ?? {}))) as unknown;
  } catch {
    return {};
  }
}

export function runDiagnostics(error: string): JsonObject[] {
  return error ? [{ code: "run_failed", message: error, severity: "error" }] : [];
}
