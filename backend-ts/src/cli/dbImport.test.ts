import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    expect(body.tables.agent_profiles).toEqual({ source: 1, target: 1 });
    expect((await stat(sourcePath)).mtimeMs).toBe(sourceMtimeBefore);
    expect(targetCounts(targetPath, ["projects", "agent_profiles", "issue_templates", "issues"])).toEqual({
      agent_profiles: 1,
      issue_templates: 1,
      issues: 2,
      projects: 1
    });
  });
});

type ImportResult = {
  source_mtime_unchanged: boolean;
  source_readonly: boolean;
  tables: Record<string, { source: number; target: number }>;
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
