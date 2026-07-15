import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "./command.ts";

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
      create table issues (id integer primary key, project_id text not null);
      create table issue_runs (id text primary key, issue_id integer, attempt integer, status text, started_at text, ended_at text);
      create table issue_events (id integer primary key, issue_id integer, type text, payload text, created_at text);
      insert into projects values ('demo');
      insert into issues values (1, 'demo');
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
});

class MemoryWriter {
  text = "";
  write(chunk: string | Uint8Array): void {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
  }
}
