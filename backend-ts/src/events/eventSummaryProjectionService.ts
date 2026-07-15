import { randomUUID } from "node:crypto";
import { Database as SQLiteDatabase } from "bun:sqlite";
import type { RunnerDatabase } from "../db/database.ts";
import { runMigrations } from "../db/migrations.ts";
import { eventSummaryProjectionMigration } from "../db/schema/040_event_summary_projection.ts";
import {
  clearEventSummaryProjection,
  eventProjectionStatus
} from "../db/repositories/eventSummaryProjection.ts";
import { recordMaintenanceAudit } from "../db/repositories/eventMaintenance.ts";
import {
  EVENT_SUMMARY_PROJECTOR_VERSION,
  projectPendingEventSummaries
} from "./eventSummaryProjector.ts";

export type RebuildEventSummaryProjectionInput = {
  actor: string;
  actorKind: "retention_worker" | "system" | "user";
  auditRef: string;
  batchSize?: number;
  dbPath: string;
  maxBatches?: number;
  reason: string;
  resume?: boolean;
};

export function rebuildEventSummaryProjection(input: RebuildEventSummaryProjectionInput): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  const sqlite = new SQLiteDatabase(requiredText(input.dbPath, "--db"), { create: false, strict: true });
  sqlite.run("pragma foreign_keys = on");
  runMigrations(sqlite, [eventSummaryProjectionMigration]);
  const db = databaseAdapter(sqlite, input.dbPath);
  const actionID = `event-summary-rebuild:${randomUUID()}`;
  const before = eventProjectionStatus(db);
  try {
    recordAudit(sqlite, actionID, authorization, "event_summary_projection.rebuild_started", "allow", { before });
    if (!input.resume) {
      clearEventSummaryProjection(db, EVENT_SUMMARY_PROJECTOR_VERSION, new Date().toISOString());
    }
    const projection = projectPendingEventSummaries(db, {
      batchSize: input.batchSize,
      maxBatches: input.maxBatches
    });
    const after = eventProjectionStatus(db);
    recordAudit(sqlite, actionID, authorization, projection.paused
      ? "event_summary_projection.rebuild_paused"
      : "event_summary_projection.rebuild_completed", "allow", { after, projection });
    return {
      operation: "rebuild_event_summary_projection",
      resume: Boolean(input.resume),
      source_of_truth: "issue_events",
      destructive_scope: "derived_projection_only",
      before,
      after,
      ...projection
    };
  } catch (error) {
    try {
      recordAudit(sqlite, actionID, authorization, "event_summary_projection.rebuild_failed", "deny", {
        error: error instanceof Error ? error.message : String(error)
      });
    } catch {
      // Preserve the deterministic rebuild error if audit persistence also fails.
    }
    throw error;
  } finally {
    sqlite.close();
  }
}

function databaseAdapter(sqlite: SQLiteDatabase, path: string): RunnerDatabase {
  return {
    close: () => sqlite.close(),
    path,
    readonly: false,
    sqlite,
    transaction: (inside) => sqlite.transaction(inside)
  };
}

function validatedAuthorization(input: RebuildEventSummaryProjectionInput) {
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

function recordAudit(
  sqlite: SQLiteDatabase,
  actionID: string,
  authorization: { actor: string; actorKind: string; auditRef: string; reason: string },
  eventType: string,
  decision: string,
  result: Record<string, unknown>
): void {
  recordMaintenanceAudit(sqlite, {
    actionID,
    actor: authorization.actor,
    decision,
    eventType,
    reason: authorization.reason,
    result: { actor_kind: authorization.actorKind, audit_ref: authorization.auditRef, ...result }
  });
}

function requiredText(value: string, label: string): string {
  const text = value?.trim() ?? "";
  if (!text) throw new Error(`${label} is required`);
  return text;
}
