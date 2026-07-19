import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../backend-ts/src/db/database.ts";

const SCRIPT = join(import.meta.dir, "audit-automation-consolidation.mjs");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { force: true, recursive: true });
});

describe("Automation consolidation audit", () => {
  test("creates a read-only archive candidate but keeps destructive gates closed", async () => {
    const fixture = await createFixture();
    const before = digest(readFileSync(fixture.dbPath));
    const result = await run(["--db", fixture.dbPath, "--report", fixture.reportPath]);
    const report = JSON.parse(result.stdout);

    expect(result.exitCode).toBe(0);
    expect(report).toMatchObject({
      contract: "xw.automation-consolidation-audit.v1",
      data_gate: { blockers: [], passed: true },
      delete_gate: {
        blockers: expect.arrayContaining([
          expect.stringContaining("formal release"),
          expect.stringContaining("non-LLM G7")
        ]),
        destructive_delete_authorized: false
      },
      nightly_archive_candidate: {
        archive_only: true,
        checksum_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        payload: {
          batches: [expect.objectContaining({ id: 1, status: "done" })],
          items: [expect.objectContaining({ batch_id: 1, issue_id: 739, status: "done" })]
        },
        restore_rehearsal_completed: false
      },
      parity_gate: { blockers: [], passed: true },
      row_checks: {
        claimed_cron_tasks: 0,
        nonterminal_cron_tasks: 0,
        nonterminal_nightly_batches: 0,
        nonterminal_nightly_items: 0
      }
    });
    expect(JSON.parse(readFileSync(fixture.reportPath, "utf8"))).toEqual(report);
    expect(digest(readFileSync(fixture.dbPath))).toBe(before);
  });

  test("reports live scheduler and archive blockers without changing the database", async () => {
    const fixture = await createFixture();
    const sqlite = await openDatabase({ dbPath: fixture.dbPath, stateDir: fixture.root });
    sqlite.sqlite.run(`insert into cron_tasks
      (name, project_id, action, mode, time_of_day, next_run_at, status, created_at, updated_at, claim_token)
      values ('active cron', 'codex-issue-runner', 'run', 'auto', '', '2026-07-19T00:00:00Z',
        'active', '2026-07-19T00:00:00Z', '2026-07-19T00:00:00Z', 'claim-1')`);
    sqlite.sqlite.run("update nightly_batch_items set status='current' where batch_id=1 and issue_id=739");
    sqlite.close();
    const before = digest(readFileSync(fixture.dbPath));

    const result = await run(["--db", fixture.dbPath, "--report", fixture.reportPath]);
    const report = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(report.data_gate.passed).toBe(false);
    expect(report.data_gate.blockers).toEqual(expect.arrayContaining([
      "claimed_cron_tasks=1",
      "nonterminal_cron_tasks=1",
      "nonterminal_nightly_items=1"
    ]));
    expect(report.delete_gate.destructive_delete_authorized).toBe(false);
    expect(digest(readFileSync(fixture.dbPath))).toBe(before);
  });
});

async function createFixture() {
  const root = mkdtempSync(join(tmpdir(), "automation-consolidation-audit-"));
  roots.push(root);
  const dbPath = join(root, "runner.db");
  const reportPath = join(root, "reports", "automation-audit.json");
  const db = await openDatabase({ dbPath, stateDir: root });
  db.sqlite.run(`create table nightly_batches (
    id integer primary key autoincrement, project_id text not null, policy text not null,
    promotion_mode text not null, status text not null, current_issue_id integer not null default 0,
    pause_reason text not null default '', created_at text not null, updated_at text not null
  )`);
  db.sqlite.run(`create table nightly_batch_items (
    batch_id integer not null, issue_id integer not null, position integer not null,
    status text not null, updated_at text not null, primary key(batch_id, issue_id)
  )`);
  db.sqlite.run(`insert into nightly_batches
    (id, project_id, policy, promotion_mode, status, created_at, updated_at)
    values (1, 'codex-issue-runner', 'fail_stop', 'auto', 'done',
      '2026-07-19T00:00:00Z', '2026-07-19T01:00:00Z')`);
  db.sqlite.run(`insert into nightly_batch_items
    (batch_id, issue_id, position, status, updated_at)
    values (1, 739, 1, 'done', '2026-07-19T01:00:00Z')`);
  db.close();
  return { dbPath, reportPath, root };
}

async function run(args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn([process.execPath, SCRIPT, ...args], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text()
  ]);
  return { exitCode, stderr, stdout };
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
