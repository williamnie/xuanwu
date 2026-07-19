import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase } from "../backend-ts/src/db/database.ts";
import { createPiAutomation } from "../backend-ts/src/db/repositories/piAutomations.ts";

const roots: string[] = [];
const SCRIPT = resolve(import.meta.dir, "migrate-automation-shadow.mjs");
const LEGACY_WATCH_SCRIPT = resolve(import.meta.dir, "migrate-watch-automations.mjs");

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("migrate-automation-shadow", () => {
  test("only applies to a verified copy and is zero-drift on the second run", async () => {
    const root = await mkdtemp(join(tmpdir(), "automation-shadow-cli-"));
    roots.push(root);
    const source = join(root, "source.db");
    const copy = join(root, "copy.db");
    const db = await openDatabase({ dbPath: source });
    createPiAutomation(db, {
      name: "CLI fixture",
      steps: [{ type: "domain_skill", skill_id: "pi-domain-proposal", idempotency_key: "cli-fixture" }],
      trigger: { type: "manual" }
    }, new Date("2026-07-19T05:00:00Z"));
    db.close();
    await copyFile(source, copy);

    const preview = await run(["--db", source]);
    expect(preview.exitCode).toBe(0);
    expect(JSON.parse(preview.stdout)).toMatchObject({
      mode: "dry_run",
      backfill: { pi_automations: { created: 1, scanned: 1 } },
      safety: { live_write: false }
    });

    const args = [
      "--db", copy,
      "--apply-to-copy",
      "--source-db", source,
      "--actor", "migration-operator",
      "--correlation", "issue-752-copy-rehearsal",
      "--reason", "isolated W1 parity rehearsal"
    ];
    const first = await run(args);
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      mode: "apply_to_copy",
      backfill: { pi_automations: { created: 1, drift: [], refreshed: 0, unchanged: 0 } },
      after: { counts: { automation_definitions: 1, pi_automations: 1 } }
    });
    const second = await run(args);
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      backfill: { pi_automations: { created: 0, drift: [], refreshed: 0, unchanged: 1 } }
    });

    expect(count(source, "automation_definitions")).toBe(0);
    expect(count(source, "pi_automations")).toBe(1);
    expect(count(copy, "automation_definitions")).toBe(1);

    const denied = await run([
      "--db", source,
      "--apply-to-copy",
      "--source-db", source,
      "--actor", "migration-operator",
      "--correlation", "same-path",
      "--reason", "must fail"
    ]);
    expect(denied.exitCode).toBe(2);
    expect(denied.stderr).toContain("source DB and apply target must be different files");

    const legacyApply = await runWithScript(LEGACY_WATCH_SCRIPT, [
      "--db", source, "--apply", "--actor", "migration-operator", "--correlation", "legacy-direct"
    ]);
    expect(legacyApply.exitCode).toBe(2);
    expect(legacyApply.stderr).toContain("direct --apply is disabled in W1");
  });
});

async function run(args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  return runWithScript(SCRIPT, args);
}

async function runWithScript(script: string, args: string[]): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn([process.execPath, script, ...args], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stderr, stdout] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
    new Response(child.stdout).text()
  ]);
  return { exitCode, stderr, stdout };
}

function count(path: string, table: string): number {
  const sqlite = new Database(path, { readonly: true });
  try { return Number(sqlite.query(`select count(*) as count from ${table}`).get()?.count ?? 0); }
  finally { sqlite.close(); }
}
