import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type IssueEventSnapshot } from "../db/repositories/eventMaintenance.ts";
import {
  planIssueLogPayloadExternalization,
  type IssueLogPayloadExternalizationPlan
} from "../db/repositories/issueEvents.ts";
import {
  type CompactionPlan,
  type PayloadRow,
  type PayloadCheckpoint,
  emptyAppliedStats,
  ISSUE_LOG_COMPACTION_SCHEMA_VERSION
} from "./payloadCompactionServiceModel.ts";

export function scanCompactionPlan(sqlite: Database, dbPath: string, minimumSavingsBytes: number): CompactionPlan {
  const eventIDs: number[] = [];
  const artifacts = new Set<string>();
  const newArtifacts = new Set<string>();
  let afterID = 0;
  let sourcePayloadBytes = 0;
  let storedPayloadBytes = 0;
  let artifactBytes = 0;
  let artifact4KBlocksBytes = 0;
  while (true) {
    const rows = sqlite.query<PayloadRow, [number]>(`
      select id, payload from issue_events
      where type='issue.log' and id>? order by id asc limit 1000
    `).all(afterID);
    if (rows.length === 0) break;
    for (const row of rows) {
      const plan = planIssueLogPayloadExternalization(row.payload, minimumSavingsBytes);
      if (!plan) continue;
      eventIDs.push(row.id);
      sourcePayloadBytes += plan.original_bytes;
      storedPayloadBytes += plan.stored_bytes;
      artifacts.add(plan.artifact.ref);
      if (!newArtifacts.has(plan.artifact.ref) && !existsSync(resolve(dirname(dbPath), plan.artifact.ref))) {
        newArtifacts.add(plan.artifact.ref);
        artifactBytes += plan.artifact.stored_bytes;
        artifact4KBlocksBytes += Math.ceil(plan.artifact.stored_bytes / 4096) * 4096;
      }
    }
    afterID = rows.at(-1)!.id;
  }
  return {
    artifact_4k_blocks_bytes: artifact4KBlocksBytes,
    artifact_bytes: artifactBytes,
    candidate_rows: eventIDs.length,
    estimated_net_reclaimable_bytes: Math.max(0, sourcePayloadBytes - storedPayloadBytes - artifactBytes),
    estimated_physical_net_reclaimable_bytes: Math.max(
      0,
      sourcePayloadBytes - storedPayloadBytes - artifact4KBlocksBytes
    ),
    event_ids: eventIDs,
    new_artifacts: newArtifacts.size,
    source_payload_bytes: sourcePayloadBytes,
    stored_payload_bytes: storedPayloadBytes,
    unique_artifacts: artifacts.size
  };
}

export function newCompactionCheckpoint(
  dbPath: string,
  snapshot: IssueEventSnapshot,
  plan: CompactionPlan,
  minimumSavingsBytes: number
): PayloadCheckpoint {
  return {
    applied: emptyAppliedStats(),
    completed_at: "",
    created_at: new Date().toISOString(),
    cursor: 0,
    database_path: dbPath,
    event_ids: plan.event_ids,
    minimum_savings_bytes: minimumSavingsBytes,
    operation: "compact",
    plan,
    schema_version: ISSUE_LOG_COMPACTION_SCHEMA_VERSION,
    source_snapshot: snapshot,
    status: "in_progress"
  };
}

export function newRestoreCheckpoint(
  dbPath: string,
  snapshot: IssueEventSnapshot,
  sourcePath: string,
  eventIDs: number[],
  minimumSavingsBytes: number
): PayloadCheckpoint {
  return {
    applied: emptyAppliedStats(),
    completed_at: "",
    created_at: new Date().toISOString(),
    cursor: 0,
    database_path: dbPath,
    event_ids: eventIDs,
    minimum_savings_bytes: minimumSavingsBytes,
    operation: "restore",
    plan: {
      artifact_4k_blocks_bytes: 0,
      artifact_bytes: 0,
      candidate_rows: eventIDs.length,
      estimated_net_reclaimable_bytes: 0,
      estimated_physical_net_reclaimable_bytes: 0,
      event_ids: eventIDs,
      new_artifacts: 0,
      source_payload_bytes: 0,
      stored_payload_bytes: 0,
      unique_artifacts: 0
    },
    schema_version: ISSUE_LOG_COMPACTION_SCHEMA_VERSION,
    source_checkpoint: sourcePath,
    source_snapshot: snapshot,
    status: "in_progress"
  };
}

export function requiredPlan(row: PayloadRow, minimumSavingsBytes: number): IssueLogPayloadExternalizationPlan {
  const plan = planIssueLogPayloadExternalization(row.payload, minimumSavingsBytes);
  if (!plan) throw new Error(`issue_events:${row.id} no longer matches the compaction checkpoint`);
  return plan;
}
