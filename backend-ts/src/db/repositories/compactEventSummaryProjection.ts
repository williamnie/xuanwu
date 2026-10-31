import type { RunnerDatabase } from "../database.ts";
import { listSourceIssueEvents, type EventProjectionWatermark } from "./eventSummaryProjection.ts";
import { positiveInteger } from "./compactEventSummaryProjectionQueries.ts";
import { DEFAULT_BATCH_SIZE, COMPACT_EVENT_SUMMARY_PROJECTOR_VERSION } from "./compactEventSummaryProjectionModel.ts";
import {
  compactWatermark,
  projectCompactSourceIssueEvent,
  dictionaryRef,
  payloadDictionaryRef,
  saveCompactWatermark
} from "./compactEventSummaryProjectionDictionary.ts";

export function projectPendingCompactEventSummaries(
  db: RunnerDatabase,
  options: { batchSize?: number; maxBatches?: number; maxWallMs?: number } = {}
): { batches: number; paused: boolean; projected_rows: number; watermark: EventProjectionWatermark } {
  const startedAt = performance.now();
  const maxWallMs = options.maxWallMs ?? Number.POSITIVE_INFINITY;
  if (!(maxWallMs > 0)) throw new Error("maxWallMs must be positive");
  const batchSize = positiveInteger(options.batchSize ?? DEFAULT_BATCH_SIZE, "batchSize");
  const maxBatches = options.maxBatches === undefined
    ? Number.POSITIVE_INFINITY
    : positiveInteger(options.maxBatches, "maxBatches");
  let watermark = compactWatermark(db);
  if (watermark.projector_version !== COMPACT_EVENT_SUMMARY_PROJECTOR_VERSION) {
    throw new Error(`compact event summary projection version mismatch: ${watermark.projector_version}; rebuild required`);
  }
  let batches = 0;
  let projectedRows = 0;
  let projectedRowCount = watermark.projected_row_count;
  const hasPendingRows = listSourceIssueEvents(db, {
    afterID: watermark.last_event_id,
    hydrateIssueLogs: false,
    limit: 1
  }).length > 0;
  if (!hasPendingRows) {
    return { batches, paused: false, projected_rows: projectedRows, watermark };
  }
  while (batches < maxBatches) {
    const rows = listSourceIssueEvents(db, {
      afterID: watermark.last_event_id,
      hydrateIssueLogs: false,
      limit: batchSize
    });
    if (rows.length === 0) break;
    // 每批只缓存当前输入涉及的字典项，避免历史增长放大每轮内存和扫描成本。
    const runRefs = new Map<string, number>();
    const typeRefs = new Map<string, number>();
    const projectRefs = new Map<string, number>();
    const payloadRefs = new Map<string, number>();
    const payloadHashes = new Map<string, string>();
    const storedReferenceEvents = new Set<number>();
    const projectedAt = new Date().toISOString();
    let processed = 0;
    db.transaction(() => {
      for (const source of rows) {
        // 至少推进一条；预算在每条之间检查，水位只能覆盖已提交的输入。
        if (processed > 0 && performance.now() - startedAt >= maxWallMs) break;
        const projected = projectCompactSourceIssueEvent(db, source, projectedAt, storedReferenceEvents);
        const runRef = dictionaryRef(db, "event_summary_projection_runs", "run_ref", "run_id", projected.run_id, runRefs);
        const typeRef = dictionaryRef(db, "event_summary_projection_types", "event_type_ref", "event_type", projected.event_type, typeRefs);
        const projectRef = dictionaryRef(db, "event_summary_projection_projects", "project_ref", "project_id", projected.project_id, projectRefs);
        const payloadRef = payloadDictionaryRef(db, projected.summary_payload, payloadRefs, payloadHashes);
        const result = db.sqlite.run(`
          insert into event_summary_projection_compact (
            source_event_id, issue_id, project_ref, run_ref, event_type_ref, payload_ref,
            source_payload_bytes, source_sha256, event_created_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?)
          on conflict(source_event_id) do update set
            issue_id=excluded.issue_id,
            project_ref=excluded.project_ref,
            run_ref=excluded.run_ref,
            event_type_ref=excluded.event_type_ref,
            payload_ref=excluded.payload_ref,
            source_payload_bytes=excluded.source_payload_bytes,
            source_sha256=excluded.source_sha256,
            event_created_at=excluded.event_created_at
          where event_summary_projection_compact.source_sha256<>excluded.source_sha256
        `, [
          projected.source_event_id,
          projected.issue_id,
          projectRef,
          runRef,
          typeRef,
          payloadRef,
          projected.source_payload_bytes,
          Buffer.from(projected.source_sha256, "hex"),
          projected.event_created_at
        ]);
        if (Number(result.changes) > 0 && projected.source_event_id > watermark.last_event_id) projectedRowCount += 1;
        processed += 1;
      }
      watermark = saveCompactWatermark(db, {
        lastEventID: rows[processed - 1]!.id,
        projectedRowCount,
        updatedAt: projectedAt
      });
    }).immediate();
    batches += 1;
    projectedRows += processed;
    if (performance.now() - startedAt >= maxWallMs) break;
  }
  const paused = listSourceIssueEvents(db, {
    afterID: watermark.last_event_id,
    hydrateIssueLogs: false,
    limit: 1
  }).length > 0;
  return { batches, paused, projected_rows: projectedRows, watermark };
}

export function clearCompactEventSummaryProjection(db: RunnerDatabase, at = new Date().toISOString()): void {
  db.transaction(() => {
    db.sqlite.run("delete from event_summary_projection_compact");
    db.sqlite.run("delete from event_summary_projection_payloads");
    db.sqlite.run("delete from event_summary_projection_projects");
    db.sqlite.run("delete from event_summary_projection_runs");
    db.sqlite.run("delete from event_summary_projection_types");
    saveCompactWatermark(db, { lastEventID: 0, projectedRowCount: 0, updatedAt: at });
  }).immediate();
}

export { compactProjectionStatus } from "./compactEventSummaryProjectionQueries.ts";
export { eventProjectionStatusForRead } from "./compactEventSummaryProjectionQueries.ts";
export { listCompactEventSummaryProjection } from "./compactEventSummaryProjectionQueries.ts";
export { listEventSummaryProjectionForRead } from "./compactEventSummaryProjectionQueries.ts";
export { eventSummaryTypeCountsForRead } from "./compactEventSummaryProjectionQueries.ts";
export { getEventSummaryProjectionSwitch } from "./compactEventSummaryProjectionSwitch.ts";
export { updateEventSummaryProjectionSwitch } from "./compactEventSummaryProjectionSwitch.ts";
export { assertProjectionParity } from "./compactEventSummaryProjectionSwitch.ts";
