import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { runCli } from "./command.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun Go DB import command", () => {
  test("imports safe Go tables from a read-only fixture and reports row counts", async () => {
    const root = await tempRoot();
    const sourcePath = join(root, "go", "runner.db");
    const targetPath = join(root, "data-bun", "runner.db");
    await createGoFixtureDatabase(sourcePath);
    const sourceMtimeBefore = (await stat(sourcePath)).mtimeMs;

    const { code, stdout, stderr } = await run([
      "db", "import-go", "--source", sourcePath, "--target", targetPath, "--json"
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const body = JSON.parse(stdout) as ImportResult;
    expect(body.source_readonly).toBe(true);
    expect(body.source_mtime_unchanged).toBe(true);
    expect(body.tables.projects).toEqual({ source: 1, target: 1 });
    expect(body.tables.issue_templates).toEqual({ source: 1, target: 1 });
    expect(body.tables.issues).toEqual({ source: 2, target: 2 });
    expect(body.tables.issue_events).toEqual({ source: 1, target: 1 });
    expect(body.tables.issue_runs).toEqual({ source: 1, target: 1 });
    expect(body.tables.agent_profiles).toEqual({ source: 1, target: 1 });
    expect((await stat(sourcePath)).mtimeMs).toBe(sourceMtimeBefore);
    expect(targetCounts(targetPath, ["projects", "agent_profiles", "issue_templates", "issues", "issue_events", "issue_runs"])).toEqual({
      agent_profiles: 1,
      issue_events: 1,
      issue_runs: 1,
      issue_templates: 1,
      issues: 2,
      projects: 1
    });
  });

  test("rehearses final migration in a backup dir without changing live DBs", async () => {
    const root = await tempRoot();
    const goPath = join(root, "go", "runner.db");
    const bunPath = join(root, "data-bun", "runner.db");
    const backupDir = join(root, "backups", "p08-cutover");
    await createGoFixtureDatabase(goPath);
    await createBunPreviewDatabase(bunPath);
    const goMtimeBefore = (await stat(goPath)).mtimeMs;
    const bunMtimeBefore = (await stat(bunPath)).mtimeMs;

    const { code, stdout, stderr } = await run([
      "db", "rehearse-final-migration", "--go-db", goPath, "--bun-db", bunPath,
      "--backup-dir", backupDir, "--json"
    ]);

    expect(code).toBe(0);
    expect(stderr).toBe("");
    const body = JSON.parse(stdout) as RehearsalResult;
    expect(body.ok).toBe(true);
    expect(body.backup_dir).toBe(backupDir);
    expect(body.backups.go_db).toBe(join(backupDir, "go-runner.db"));
    expect(body.backups.bun_db).toBe(join(backupDir, "bun-runner.db"));
    expect(body.rehearsal.target_db).toBe(join(backupDir, "rehearsal", "runner.db"));
    expect(body.restore_commands.go_db).toContain(body.backups.go_db);
    expect(body.restore_commands.bun_db).toContain(body.backups.bun_db);
    expect(body.reconciliation.all_match).toBe(true);
    expect(body.reconciliation.tables.issues).toMatchObject({
      match: true,
      source_count: 2,
      target_count: 2
    });
    expect(body.reconciliation.tables.issues.source_hash).toBe(body.reconciliation.tables.issues.target_hash);
    expect((await stat(goPath)).mtimeMs).toBe(goMtimeBefore);
    expect((await stat(bunPath)).mtimeMs).toBe(bunMtimeBefore);
    expect(targetCounts(bunPath, ["issues"])).toEqual({ issues: 1 });
    expect(targetCounts(body.rehearsal.target_db, ["issues"])).toEqual({ issues: 2 });
    await stat(body.backups.go_db);
    await stat(body.backups.bun_db);
  });

  test("keeps diagnostics directory and returns non-zero when rehearsal backup fails", async () => {
    const root = await tempRoot();
    const goPath = join(root, "go", "runner.db");
    const missingBunPath = join(root, "data-bun", "missing.db");
    const backupDir = join(root, "backups", "p08-cutover");
    await createGoFixtureDatabase(goPath);

    const { code, stdout, stderr } = await run([
      "db", "rehearse-final-migration", "--go-db", goPath,
      "--bun-db", missingBunPath, "--backup-dir", backupDir, "--json"
    ]);

    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("diagnostics preserved at");
    expect(stderr).toContain(backupDir);
    await stat(backupDir);
  });
});

type ImportResult = {
  source_mtime_unchanged: boolean;
  source_readonly: boolean;
  tables: Record<string, { source: number; target: number }>;
};

type RehearsalResult = {
  backups: { bun_db: string; go_db: string };
  backup_dir: string;
  ok: boolean;
  reconciliation: {
    all_match: boolean;
    tables: Record<string, {
      match: boolean;
      source_count: number;
      source_hash: string;
      target_count: number;
      target_hash: string;
    }>;
  };
  rehearsal: { target_db: string };
  restore_commands: { bun_db: string; go_db: string };
};

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-go-import-"));
  tempRoots.push(root);
  return root;
}

async function run(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(args, stdout, stderr, { env: () => undefined });
  return { code, stdout: stdout.text, stderr: stderr.text };
}

async function createGoFixtureDatabase(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.run(`create table projects (
      id text primary key, name text not null, cwd text not null unique,
      provider text not null default 'codex', provider_config_json text not null default '{}',
      auto_run integer not null default 0, model text not null default '',
      approval_policy text not null default 'never', sandbox text not null default 'workspace-write',
      sort_order integer not null default 0, created_at text not null, updated_at text not null,
      default_agent_profile_id text not null default ''
    )`);
    db.run(`create table issue_templates (
      id text primary key, name text not null, content text not null,
      is_default integer not null default 0, created_at text not null, updated_at text not null
    )`);
    db.run(`create table agent_profiles (
      id text primary key, name text not null, provider text not null default 'codex',
      model text not null default '', reasoning_effort text not null default '',
      approval_policy text not null default '', sandbox text not null default '',
      default_instructions text not null default '', skill_intents_json text not null default '[]',
      plugin_intents_json text not null default '[]', created_at text not null, updated_at text not null
    )`);
    db.run(`create table issues (
      id integer primary key autoincrement, project_id text not null, title text not null,
      description text not null default '', status text not null, priority integer not null default 0,
      template_id text not null default '', prompt_template text not null default '',
      agent_profile_id text not null default '', source_session_id text not null default '',
      source_turn_id text not null default '', source_excerpt text not null default '',
      codex_thread_id text not null default '', codex_turn_id text not null default '',
      attempt_count integer not null default 0, workflow_snapshot_json text not null default '',
      auto_retry_next_at text not null default '', auto_retry_reason text not null default '',
      error text not null default '', created_at text not null, updated_at text not null
    )`);
    db.run(`create table issue_events (
      id integer primary key autoincrement, issue_id integer not null, type text not null,
      payload text not null default '', created_at text not null
    )`);
    db.run(`create table issue_runs (
      id text primary key, issue_id integer not null, attempt integer not null, status text not null,
      provider text not null default 'codex', provider_session_id text not null default '',
      provider_turn_id text not null default '', codex_thread_id text not null default '',
      codex_turn_id text not null default '', started_at text not null, ended_at text not null default '',
      exit_reason text not null default '', error text not null default '',
      agent_profile_id text not null default '', capability_summary text not null default '',
      selection_reason text not null default ''
    )`);
    db.run(`insert into projects (id, name, cwd, default_agent_profile_id, created_at, updated_at)
      values ('demo', 'Demo', '/tmp/demo', 'nightly', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    db.run(`insert into agent_profiles (id, name, created_at, updated_at)
      values ('nightly', 'Nightly', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    db.run(`insert into issue_templates (id, name, content, is_default, created_at, updated_at)
      values ('default', '默认模板', '{{issue.description}}', 1, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    db.run(`insert into issues (project_id, title, description, status, created_at, updated_at)
      values ('demo', 'One', 'first', 'triage', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    db.run(`insert into issues (project_id, title, description, status, created_at, updated_at)
      values ('demo', 'Two', 'second', 'todo', '2026-01-01T00:00:01Z', '2026-01-01T00:00:01Z')`);
    db.run(`insert into issue_events (issue_id, type, payload, created_at)
      values (1, 'issue.comment', '{"body":"ok"}', '2026-01-01T00:00:02Z')`);
    db.run(`insert into issue_runs (id, issue_id, attempt, status, started_at, ended_at)
      values ('run-1', 1, 1, 'done', '2026-01-01T00:00:03Z', '2026-01-01T00:00:04Z')`);
  } finally {
    db.close();
  }
}

async function createBunPreviewDatabase(path: string): Promise<void> {
  const db = await openDatabase({ dbPath: path });
  try {
    db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
      values ('bun-demo', 'Bun Demo', '/tmp/bun-demo', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    db.sqlite.run(`insert into issues (project_id, title, description, status, created_at, updated_at)
      values ('bun-demo', 'Bun Only', 'preview', 'triage', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  } finally {
    db.close();
  }
}

function targetCounts(path: string, tables: string[]): Record<string, number> {
  const db = new Database(path, { readonly: true });
  try {
    return Object.fromEntries(tables.map((table) => [table, countRows(db, table)]));
  } finally {
    db.close();
  }
}

function countRows(db: Database, table: string): number {
  const row = db.query<{ count: number }, []>(`select count(*) as count from ${table}`).get();
  return row?.count ?? 0;
}

class MemoryWriter {
  text = "";

  write(chunk: Uint8Array | string): boolean {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}
