import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.ts";
import { runCli } from "./command.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("backup CLI", () => {
  test("exports, verifies, and restores an isolated authoritative state with artifact and Golden Journey read smoke", async () => {
    const root = fixtureRoot();
    const source = join(root, "source-state");
    const backup = join(root, "backups", "xuanwu-backup-20260718.snapshot");
    const restored = join(root, "restored-state");
    await seedState(source);

    const exported = await cli([
      "export", "--state-dir", source, "--output", backup,
      ...auditFlags(), "--json"
    ]);
    expect(exported).toMatchObject({ action: "backup.export", files: expect.any(Number), verified: true });
    const manifest = JSON.parse(readFileSync(join(backup, "manifest.json"), "utf8"));
    expect(manifest.database.quick_check).toBe("ok");
    expect(manifest.files.map((entry: { path: string }) => entry.path)).toEqual(expect.arrayContaining([
      "database/runner.db", "state/artifacts/evidence.txt", "state/uploads/report.txt", "state/config/runner-settings.json", "state/config/secret-ref.json"
    ]));
    expect(manifest.secret_refs).toEqual(expect.arrayContaining([expect.objectContaining({ path: "state/auth_token" })]));
    expect(existsSync(join(backup, "state", "auth_token"))).toBe(false);

    expect(await cli(["verify", "--input", backup, "--json"])).toMatchObject({ action: "backup.verify", verified: true });
    expect(await cli([
      "import", "--input", backup, "--target-state-dir", restored, "--apply", ...auditFlags(), "--json"
    ])).toMatchObject({ action: "backup.import", restored_state_dir: restored, verified: true });

    // Isolated Golden Journey read smoke: the restored authoritative issue/project state remains readable.
    const database = await openDatabase({ readonlyImportPath: join(restored, "runner.db") });
    try {
      expect(database.sqlite.query<{ id: string }, []>("select id from projects where id='golden'").get()?.id).toBe("golden");
      expect(database.sqlite.query<{ title: string }, []>("select title from issues where project_id='golden'").get()?.title).toBe("Golden Journey restored read");
    } finally {
      database.close();
    }
    expect(readFileSync(join(restored, "artifacts", "evidence.txt"), "utf8")).toBe("authoritative artifact\n");
    expect(readFileSync(join(restored, "config", "secret-ref.json"), "utf8")).toContain("secret-store://runner");
    expect(existsSync(join(restored, "auth_token"))).toBe(false);
    expect(JSON.parse(readFileSync(join(restored, "restore-audit.json"), "utf8"))).toMatchObject({ action: "backup.import", snapshot_id: manifest.snapshot_id });
  });

  test("encrypts a snapshot, requires the passphrase for verification, and records retention before deleting old backups", async () => {
    const root = fixtureRoot();
    const source = join(root, "source-state");
    const backups = join(root, "backups");
    await seedState(source);
    const passphrase = join(root, "backup.passphrase");
    writeFileSync(passphrase, "correct horse battery staple\n", { mode: 0o600 });
    const old = join(backups, "xuanwu-backup-20260717.snapshot");
    await cli(["export", "--state-dir", source, "--output", old, ...auditFlags(), "--json"]);
    const encrypted = join(backups, "xuanwu-backup-20260718.encrypted");
    const exported = await cli([
      "export", "--state-dir", source, "--output", encrypted, "--encrypt", "--passphrase-file", passphrase,
      "--retain", "1", ...auditFlags(), "--json"
    ]);
    expect(exported).toMatchObject({ encryption: { enabled: true }, retention: { deleted: [old], retain: 1 } });
    expect(existsSync(old)).toBe(false);
    expect(await cli(["verify", "--input", encrypted, "--passphrase-file", passphrase, "--json"])).toMatchObject({ verified: true });
    const failed = await rawCli(["backup", "verify", "--input", encrypted, "--json"]);
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain("--passphrase-file is required");
  });
});

function fixtureRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "xuanwu-backup-cli-"));
  roots.push(root);
  return root;
}

async function seedState(stateDir: string): Promise<void> {
  const database = await openDatabase({ stateDir });
  database.sqlite.run(`
    insert into projects (id, name, cwd, created_at, updated_at)
      values ('golden', 'Golden', '/tmp/golden', '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z');
    insert into issues (project_id, title, status, created_at, updated_at)
      values ('golden', 'Golden Journey restored read', 'done', '2026-07-18T00:00:00Z', '2026-07-18T00:00:00Z');
  `);
  database.close();
  await mkdir(join(stateDir, "artifacts"), { recursive: true });
  await mkdir(join(stateDir, "uploads"), { recursive: true });
  await mkdir(join(stateDir, "config"), { recursive: true });
  writeFileSync(join(stateDir, "artifacts", "evidence.txt"), "authoritative artifact\n");
  writeFileSync(join(stateDir, "uploads", "report.txt"), "uploaded report\n");
  writeFileSync(join(stateDir, "config", "runner-settings.json"), '{"mode":"safe"}\n');
  writeFileSync(join(stateDir, "config", "secret-ref.json"), '{"provider":"secret-store://runner"}\n');
  writeFileSync(join(stateDir, "auth_token"), "secret-not-exported\n", { mode: 0o600 });
}

function auditFlags(): string[] {
  return ["--actor", "operator", "--actor-kind", "user", "--audit-ref", "backup-test", "--reason", "restore rehearsal"];
}

async function cli(args: string[]): Promise<Record<string, unknown>> {
  const result = await rawCli(["backup", ...args]);
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  return JSON.parse(result.stdout);
}

async function rawCli(args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
  const stdout = new MemoryWriter();
  const stderr = new MemoryWriter();
  const code = await runCli(args, stdout, stderr);
  return { code, stderr: stderr.text, stdout: stdout.text };
}

class MemoryWriter {
  text = "";
  write(chunk: Uint8Array | string): boolean {
    this.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }
}
