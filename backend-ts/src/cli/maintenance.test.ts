import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./command.ts";
import { openDatabase } from "../db/database.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("maintenance CLI", () => {
  test("runs the event report against a database copy without changing rows", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-cli-"));
    roots.push(root);
    const dbPath = join(root, "runner-copy.db");
    const sqlite = new Database(dbPath, { create: true });
    sqlite.run(`
      create table projects (id text primary key);
      create table issues (id integer primary key, project_id text not null, status text not null);
      create table issue_runs (id text primary key, issue_id integer, attempt integer, status text, started_at text, ended_at text);
      create table issue_events (id integer primary key, issue_id integer, type text, payload text, created_at text);
      insert into projects values ('demo');
      insert into issues values (1, 'demo', 'done');
      insert into issue_events values (1, 1, 'issue.status_changed', '{}', '2025-01-01T00:00:00Z');
    `);
    sqlite.close();
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();

    const code = await runCli([
      "maintenance", "events", "report", "--db", dbPath,
      "--now", "2026-07-16T00:00:00Z", "--json"
    ], stdout, stderr);

    expect(code).toBe(0);
    expect(stderr.text).toBe("");
    expect(JSON.parse(stdout.text)).toMatchObject({
      operation: "report",
      dry_run: true,
      scanned: { rows: 1 },
      source_of_truth: "issue_events"
    });
    const check = new Database(dbPath, { readonly: true });
    expect(check.query<{ count: number }, []>("select count(*) as count from issue_events").get()?.count).toBe(1);
    check.close();
  });

  test("rejects ignored maintenance flags", async () => {
    const stdout = new MemoryWriter();
    const stderr = new MemoryWriter();
    const code = await runCli([
      "maintenance", "events", "report", "--db", "/tmp/missing.db", "--apply"
    ], stdout, stderr);
    expect(code).toBe(1);
    expect(stderr.text).toContain("Unknown argument: --apply");
  });

  test("rebuilds and resumes the audited event summary projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-projection-cli-"));
    roots.push(root);
    const dbPath = join(root, "runner-copy.db");
    const database = await openDatabase({ dbPath, stateDir: root });
    database.sqlite.run(`
      insert into projects (id, name, cwd, created_at, updated_at)
        values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      insert into issues (project_id, title, status, created_at, updated_at)
        values ('demo', 'Projection', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      insert into issue_events (issue_id, type, payload, created_at) values
        (1, 'issue.created', '{}', '2026-01-01T00:00:00Z'),
        (1, 'issue.log', '{"raw_method":"item/agentMessage/delta","text":"a"}', '2026-01-01T00:00:01Z'),
        (1, 'issue.status_changed', '{"status":"done"}', '2026-01-01T00:00:02Z');
    `);
    database.close();

    const first = await cli(["--batch-size", "2", "--max-batches", "1"], dbPath);
    const resumed = await cli(["--batch-size", "2", "--resume"], dbPath);

    expect(first).toMatchObject({ paused: true, projected_rows: 2, watermark: { last_event_id: 2 } });
    expect(resumed).toMatchObject({ paused: false, projected_rows: 1, watermark: { last_event_id: 3 } });
    const check = new Database(dbPath, { readonly: true });
    expect(check.query<{ count: number }, []>(
      "select count(*) as count from event_summary_projection"
    ).get()?.count).toBe(3);
    expect(check.query<{ count: number }, []>(`
      select count(*) as count from pi_action_events
      where event_type like 'event_summary_projection.rebuild_%'
    `).get()?.count).toBe(4);
    check.close();
  });

  test("rebuilds, observes, atomically cuts over, and rolls back the compact projection", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-compact-projection-cli-"));
    roots.push(root);
    const dbPath = join(root, "runner-copy.db");
    const database = await openDatabase({ dbPath, stateDir: root });
    database.sqlite.run(`
      insert into projects (id, name, cwd, created_at, updated_at)
        values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      insert into issues (project_id, title, status, created_at, updated_at)
        values ('demo', 'Compact projection', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      insert into issue_events (issue_id, type, payload, created_at) values
        (1, 'issue.created', '{"title":"Compact projection"}', '2026-01-01T00:00:00Z'),
        (1, 'issue.log', '{"raw_method":"item/agentMessage/delta","text":"repeat repeat repeat repeat"}', '2026-01-01T00:00:01Z'),
        (1, 'issue.status_changed', '{"status":"done"}', '2026-01-01T00:00:02Z');
    `);
    database.close();

    await cli([], dbPath);
    const rebuilt = await maintenanceCli([
      "events", "rebuild-compact-projection", "--db", dbPath,
      ...compactAuthorization(), "--json"
    ]);
    expect(rebuilt).toMatchObject({ paused: false, projected_rows: 3, after: { lag_rows: 0 } });

    const verified = await maintenanceCli([
      "events", "verify-compact-projection", "--db", dbPath,
      "--performance-samples", "3", "--json"
    ]);
    expect(verified).toMatchObject({ blockers: [], cutover_ready: true, parity: { mismatches: 0 } });

    const observed = await maintenanceCli([
      "events", "observe-compact-projection", "--db", dbPath,
      ...compactAuthorization(), ...compactApplyConfirmations(), "--duration-seconds", "3600", "--json"
    ]);
    expect(observed).toMatchObject({ applied: true, after: { read_version: "v1", revision: 1 } });

    const cutover = await maintenanceCli([
      "events", "cutover-compact-projection", "--db", dbPath,
      ...compactAuthorization(), ...compactApplyConfirmations(), "--minimum-observation-seconds", "0", "--json"
    ]);
    expect(cutover).toMatchObject({ applied: true, blockers: [], after: { read_version: "v2", revision: 2 } });

    const blockedStdout = new MemoryWriter();
    const blockedStderr = new MemoryWriter();
    const blockedRebuild = await runCli([
      "maintenance", "events", "rebuild-compact-projection", "--db", dbPath,
      ...compactAuthorization(), "--json"
    ], blockedStdout, blockedStderr);
    expect(blockedRebuild).toBe(1);
    expect(blockedStderr.text).toContain("blocked while V2 is the active read version");

    const rollback = await maintenanceCli([
      "events", "rollback-compact-projection", "--db", dbPath,
      ...compactAuthorization(), ...compactApplyConfirmations(), "--json"
    ]);
    expect(rollback).toMatchObject({ applied: true, blockers: [], after: { read_version: "v1", revision: 3 } });
    const check = new Database(dbPath, { readonly: true });
    expect(check.query<{ count: number }, []>("select count(*) as count from event_summary_projection").get()?.count).toBe(3);
    expect(check.query<{ count: number }, []>("select count(*) as count from event_summary_projection_compact").get()?.count).toBe(3);
    check.close();
  });

  test("plans historical issue.log payload compaction without mutating the database", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-payload-compaction-cli-"));
    roots.push(root);
    const dbPath = join(root, "runner-copy.db");
    const database = await openDatabase({ dbPath, stateDir: root });
    database.sqlite.run(`
      insert into projects (id, name, cwd, created_at, updated_at)
        values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      insert into issues (project_id, title, status, created_at, updated_at)
        values ('demo', 'Compact payloads', 'done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    database.sqlite.run(
      "insert into issue_events (issue_id, type, payload, created_at) values (1, 'issue.log', ?, '2026-01-01T00:00:01Z')",
      [JSON.stringify({ raw_method: "item/agentMessage/delta", raw_payload: "x".repeat(48_000) })]
    );
    database.close();
    const checkpointPath = join(root, "maintenance", "compact-checkpoint.json");

    const report = await maintenanceCli([
      "events", "compact-payloads", "--db", dbPath,
      "--checkpoint", checkpointPath,
      "--report", join(root, "reports", "compact.json"), "--json"
    ]);

    expect(report).toMatchObject({
      operation: "compact_issue_log_payloads",
      dry_run: true,
      minimum_savings_bytes: 4096,
      plan: { candidate_rows: 1 }
    });
    expect(existsSync(checkpointPath)).toBe(false);
    const check = new Database(dbPath, { readonly: true });
    expect(check.query<{ payload: string }, []>("select payload from issue_events").get()?.payload)
      .not.toContain("issue_log_artifact");
    check.close();
  });

  test("runs dry-run and applied Work backfill through the migration CLI", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-work-cli-"));
    roots.push(root);
    const dbPath = join(root, "runner-copy.db");
    const checkpointPath = join(root, "work-checkpoint.json");
    const reportPath = join(root, "work-report.json");
    const database = await openDatabase({ dbPath, stateDir: root });
    database.sqlite.run(`
      insert into projects (id, name, cwd, created_at, updated_at)
        values ('demo', 'Demo', '/tmp/demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
      insert into issues (project_id, title, description, status, created_at, updated_at)
        values ('demo', 'Backfill', 'Backfill goal', 'todo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    database.close();

    const dryRun = await maintenanceCli([
      "work", "backfill", "--db", dbPath, "--checkpoint", checkpointPath,
      "--report", reportPath, "--json"
    ]);
    expect(dryRun).toMatchObject({ dry_run: true, parity_passed: false });
    expect(existsSync(checkpointPath)).toBe(false);

    const applied = await maintenanceCli([
      "work", "backfill", "--db", dbPath, "--checkpoint", checkpointPath,
      "--report", reportPath, "--actor", "operator", "--actor-kind", "user",
      "--audit-ref", "pi_action_events:work-cli-test", "--reason", "CLI backfill test",
      "--apply", "--confirm-backup-tested", "--confirm-no-active-writers", "--json"
    ]);
    expect(applied).toMatchObject({ dry_run: false, parity_passed: true, created_rows: 1 });
    expect(existsSync(checkpointPath)).toBe(true);

    const rollback = await maintenanceCli([
      "work", "rollback", "--db", dbPath, "--backfill-checkpoint", checkpointPath,
      "--checkpoint", join(root, "rollback-checkpoint.json"),
      "--report", join(root, "rollback-report.json"), "--json"
    ]);
    expect(rollback).toMatchObject({ blockers: [], dry_run: true, checkpoint: { total: 1 } });
  });

  test("audits PI Action, Proposal, Approval, and Attention consolidation without authorizing deletion", async () => {
    const root = mkdtempSync(join(tmpdir(), "maintenance-attention-cli-"));
    roots.push(root);
    const dbPath = join(root, "runner-copy.db");
    const reportPath = join(root, "attention-audit.json");
    const database = await openDatabase({ dbPath, stateDir: root });
    database.close();

    const report = await maintenanceCli([
      "attention", "audit", "--db", dbPath, "--report", reportPath, "--json"
    ]);
    expect(report).toMatchObject({
      contract: "xw.pi-decision-consolidation.v1",
      data_gate_passed: true,
      delete_gate: { destructive_delete_authorized: false },
      operation: "attention.consolidation-audit"
    });
    expect(existsSync(reportPath)).toBe(true);
  });
});

async function cli(extra: string[], dbPath: string): Promise<Record<string, unknown>> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli([
    "maintenance", "events", "rebuild-projection", "--db", dbPath,
    "--actor", "operator", "--actor-kind", "user", "--audit-ref", "pi_action_events:test-rebuild",
    "--reason", "projection test", ...extra, "--json"
  ], stdout, stderr);
  expect(code).toBe(0);
  expect(stderr.text).toBe("");
  return JSON.parse(stdout.text);
}

async function maintenanceCli(args: string[]): Promise<Record<string, unknown>> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(["maintenance", ...args], stdout, stderr);
  expect(code).toBe(0);
  expect(stderr.text).toBe("");
  return JSON.parse(stdout.text);
}

function compactAuthorization(): string[] {
  return [
    "--actor", "operator", "--actor-kind", "user",
    "--audit-ref", "pi_action_events:compact-projection-test",
    "--reason", "compact projection rehearsal"
  ];
}

function compactApplyConfirmations(): string[] {
  return ["--apply", "--confirm-backup-tested", "--confirm-no-active-writers"];
}

class MemoryWriter {
  text = "";
  write(chunk: string | Uint8Array): void {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }
}
