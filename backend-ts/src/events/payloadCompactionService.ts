import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  issueEventSnapshot,
  quickCheck,
  recordMaintenanceAudit,
  type IssueEventSnapshot
} from "../db/repositories/eventMaintenance.ts";
import {
  hydrateStoredIssueLogPayloadStrict,
  persistPlannedIssueLogArtifact,
  planIssueLogPayloadExternalization,
  type IssueLogPayloadExternalizationPlan
} from "../db/repositories/issueEvents.ts";

export const ISSUE_LOG_COMPACTION_SCHEMA_VERSION = "xuanwu.issue-log-payload-compaction.v1" as const;
export const DEFAULT_ISSUE_LOG_COMPACTION_MINIMUM_SAVINGS_BYTES = 4096;

type MaintenanceActor = { actor: string; auditRef: string; reason: string };
type PayloadRow = { id: number; payload: string };
type CompactionPlan = {
  artifact_4k_blocks_bytes: number;
  artifact_bytes: number;
  candidate_rows: number;
  estimated_net_reclaimable_bytes: number;
  estimated_physical_net_reclaimable_bytes: number;
  event_ids: number[];
  new_artifacts: number;
  source_payload_bytes: number;
  stored_payload_bytes: number;
  unique_artifacts: number;
};
type AppliedStats = {
  artifact_bytes_created: number;
  artifacts_created: number;
  source_payload_bytes: number;
  stored_payload_bytes: number;
};
type PayloadCheckpoint = {
  applied: AppliedStats;
  completed_at: string;
  created_at: string;
  cursor: number;
  database_path: string;
  event_ids: number[];
  minimum_savings_bytes: number;
  operation: "compact" | "restore";
  plan: CompactionPlan;
  schema_version: typeof ISSUE_LOG_COMPACTION_SCHEMA_VERSION;
  source_checkpoint?: string;
  source_snapshot: IssueEventSnapshot;
  status: "in_progress" | "paused" | "complete";
};

export function compactHistoricalIssueLogPayloads(input: {
  actor?: MaintenanceActor;
  apply?: boolean;
  batchSize?: number;
  checkpointPath: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  maxBatches?: number;
  minimumSavingsBytes?: number;
  reportPath: string;
  resume?: boolean;
}): Record<string, unknown> {
  const dbPath = existingDatabasePath(input.dbPath);
  const checkpointPath = resolve(input.checkpointPath);
  const minimumSavingsBytes = nonNegativeInteger(
    input.minimumSavingsBytes ?? DEFAULT_ISSUE_LOG_COMPACTION_MINIMUM_SAVINGS_BYTES,
    "minimum savings bytes"
  );
  const sqlite = openDatabase(dbPath, Boolean(input.apply));
  try {
    const before = issueEventSnapshot(sqlite);
    const checkpoint = input.resume
      ? readCheckpoint(checkpointPath, "compact")
      : newCompactionCheckpoint(dbPath, before, scanCompactionPlan(sqlite, dbPath, minimumSavingsBytes), minimumSavingsBytes);
    verifyCompactionCheckpoint(checkpoint, dbPath, before, minimumSavingsBytes, Boolean(input.resume));

    if (!input.apply) {
      const report = compactionReport(dbPath, before, before, checkpoint, true, false);
      writeJSON(resolve(input.reportPath), report);
      return report;
    }

    requireWriteAuthorization(input.actor, input.confirmBackupTested, input.confirmNoActiveWriters);
    if (!input.resume && existsSync(checkpointPath)) {
      throw new Error("checkpoint already exists; pass --resume or choose a new checkpoint path");
    }
    saveJSON(checkpointPath, checkpoint);
    audit(sqlite, input.actor!, "issue_log_payload_compaction.started", {
      candidate_rows: checkpoint.plan.candidate_rows,
      minimum_savings_bytes: minimumSavingsBytes
    });

    const batchSize = positiveInteger(input.batchSize ?? 250, "batch size");
    let batches = 0;
    while (checkpoint.cursor < checkpoint.event_ids.length) {
      const ids = checkpoint.event_ids.slice(checkpoint.cursor, checkpoint.cursor + batchSize);
      const rows = payloadRows(sqlite, ids);
      if (rows.length !== ids.length) throw new Error("compaction candidate rows changed after checkpoint creation");
      const planned = rows.map((row) => ({
        id: row.id,
        plan: requiredPlan(row, minimumSavingsBytes)
      }));
      for (const item of planned) {
        if (persistPlannedIssueLogArtifact({ path: dbPath }, item.plan)) {
          checkpoint.applied.artifacts_created += 1;
          checkpoint.applied.artifact_bytes_created += item.plan.artifact.stored_bytes;
        }
      }
      updatePayloadBatch(sqlite, planned);
      checkpoint.applied.source_payload_bytes += sum(planned.map((item) => item.plan.original_bytes));
      checkpoint.applied.stored_payload_bytes += sum(planned.map((item) => item.plan.stored_bytes));
      checkpoint.cursor += planned.length;
      checkpoint.status = "in_progress";
      saveJSON(checkpointPath, checkpoint);
      batches += 1;
      if (input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches") &&
        checkpoint.cursor < checkpoint.event_ids.length) {
        checkpoint.status = "paused";
        saveJSON(checkpointPath, checkpoint);
        audit(sqlite, input.actor!, "issue_log_payload_compaction.paused", { compacted_rows: checkpoint.cursor });
        const report = compactionReport(dbPath, before, issueEventSnapshot(sqlite), checkpoint, false, true);
        writeJSON(resolve(input.reportPath), report);
        return report;
      }
    }

    checkpoint.status = "complete";
    checkpoint.completed_at = new Date().toISOString();
    saveJSON(checkpointPath, checkpoint);
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-compaction quick_check failed: ${integrity}`);
    audit(sqlite, input.actor!, "issue_log_payload_compaction.completed", {
      compacted_rows: checkpoint.cursor,
      quick_check: integrity
    });
    const report = compactionReport(dbPath, before, issueEventSnapshot(sqlite), checkpoint, false, false);
    writeJSON(resolve(input.reportPath), report);
    return report;
  } finally {
    sqlite.close();
  }
}

export function restoreHistoricalIssueLogPayloads(input: {
  actor?: MaintenanceActor;
  apply?: boolean;
  batchSize?: number;
  checkpointPath: string;
  compactionCheckpointPath: string;
  confirmBackupTested?: boolean;
  confirmNoActiveWriters?: boolean;
  dbPath: string;
  maxBatches?: number;
  reportPath: string;
  resume?: boolean;
}): Record<string, unknown> {
  const dbPath = existingDatabasePath(input.dbPath);
  const sourcePath = resolve(input.compactionCheckpointPath);
  const source = readCheckpoint(sourcePath, "compact");
  const restoreIDs = source.event_ids.slice(0, source.cursor);
  const checkpointPath = resolve(input.checkpointPath);
  const sqlite = openDatabase(dbPath, Boolean(input.apply));
  try {
    const before = issueEventSnapshot(sqlite);
    const checkpoint = input.resume
      ? readCheckpoint(checkpointPath, "restore")
      : newRestoreCheckpoint(dbPath, before, sourcePath, restoreIDs, source.minimum_savings_bytes);
    verifyRestoreCheckpoint(checkpoint, dbPath, sourcePath, restoreIDs, Boolean(input.resume));

    if (!input.apply) {
      const report = restoreReport(dbPath, before, before, checkpoint, true, false);
      writeJSON(resolve(input.reportPath), report);
      return report;
    }

    requireWriteAuthorization(input.actor, input.confirmBackupTested, input.confirmNoActiveWriters);
    if (!input.resume && existsSync(checkpointPath)) {
      throw new Error("checkpoint already exists; pass --resume or choose a new checkpoint path");
    }
    saveJSON(checkpointPath, checkpoint);
    audit(sqlite, input.actor!, "issue_log_payload_compaction.restore_started", {
      restore_rows: checkpoint.event_ids.length,
      source_checkpoint: sourcePath
    });

    const batchSize = positiveInteger(input.batchSize ?? 250, "batch size");
    let batches = 0;
    while (checkpoint.cursor < checkpoint.event_ids.length) {
      const ids = checkpoint.event_ids.slice(checkpoint.cursor, checkpoint.cursor + batchSize);
      const rows = payloadRows(sqlite, ids);
      if (rows.length !== ids.length) throw new Error("restore candidate rows changed after checkpoint creation");
      const hydrated = rows.map((row) => ({
        id: row.id,
        original: hydrateStoredIssueLogPayloadStrict({ path: dbPath }, row.payload),
        stored: row.payload
      }));
      restorePayloadBatch(sqlite, hydrated);
      checkpoint.applied.source_payload_bytes += sum(hydrated.map((item) => Buffer.byteLength(item.original)));
      checkpoint.applied.stored_payload_bytes += sum(hydrated.map((item) => Buffer.byteLength(item.stored)));
      checkpoint.cursor += hydrated.length;
      checkpoint.status = "in_progress";
      saveJSON(checkpointPath, checkpoint);
      batches += 1;
      if (input.maxBatches !== undefined && batches >= positiveInteger(input.maxBatches, "max batches") &&
        checkpoint.cursor < checkpoint.event_ids.length) {
        checkpoint.status = "paused";
        saveJSON(checkpointPath, checkpoint);
        audit(sqlite, input.actor!, "issue_log_payload_compaction.restore_paused", { restored_rows: checkpoint.cursor });
        const report = restoreReport(dbPath, before, issueEventSnapshot(sqlite), checkpoint, false, true);
        writeJSON(resolve(input.reportPath), report);
        return report;
      }
    }

    checkpoint.status = "complete";
    checkpoint.completed_at = new Date().toISOString();
    saveJSON(checkpointPath, checkpoint);
    const integrity = quickCheck(sqlite);
    if (integrity !== "ok") throw new Error(`post-restore quick_check failed: ${integrity}`);
    audit(sqlite, input.actor!, "issue_log_payload_compaction.restore_completed", {
      quick_check: integrity,
      restored_rows: checkpoint.cursor
    });
    const report = restoreReport(dbPath, before, issueEventSnapshot(sqlite), checkpoint, false, false);
    writeJSON(resolve(input.reportPath), report);
    return report;
  } finally {
    sqlite.close();
  }
}

function scanCompactionPlan(sqlite: Database, dbPath: string, minimumSavingsBytes: number): CompactionPlan {
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

function newCompactionCheckpoint(
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

function newRestoreCheckpoint(
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

function requiredPlan(row: PayloadRow, minimumSavingsBytes: number): IssueLogPayloadExternalizationPlan {
  const plan = planIssueLogPayloadExternalization(row.payload, minimumSavingsBytes);
  if (!plan) throw new Error(`issue_events:${row.id} no longer matches the compaction checkpoint`);
  return plan;
}

function updatePayloadBatch(
  sqlite: Database,
  rows: Array<{ id: number; plan: IssueLogPayloadExternalizationPlan }>
): void {
  const update = sqlite.query("update issue_events set payload=? where id=? and type='issue.log' and payload=?");
  const apply = sqlite.transaction((items: typeof rows) => {
    for (const item of items) {
      const result = update.run(item.plan.stored_payload, item.id, item.plan.original_payload);
      if (Number(result.changes) !== 1) throw new Error(`issue_events:${item.id} compaction compare-and-set failed`);
    }
  });
  apply.immediate(rows);
}

function restorePayloadBatch(
  sqlite: Database,
  rows: Array<{ id: number; original: string; stored: string }>
): void {
  const update = sqlite.query("update issue_events set payload=? where id=? and type='issue.log' and payload=?");
  const restore = sqlite.transaction((items: typeof rows) => {
    for (const item of items) {
      const result = update.run(item.original, item.id, item.stored);
      if (Number(result.changes) !== 1) throw new Error(`issue_events:${item.id} restore compare-and-set failed`);
    }
  });
  restore.immediate(rows);
}

function payloadRows(sqlite: Database, ids: number[]): PayloadRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(", ");
  return sqlite.query<PayloadRow, number[]>(`
    select id, payload from issue_events where id in (${placeholders}) order by id asc
  `).all(...ids);
}

function compactionReport(
  dbPath: string,
  _before: IssueEventSnapshot,
  after: IssueEventSnapshot,
  checkpoint: PayloadCheckpoint,
  dryRun: boolean,
  paused: boolean
): Record<string, unknown> {
  return {
    schema_version: ISSUE_LOG_COMPACTION_SCHEMA_VERSION,
    operation: "compact_issue_log_payloads",
    dry_run: dryRun,
    paused,
    database: { path: dbPath, file_bytes: statSync(dbPath).size, quick_check: quickCheckPath(dbPath) },
    minimum_savings_bytes: checkpoint.minimum_savings_bytes,
    plan: withoutEventIDs(checkpoint.plan),
    checkpoint: { cursor: checkpoint.cursor, status: checkpoint.status, total: checkpoint.event_ids.length },
    applied: checkpoint.applied,
    source_snapshot: checkpoint.source_snapshot,
    current_snapshot: after,
    destructive_changes: !dryRun
  };
}

function restoreReport(
  dbPath: string,
  _before: IssueEventSnapshot,
  after: IssueEventSnapshot,
  checkpoint: PayloadCheckpoint,
  dryRun: boolean,
  paused: boolean
): Record<string, unknown> {
  return {
    schema_version: ISSUE_LOG_COMPACTION_SCHEMA_VERSION,
    operation: "restore_issue_log_payloads",
    dry_run: dryRun,
    paused,
    database: { path: dbPath, file_bytes: statSync(dbPath).size, quick_check: quickCheckPath(dbPath) },
    restore_rows: checkpoint.event_ids.length,
    checkpoint: { cursor: checkpoint.cursor, status: checkpoint.status, total: checkpoint.event_ids.length },
    applied: checkpoint.applied,
    source_snapshot: checkpoint.source_snapshot,
    current_snapshot: after,
    destructive_changes: !dryRun
  };
}

function verifyCompactionCheckpoint(
  checkpoint: PayloadCheckpoint,
  dbPath: string,
  snapshot: IssueEventSnapshot,
  minimumSavingsBytes: number,
  resume: boolean
): void {
  if (checkpoint.database_path !== dbPath || checkpoint.minimum_savings_bytes !== minimumSavingsBytes) {
    throw new Error("compaction checkpoint inputs do not match");
  }
  if (checkpoint.source_snapshot.issue_event_count !== snapshot.issue_event_count ||
    checkpoint.source_snapshot.first_event_id !== snapshot.first_event_id ||
    checkpoint.source_snapshot.last_event_id !== snapshot.last_event_id) {
    throw new Error("issue_events identity snapshot changed after compaction planning");
  }
  if (resume && checkpoint.status === "complete") throw new Error("compaction checkpoint is already complete");
}

function verifyRestoreCheckpoint(
  checkpoint: PayloadCheckpoint,
  dbPath: string,
  sourcePath: string,
  eventIDs: number[],
  resume: boolean
): void {
  if (checkpoint.database_path !== dbPath || checkpoint.source_checkpoint !== sourcePath ||
    !sameEventIDs(checkpoint.event_ids, eventIDs)) {
    throw new Error("restore checkpoint inputs do not match");
  }
  if (resume && checkpoint.status === "complete") throw new Error("restore checkpoint is already complete");
}

function readCheckpoint(path: string, operation: PayloadCheckpoint["operation"]): PayloadCheckpoint {
  const value = JSON.parse(readFileSync(resolve(path), "utf8")) as PayloadCheckpoint;
  if (value.schema_version !== ISSUE_LOG_COMPACTION_SCHEMA_VERSION || value.operation !== operation ||
    !Array.isArray(value.event_ids) || !Number.isSafeInteger(value.cursor) || value.cursor < 0 ||
    value.cursor > value.event_ids.length || !ascendingPositiveEventIDs(value.event_ids) ||
    !sameEventIDs(value.event_ids, value.plan?.event_ids ?? [])) {
    throw new Error(`invalid ${operation} checkpoint`);
  }
  return value;
}

function openDatabase(path: string, writable: boolean): Database {
  const sqlite = new Database(path, writable
    ? { readwrite: true, strict: true }
    : { readonly: true, strict: true });
  sqlite.run("pragma foreign_keys = on");
  return sqlite;
}

function existingDatabasePath(value: string): string {
  const path = resolve(value);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`database does not exist: ${path}`);
  return path;
}

function requireWriteAuthorization(
  actor: MaintenanceActor | undefined,
  confirmBackupTested: boolean | undefined,
  confirmNoActiveWriters: boolean | undefined
): void {
  if (!actor?.actor.trim() || !actor.auditRef.trim() || !actor.reason.trim()) {
    throw new Error("applied payload compaction requires actor, audit ref, and reason");
  }
  if (!confirmBackupTested) throw new Error("--confirm-backup-tested is required with --apply");
  if (!confirmNoActiveWriters) throw new Error("--confirm-no-active-writers is required with --apply");
}

function audit(sqlite: Database, actor: MaintenanceActor, eventType: string, result: Record<string, unknown>): void {
  recordMaintenanceAudit(sqlite, {
    actionID: actor.auditRef,
    actor: actor.actor,
    decision: "allow",
    eventType,
    reason: actor.reason,
    result
  });
}

function saveJSON(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function writeJSON(path: string, value: unknown): void {
  saveJSON(path, value);
}

function quickCheckPath(path: string): string {
  const sqlite = openDatabase(path, false);
  try {
    return quickCheck(sqlite);
  } finally {
    sqlite.close();
  }
}

function withoutEventIDs(plan: CompactionPlan): Omit<CompactionPlan, "event_ids"> {
  const { event_ids: _, ...summary } = plan;
  return summary;
}

function emptyAppliedStats(): AppliedStats {
  return { artifact_bytes_created: 0, artifacts_created: 0, source_payload_bytes: 0, stored_payload_bytes: 0 };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sameEventIDs(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function ascendingPositiveEventIDs(values: number[]): boolean {
  return values.every((value, index) => Number.isSafeInteger(value) && value > 0 &&
    (index === 0 || value > values[index - 1]!));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}
