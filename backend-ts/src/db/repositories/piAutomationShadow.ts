import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../database.ts";
import {
  getAutomation,
  getAutomationTrigger
} from "./automations.ts";
import {
  automationIntervalMs
} from "./piAutomationScheduleState.ts";
import { getPiAutomation, type PiAutomationRecord } from "./piAutomations.ts";
import type {
  AutomationDefinition,
  AutomationID,
  AutomationTriggerConfig
} from "../../domain/automation/contracts.ts";

const PI_AUTOMATION_SHADOW_WORKFLOW_REF = "workflow:legacy-pi-shadow@1";
const PI_AUTOMATION_SHADOW_EVENT = "automation.legacy_pi_shadow_mapped.v1";
type PiAutomationShadowDrift = {
  axis: "definition" | "provenance" | "trigger";
  automation_id: AutomationID;
  detail: string;
  legacy_id?: number;
};

type ShadowProjection = {
  definition: {
    id: AutomationID;
    idempotency_namespace: string;
    mode: AutomationDefinition["mode"];
    name: string;
    next_run_at: string | null;
    owner: AutomationDefinition["owner"];
    permission_policy_ref: string;
    status: AutomationDefinition["status"];
    workflow_ref: string;
  };
  trigger: AutomationTriggerConfig;
};

type ShadowPayload = {
  expected_definition_status: "active" | "paused";
  legacy_id: number;
  mapping_version: "xuanwu.pi-automation-shadow.v1";
  source_checksum: string;
  source_snapshot: Record<string, unknown>;
  target_checksum: string;
};

function piAutomationShadowID(id: number): AutomationID {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("legacy pi automation id is invalid");
  return `automation:legacy-pi-${id}`;
}

function mapPiAutomationShadow(legacy: PiAutomationRecord): {
  payload: ShadowPayload;
  projection: ShadowProjection;
} {
  const projection: ShadowProjection = {
    definition: {
      id: piAutomationShadowID(legacy.id),
      idempotency_namespace: `legacy:pi_automations:${legacy.id}`,
      mode: mapMode(legacy.mode),
      name: legacy.name,
      next_run_at: null,
      owner: { kind: "control_plane", control_plane_id: "local" },
      permission_policy_ref: "migration-policy:legacy-pi-shadow:v1",
      status: "draft",
      workflow_ref: PI_AUTOMATION_SHADOW_WORKFLOW_REF
    },
    trigger: mapTrigger(legacy)
  };
  const sourceSnapshot = legacySnapshot(legacy);
  return {
    payload: {
      expected_definition_status: legacy.enabled ? "active" : "paused",
      legacy_id: legacy.id,
      mapping_version: "xuanwu.pi-automation-shadow.v1",
      source_checksum: checksum(sourceSnapshot),
      source_snapshot: sourceSnapshot,
      target_checksum: checksum(projection)
    },
    projection
  };
}

export function comparePiAutomationShadows(db: RunnerDatabase): {
  checksum: string;
  drift: PiAutomationShadowDrift[];
} {
  const legacy = allPiAutomations(db);
  const expectedIDs = new Set(legacy.map((item) => piAutomationShadowID(item.id)));
  const drift: PiAutomationShadowDrift[] = [];
  for (const item of legacy) {
    const desired = mapPiAutomationShadow(item);
    const definition = getAutomation(db, desired.projection.definition.id);
    if (!definition) {
      drift.push({ axis: "definition", automation_id: desired.projection.definition.id, detail: "target shadow definition is missing", legacy_id: item.id });
      continue;
    }
    const provenance = latestProvenance(db, desired.projection.definition.id);
    if (!provenance) {
      drift.push({ axis: "provenance", automation_id: desired.projection.definition.id, detail: "mapping provenance is missing", legacy_id: item.id });
      continue;
    }
    const actual = actualProjection(db, desired.projection.definition.id);
    if (!actual) {
      drift.push({ axis: "trigger", automation_id: desired.projection.definition.id, detail: "active trigger projection is missing", legacy_id: item.id });
      continue;
    }
    if (checksum(actual) !== provenance.target_checksum || checksum(actual) !== desired.payload.target_checksum) {
      drift.push({ axis: "definition", automation_id: desired.projection.definition.id, detail: "target projection checksum drifted", legacy_id: item.id });
    }
    if (provenance.source_checksum !== desired.payload.source_checksum) {
      drift.push({ axis: "provenance", automation_id: desired.projection.definition.id, detail: "legacy source checksum drifted", legacy_id: item.id });
    }
  }
  const shadowIDs = db.sqlite.query<{ id: string }, []>(
    "select id from automation_definitions where id like 'automation:legacy-pi-%' order by id"
  ).all().map((row) => row.id as AutomationID);
  for (const id of shadowIDs) {
    if (!expectedIDs.has(id)) drift.push({ axis: "provenance", automation_id: id, detail: "orphan target shadow has no legacy source" });
  }
  return {
    checksum: checksum({
      legacy: legacy.map((item) => mapPiAutomationShadow(item).payload.source_checksum),
      shadows: shadowIDs.map((id) => ({ id, projection: actualProjection(db, id), provenance: latestProvenance(db, id) }))
    }),
    drift
  };
}

function allPiAutomations(db: RunnerDatabase): PiAutomationRecord[] {
  return db.sqlite.query<{ id: number }, []>("select id from pi_automations order by id")
    .all()
    .map((row) => getPiAutomation(db, row.id))
    .filter((item): item is PiAutomationRecord => item !== null);
}

function latestProvenance(db: RunnerDatabase, id: AutomationID): ShadowPayload | null {
  const row = db.sqlite.query<{ payload_json: string }, [string, string]>(`select payload_json from automation_events
    where automation_id=? and event_type=? order by rowid desc limit 1`).get(id, PI_AUTOMATION_SHADOW_EVENT);
  if (!row) return null;
  const payload = JSON.parse(row.payload_json) as Partial<ShadowPayload>;
  if (payload.mapping_version !== "xuanwu.pi-automation-shadow.v1" || !Number.isSafeInteger(payload.legacy_id) ||
      typeof payload.source_checksum !== "string" || typeof payload.target_checksum !== "string") {
    throw new Error("automation shadow provenance payload is invalid");
  }
  return payload as ShadowPayload;
}

function actualProjection(db: RunnerDatabase, id: AutomationID): ShadowProjection | null {
  const definition = getAutomation(db, id);
  const trigger = getAutomationTrigger(db, id);
  if (!definition || !trigger) return null;
  return {
    definition: {
      id: definition.id,
      idempotency_namespace: definition.idempotency_namespace,
      mode: definition.mode,
      name: definition.name,
      next_run_at: definition.next_run_at,
      owner: definition.owner,
      permission_policy_ref: definition.permission_policy_ref,
      status: definition.status,
      workflow_ref: definition.workflow_ref
    },
    trigger: { type: trigger.type, config: trigger.config } as AutomationTriggerConfig
  };
}

function legacySnapshot(legacy: PiAutomationRecord): Record<string, unknown> {
  return {
    claim_retry: {
      error: legacy.error,
      failed_cursor: legacy.failed_cursor,
      last_result: legacy.last_result,
      last_run_at: legacy.last_run_at,
      last_status: legacy.last_status,
      lock_expires_at: legacy.lock_expires_at,
      lock_token: legacy.lock_token,
      retry_backoff_seconds: legacy.retry_backoff_seconds,
      retry_count: legacy.retry_count,
      run_count: legacy.run_count,
      run_started_at: legacy.run_started_at,
      run_timeout_ms: legacy.run_timeout_ms
    },
    cursor: {
      last_successful_cursor: legacy.last_successful_cursor,
      processed_watermark: legacy.processed_watermark,
      steps: legacy.steps,
      failed_cursor: legacy.failed_cursor
    },
    definition: {
      enabled: legacy.enabled,
      filters: legacy.filters,
      max_actions_per_run: legacy.max_actions_per_run,
      mode: legacy.mode,
      name: legacy.name,
      source_policy: legacy.source_policy
    },
    legacy_id: legacy.id,
    provenance: { created_at: legacy.created_at, source_table: "pi_automations", updated_at: legacy.updated_at },
    trigger: { config: legacy.trigger, next_run_at: legacy.next_run_at, type: legacy.trigger_type }
  };
}

function mapTrigger(legacy: PiAutomationRecord): AutomationTriggerConfig {
  const trigger = legacy.trigger as Record<string, unknown>;
  if (legacy.trigger_type === "manual") return { type: "manual", config: {} };
  if (legacy.trigger_type === "webhook") {
    const eventType = clean(trigger.event_type ?? trigger.eventType ?? trigger.topic);
    if (!eventType) throw new Error("legacy webhook trigger requires event_type");
    const secretRef = clean(trigger.secret_ref ?? trigger.secretRef);
    return { type: "webhook", config: { event_type: eventType, ...(secretRef ? { secret_ref: secretRef } : {}) } };
  }
  const expression = clean(trigger.expression ?? trigger.cron);
  if (expression) {
    const timezone = clean(trigger.timezone);
    if (!timezone) throw new Error("legacy cron trigger requires an explicit IANA timezone");
    return { type: "cron", config: { expression, timezone } };
  }
  const intervalMs = automationIntervalMs(trigger);
  if (intervalMs < 1 || intervalMs % 1000 !== 0) {
    throw new Error("legacy schedule/continuous trigger requires a whole-second positive interval");
  }
  return { type: "continuous", config: { poll_interval_seconds: intervalMs / 1000 } };
}

function mapMode(mode: PiAutomationRecord["mode"]): AutomationDefinition["mode"] {
  if (mode === "dry_run") return "observe";
  if (mode === "auto") return "execute_allowed";
  return "propose";
}

function checksum(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
