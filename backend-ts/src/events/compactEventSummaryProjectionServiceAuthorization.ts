import { Database as SQLiteDatabase } from "bun:sqlite";
import type { RunnerDatabase } from "../db/database.ts";
import { runMigrations } from "../db/migrations.ts";
import { compactEventSummaryProjectionMigration } from "../db/schema/054_compact_event_summary_projection.ts";
import { compactEventSummaryCreatedAtMigration } from "../db/schema/067_compact_event_summary_created_at.ts";
import { recordMaintenanceAudit } from "../db/repositories/eventMaintenance.ts";
import { getEventSummaryProjectionSwitch } from "../db/repositories/compactEventSummaryProjection.ts";
import { type Authorization } from "./compactEventSummaryProjectionServiceModel.ts";

export function switchBlockers(
  input: { confirmBackupTested?: boolean; confirmNoActiveWriters?: boolean },
  verification: Record<string, unknown>
): string[] {
  return [
    ...mutationConfirmationBlockers(input),
    ...((verification.blockers as string[] | undefined) ?? [])
  ];
}

export function mutationConfirmationBlockers(input: {
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
}): string[] {
  return [
    ...(input.confirmBackupTested ? [] : ["--confirm-backup-tested is required"]),
    ...(input.confirmNoActiveWriters ? [] : ["--confirm-no-active-writers is required"])
  ];
}

export function observationBlockers(state: ReturnType<typeof getEventSummaryProjectionSwitch>, minimumSeconds: number): string[] {
  if (!state.observation_started_at || !state.observation_expires_at) return ["dual-read observation has not started"];
  const started = Date.parse(state.observation_started_at);
  const expires = Date.parse(state.observation_expires_at);
  const now = Date.now();
  if (!Number.isFinite(started) || !Number.isFinite(expires)) return ["dual-read observation timestamps are invalid"];
  return [
    ...(now - started >= minimumSeconds * 1000 ? [] : [`dual-read observation is shorter than ${minimumSeconds} seconds`]),
    ...(now <= expires ? [] : ["dual-read observation has expired"])
  ];
}

export function assertShadowRebuildAllowed(state: ReturnType<typeof getEventSummaryProjectionSwitch>): void {
  if (state.read_version !== "v1") {
    throw new Error("compact projection rebuild is blocked while V2 is the active read version");
  }
  const expires = Date.parse(state.observation_expires_at);
  if (state.observation_started_at && Number.isFinite(expires) && Date.now() <= expires) {
    throw new Error("compact projection rebuild is blocked during dual-read observation");
  }
}

export function withDatabase<T>(path: string, inside: (db: RunnerDatabase) => T): T {
  const dbPath = requiredText(path, "--db");
  const sqlite = new SQLiteDatabase(dbPath, { create: false, strict: true });
  sqlite.run("pragma foreign_keys = on");
  runMigrations(sqlite, [compactEventSummaryProjectionMigration, compactEventSummaryCreatedAtMigration]);
  const db: RunnerDatabase = {
    close: () => sqlite.close(),
    path: dbPath,
    readonly: false,
    sqlite,
    transaction: (callback) => sqlite.transaction(callback)
  };
  try {
    return inside(db);
  } finally {
    sqlite.close();
  }
}

export function audit(
  db: RunnerDatabase,
  actionID: string,
  authorization: Authorization,
  eventType: string,
  decision: string,
  result: Record<string, unknown>
): void {
  recordMaintenanceAudit(db.sqlite, {
    actionID,
    actor: authorization.actor,
    decision,
    eventType,
    reason: authorization.reason,
    result: { actor_kind: authorization.actorKind, audit_ref: authorization.auditRef, ...result }
  });
}

export function validatedAuthorization(input: Authorization): Authorization {
  const actor = requiredText(input.actor, "--actor");
  if (actor.toLowerCase() === "llm") throw new Error("--actor cannot be llm");
  if (!["retention_worker", "system", "user"].includes(input.actorKind)) {
    throw new Error("--actor-kind must be user, system, or retention_worker");
  }
  return {
    actor,
    actorKind: input.actorKind,
    auditRef: requiredText(input.auditRef, "--audit-ref"),
    reason: requiredText(input.reason, "--reason")
  };
}

export function scalar(db: RunnerDatabase, sql: string): number {
  return Number(db.sqlite.query<{ value: number }, []>(sql).get()?.value ?? 0);
}

function requiredText(value: string, label: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

export function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
