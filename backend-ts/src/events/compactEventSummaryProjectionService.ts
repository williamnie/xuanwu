import { randomUUID } from "node:crypto";
import { eventProjectionStatus } from "../db/repositories/eventSummaryProjection.ts";
import {
  clearCompactEventSummaryProjection,
  compactProjectionStatus,
  getEventSummaryProjectionSwitch,
  projectPendingCompactEventSummaries,
  updateEventSummaryProjectionSwitch
} from "../db/repositories/compactEventSummaryProjection.ts";
import {
  type AuthorizedDatabaseInput,
  type DatabaseInput,
  DEFAULT_OBSERVATION_SECONDS
} from "./compactEventSummaryProjectionServiceModel.ts";
import {
  validatedAuthorization,
  withDatabase,
  audit,
  assertShadowRebuildAllowed,
  switchBlockers,
  nonNegativeInteger,
  observationBlockers,
  mutationConfirmationBlockers,
  scalar
} from "./compactEventSummaryProjectionServiceAuthorization.ts";
import { verifyCompactProjection } from "./compactEventSummaryProjectionServiceVerification.ts";

export function rebuildCompactEventSummaryProjection(
  input: AuthorizedDatabaseInput & { batchSize?: number; maxBatches?: number; resume?: boolean }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const actionID = `compact-event-summary-rebuild:${randomUUID()}`;
    const before = compactProjectionStatus(db);
    try {
      audit(db, actionID, authorization, "event_summary_projection.compact_rebuild_started", "allow", { before });
      if (!input.resume) {
        assertShadowRebuildAllowed(getEventSummaryProjectionSwitch(db));
        clearCompactEventSummaryProjection(db);
      }
      const projection = projectPendingCompactEventSummaries(db, {
        batchSize: input.batchSize,
        maxBatches: input.maxBatches
      });
      const after = compactProjectionStatus(db);
      audit(db, actionID, authorization, projection.paused
        ? "event_summary_projection.compact_rebuild_paused"
        : "event_summary_projection.compact_rebuild_completed", "allow", { after, projection });
      return {
        operation: "rebuild_compact_event_summary_projection",
        source_of_truth: "issue_events",
        destructive_scope: "none_shadow_only",
        resume: Boolean(input.resume),
        before,
        after,
        ...projection
      };
    } catch (error) {
      try {
        audit(db, actionID, authorization, "event_summary_projection.compact_rebuild_failed", "deny", {
          error: error instanceof Error ? error.message : String(error)
        });
      } catch {
        // Preserve the deterministic rebuild failure.
      }
      throw error;
    }
  });
}

export function verifyCompactEventSummaryProjection(
  input: DatabaseInput & { performanceSamples?: number }
): Record<string, unknown> {
  return withDatabase(input.dbPath, (db) => verifyCompactProjection(db, input.performanceSamples));
}

export function observeCompactEventSummaryProjection(
  input: AuthorizedDatabaseInput & {
    apply?: boolean;
    confirmBackupTested?: boolean;
    confirmNoActiveWriters?: boolean;
    durationSeconds?: number;
  }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const verification = verifyCompactProjection(db);
    const blockers = switchBlockers(input, verification);
    const before = getEventSummaryProjectionSwitch(db);
    if (!input.apply || blockers.length > 0) {
      return {
        operation: "observe_compact_event_summary_projection",
        dry_run: true,
        applied: false,
        blockers,
        before,
        verification
      };
    }
    const durationSeconds = nonNegativeInteger(input.durationSeconds ?? DEFAULT_OBSERVATION_SECONDS, "durationSeconds");
    const now = new Date();
    const after = updateEventSummaryProjectionSwitch(db, {
      cutover_at: before.cutover_at,
      expectedRevision: before.revision,
      observation_expires_at: new Date(now.getTime() + durationSeconds * 1000).toISOString(),
      observation_started_at: now.toISOString(),
      read_version: "v1",
      updatedAt: now.toISOString()
    });
    audit(db, `compact-event-summary-observe:${randomUUID()}`, authorization,
      "event_summary_projection.compact_observation_started", "allow", { after, before, verification });
    return { operation: "observe_compact_event_summary_projection", dry_run: false, applied: true, blockers, before, after, verification };
  });
}

export function cutoverCompactEventSummaryProjection(
  input: AuthorizedDatabaseInput & {
    apply?: boolean;
    confirmBackupTested?: boolean;
    confirmNoActiveWriters?: boolean;
    minimumObservationSeconds?: number;
  }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const verification = verifyCompactProjection(db);
    const before = getEventSummaryProjectionSwitch(db);
    const minimum = nonNegativeInteger(input.minimumObservationSeconds ?? DEFAULT_OBSERVATION_SECONDS, "minimumObservationSeconds");
    const blockers = [
      ...switchBlockers(input, verification),
      ...observationBlockers(before, minimum)
    ];
    if (!input.apply || blockers.length > 0) {
      return {
        operation: "cutover_compact_event_summary_projection",
        dry_run: true,
        applied: false,
        blockers,
        before,
        verification
      };
    }
    const at = new Date().toISOString();
    const after = updateEventSummaryProjectionSwitch(db, {
      cutover_at: at,
      expectedRevision: before.revision,
      observation_expires_at: before.observation_expires_at,
      observation_started_at: before.observation_started_at,
      read_version: "v2",
      updatedAt: at
    });
    audit(db, `compact-event-summary-cutover:${randomUUID()}`, authorization,
      "event_summary_projection.compact_cutover", "allow", { after, before, verification });
    return { operation: "cutover_compact_event_summary_projection", dry_run: false, applied: true, blockers, before, after, verification };
  });
}

export function rollbackCompactEventSummaryProjection(
  input: AuthorizedDatabaseInput & {
    apply?: boolean;
    confirmBackupTested?: boolean;
    confirmNoActiveWriters?: boolean;
  }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const before = getEventSummaryProjectionSwitch(db);
    const legacy = eventProjectionStatus(db);
    const blockers = [
      ...mutationConfirmationBlockers(input),
      ...(legacy.lag_rows === 0 ? [] : [`legacy projection lag is ${legacy.lag_rows}`])
    ];
    if (!input.apply || blockers.length > 0) {
      return { operation: "rollback_compact_event_summary_projection", dry_run: true, applied: false, blockers, before, legacy };
    }
    const at = new Date().toISOString();
    const after = updateEventSummaryProjectionSwitch(db, {
      cutover_at: before.cutover_at,
      expectedRevision: before.revision,
      observation_expires_at: before.observation_expires_at,
      observation_started_at: before.observation_started_at,
      read_version: "v1",
      updatedAt: at
    });
    audit(db, `compact-event-summary-rollback:${randomUUID()}`, authorization,
      "event_summary_projection.compact_rollback", "allow", { after, before, legacy });
    return { operation: "rollback_compact_event_summary_projection", dry_run: false, applied: true, blockers, before, after, legacy };
  });
}

export function retireLegacyEventSummaryProjection(
  input: AuthorizedDatabaseInput & {
    apply?: boolean;
    confirmBackupTested?: boolean;
    confirmNoActiveWriters?: boolean;
  }
): Record<string, unknown> {
  const authorization = validatedAuthorization(input);
  return withDatabase(input.dbPath, (db) => {
    const state = getEventSummaryProjectionSwitch(db);
    const compact = compactProjectionStatus(db);
    const before = {
      legacy_rows: scalar(db, "select count(*) as value from event_summary_projection"),
      legacy_watermark: scalar(db, `select coalesce(last_event_id, 0) as value from event_projection_watermarks
        where projection_id='issue_events_summary_v1'`)
    };
    const missingCreatedAt = scalar(db, `select count(*) as value
      from event_summary_projection_compact where event_created_at=''`);
    const blockers = [
      ...mutationConfirmationBlockers(input),
      ...(state.read_version === "v2" ? [] : ["compact projection is not the active reader"]),
      ...(state.cutover_at ? [] : ["compact projection cutover timestamp is missing"]),
      ...(compact.lag_rows === 0 ? [] : [`compact projection lag is ${compact.lag_rows}`]),
      ...(missingCreatedAt === 0 ? [] : [`compact projection has ${missingCreatedAt} rows without event_created_at`])
    ];
    if (!input.apply || blockers.length > 0) {
      return {
        operation: "retire_legacy_event_summary_projection",
        applied: false,
        dry_run: true,
        blockers,
        before,
        compact,
        switch: state
      };
    }
    const actionID = `legacy-event-summary-retire:${randomUUID()}`;
    audit(db, actionID, authorization, "event_summary_projection.legacy_retire_started", "allow", {
      before,
      compact,
      switch: state
    });
    db.transaction(() => {
      db.sqlite.run("delete from event_summary_projection");
      db.sqlite.run(`update event_projection_watermarks
        set last_event_id=0, projected_row_count=0, updated_at=?
        where projection_id='issue_events_summary_v1'`, [new Date().toISOString()]);
    }).immediate();
    const after = {
      legacy_rows: scalar(db, "select count(*) as value from event_summary_projection"),
      legacy_watermark: scalar(db, `select coalesce(last_event_id, 0) as value from event_projection_watermarks
        where projection_id='issue_events_summary_v1'`),
      physical_reclaim_pending_vacuum: true
    };
    audit(db, actionID, authorization, "event_summary_projection.legacy_retired", "allow", { after, before });
    return {
      operation: "retire_legacy_event_summary_projection",
      applied: true,
      dry_run: false,
      blockers,
      before,
      after,
      compact,
      switch: state
    };
  });
}
