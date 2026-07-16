import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { rebuildEventSummaryProjection } from "./eventSummaryProjectionService.ts";
import { projectPendingEventSummaries } from "./eventSummaryProjector.ts";
import { vacuumEventDatabase } from "./maintenanceService.ts";
import {
  compactHistoricalIssueLogPayloads,
  restoreHistoricalIssueLogPayloads
} from "./payloadCompactionService.ts";

const roots: string[] = [];
const ACTOR = {
  actor: "operator-1",
  auditRef: "pi_action_events:payload-compaction-test",
  reason: "database copy rehearsal"
};

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("historical issue.log payload compaction", () => {
  test("dry-runs, resumes, preserves projection hashes, vacuums, and restores exact payloads", async () => {
    const root = mkdtempSync(join(tmpdir(), "issue-log-payload-compaction-"));
    roots.push(root);
    const dbPath = join(root, "state", "runner.db");
    const db = await openDatabase({ dbPath, stateDir: dirname(dbPath) });
    const issueID = seed(db);
    projectPendingEventSummaries(db);
    const originalRows = eventRows(db.sqlite);
    const originalProjection = projectionHashes(db.sqlite);
    const originalPayloadBytes = payloadBytes(db.sqlite);
    db.close();

    const checkpointPath = join(root, "maintenance", "compact-checkpoint.json");
    const dryRun = compactHistoricalIssueLogPayloads({
      checkpointPath,
      dbPath,
      reportPath: join(root, "reports", "compact-dry-run.json")
    });
    expect(dryRun).toMatchObject({
      dry_run: true,
      minimum_savings_bytes: 4096,
      plan: { candidate_rows: 12, new_artifacts: 12, unique_artifacts: 12 },
      checkpoint: { cursor: 0, total: 12 }
    });
    expect(existsSync(checkpointPath)).toBe(false);
    expect(existsSync(join(dirname(dbPath), "artifacts"))).toBe(false);

    const paused = compactHistoricalIssueLogPayloads({
      actor: ACTOR,
      apply: true,
      batchSize: 5,
      checkpointPath,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      maxBatches: 1,
      reportPath: join(root, "reports", "compact-paused.json")
    });
    expect(paused).toMatchObject({ paused: true, checkpoint: { cursor: 5, total: 12 } });

    const compacted = compactHistoricalIssueLogPayloads({
      actor: ACTOR,
      apply: true,
      batchSize: 5,
      checkpointPath,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      reportPath: join(root, "reports", "compact.json"),
      resume: true
    });
    expect(compacted).toMatchObject({
      dry_run: false,
      paused: false,
      checkpoint: { cursor: 12, status: "complete", total: 12 },
      database: { quick_check: "ok" }
    });

    const compactedDB = new Database(dbPath, { readonly: true, strict: true });
    expect(payloadBytes(compactedDB)).toBeLessThan(originalPayloadBytes / 4);
    expect(eventRows(compactedDB)).toHaveLength(originalRows.length);
    expect(eventRows(compactedDB).filter((row) => row.type === "issue.log").every((row) =>
      row.payload.includes('"issue_log_artifact"'))).toBe(true);
    compactedDB.close();

    const hydrated = await openDatabase({ dbPath, stateDir: dirname(dbPath) });
    expect(listIssueEvents(hydrated, issueID).map((event) => event.payload)).toEqual(
      originalRows.filter((row) => row.type === "issue.log").map((row) => row.payload)
    );
    hydrated.close();

    rebuildEventSummaryProjection({
      actor: "operator-1",
      actorKind: "user",
      auditRef: "pi_action_events:payload-compaction-projection-test",
      dbPath,
      reason: "verify projection parity after payload compaction"
    });
    const rebuilt = new Database(dbPath, { readonly: true, strict: true });
    expect(projectionHashes(rebuilt)).toEqual(originalProjection);
    rebuilt.close();

    const beforeVacuum = statSync(dbPath).size;
    const vacuum = vacuumEventDatabase({
      actor: ACTOR,
      apply: true,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      enableIncremental: true,
      mode: "full",
      reportPath: join(root, "reports", "vacuum.json")
    });
    expect(vacuum).toMatchObject({ details: { quick_check: "ok" }, dry_run: false });
    expect(statSync(dbPath).size).toBeLessThan(beforeVacuum);

    const restoreCheckpointPath = join(root, "maintenance", "restore-checkpoint.json");
    const pausedRestore = restoreHistoricalIssueLogPayloads({
      actor: ACTOR,
      apply: true,
      batchSize: 4,
      checkpointPath: restoreCheckpointPath,
      compactionCheckpointPath: checkpointPath,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      maxBatches: 1,
      reportPath: join(root, "reports", "restore-paused.json")
    });
    expect(pausedRestore).toMatchObject({ paused: true, checkpoint: { cursor: 4, total: 12 } });

    const restored = restoreHistoricalIssueLogPayloads({
      actor: ACTOR,
      apply: true,
      batchSize: 4,
      checkpointPath: restoreCheckpointPath,
      compactionCheckpointPath: checkpointPath,
      confirmBackupTested: true,
      confirmNoActiveWriters: true,
      dbPath,
      reportPath: join(root, "reports", "restore.json"),
      resume: true
    });
    expect(restored).toMatchObject({
      database: { quick_check: "ok" },
      paused: false,
      checkpoint: { cursor: 12, status: "complete", total: 12 }
    });
    const restoredDB = new Database(dbPath, { readonly: true, strict: true });
    expect(eventRows(restoredDB)).toEqual(originalRows);
    restoredDB.close();
  });
});

function seed(db: RunnerDatabase): number {
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  db.sqlite.run(`insert into issues (project_id, title, status, created_at, updated_at)
    values ('demo', 'Payload compaction', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  const issueID = Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
  const insert = db.sqlite.query(
    "insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)"
  );
  for (let index = 0; index < 12; index += 1) {
    insert.run(issueID, "issue.log", JSON.stringify({
      type: "agent_message_delta",
      raw_method: "item/agentMessage/delta",
      text: `message-${index}`,
      raw_payload: `${String(index).padStart(2, "0")}:${"x".repeat(48_000)}`
    }), `2026-01-01T00:00:${String(index).padStart(2, "0")}Z`);
  }
  return issueID;
}

function eventRows(sqlite: Database): Array<{ id: number; payload: string; type: string }> {
  return sqlite.query<{ id: number; payload: string; type: string }, []>(
    "select id, type, payload from issue_events order by id asc"
  ).all();
}

function payloadBytes(sqlite: Database): number {
  return Number(sqlite.query<{ bytes: number }, []>(
    "select coalesce(sum(length(cast(payload as blob))), 0) as bytes from issue_events"
  ).get()?.bytes ?? 0);
}

function projectionHashes(sqlite: Database): Array<Record<string, unknown>> {
  return sqlite.query<Record<string, unknown>, []>(`
    select source_event_id, source_payload_bytes, source_sha256, summary_sha256
    from event_summary_projection order by source_event_id asc
  `).all();
}
