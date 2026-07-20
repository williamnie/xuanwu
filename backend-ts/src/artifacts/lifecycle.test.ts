import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreArtifactLifecycle, runArtifactLifecycle } from "./lifecycle.ts";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("artifact lifecycle", () => {
  test("inventories owner, runtime reference, hash, and bounded retention without mutating on report", async () => {
    const fixture = await createFixture();
    const report = await runArtifactLifecycle({
      archiveRoot: fixture.archive,
      minimumFreeBytes: 0,
      reportPath: join(fixture.root, "report.json"),
      root: fixture.live
    });

    expect(report).toMatchObject({
      contract: "xw.artifact-lifecycle.v1",
      dry_run: true,
      summary: { archive_files: 5 }
    });
    expect(report.inventory.find((entry) => entry.path === "state/runner.db")).toMatchObject({
      active_runtime_reference: true,
      authority: "authority",
      disposition: "keep",
      hash_status: "active_mutable"
    });
    expect(report.inventory.find((entry) => entry.path === "state/auth_token")).toMatchObject({
      authority: "secret",
      hash_status: "redacted",
      sha256: null
    });
    expect(report.inventory.find((entry) => entry.path.endsWith("rehearsal.db"))).toMatchObject({
      disposition: "archive",
      kind: "migration_snapshot",
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(existsSync(join(fixture.live, "migration-artifacts", "run-1", "rehearsal.db"))).toBe(true);
  });

  test("applies through verified content-addressed objects and restores from the immutable manifest", async () => {
    const fixture = await createFixture();
    const reportPath = join(fixture.root, "apply.json");
    const applied = await runArtifactLifecycle({
      actor: { actor: "operator", auditRef: "issue:769", reason: "bounded artifact retention" },
      apply: true,
      archiveRoot: fixture.archive,
      confirmConsumerZero: true,
      confirmRestoreTested: true,
      minimumFreeBytes: 0,
      reportPath,
      root: fixture.live
    });

    expect(applied.application_support.target_status).toBe("passed");
    expect(applied.moved).toHaveLength(5);
    expect(existsSync(join(fixture.live, "migration-artifacts", "run-1", "rehearsal.db"))).toBe(false);
    expect(existsSync(join(fixture.live, "migration-artifacts", "run-1", "report.json"))).toBe(true);
    expect(existsSync(join(fixture.live, "backups", "backup-new", "runner.db"))).toBe(true);
    expect(existsSync(join(fixture.live, "backups", "backup-old", "runner.db"))).toBe(false);
    for (const entry of applied.moved) expect(existsSync(join(fixture.archive, entry.object_path))).toBe(true);

    const manifestPath = join(fixture.archive, "manifests", `${applied.manifest_id}.json`);
    const restoreReport = await restoreArtifactLifecycle({
      actor: "operator",
      apply: true,
      auditRef: "issue:769:restore",
      manifestPath,
      reason: "isolated restore smoke",
      reportPath: join(fixture.root, "restore.json"),
      root: join(fixture.root, "restored")
    });
    expect(restoreReport).toMatchObject({ action: "artifact-lifecycle.restore", dry_run: false });
    expect(readFileSync(join(fixture.root, "restored", "migration-artifacts", "run-1", "rehearsal.db"), "utf8")).toBe("migration-db");
  });

  test("fails closed without consumer-zero and restore confirmations", async () => {
    const fixture = await createFixture();
    await expect(runArtifactLifecycle({
      actor: { actor: "operator", auditRef: "issue:769", reason: "retention" },
      apply: true,
      archiveRoot: fixture.archive,
      minimumFreeBytes: 0,
      reportPath: join(fixture.root, "apply.json"),
      root: fixture.live
    })).rejects.toThrow("--confirm-consumer-zero is required");
  });
});

async function createFixture(): Promise<{ archive: string; live: string; root: string }> {
  const root = mkdtempSync(join(tmpdir(), "artifact-lifecycle-"));
  roots.push(root);
  const live = join(root, "live");
  const archive = join(root, "archive");
  for (const directory of [
    "state", "bin", "backups/backup-old", "backups/backup-new",
    "evidence/issue-1", "migration-artifacts/run-1", "logs"
  ]) await mkdir(join(live, directory), { recursive: true });
  await mkdir(archive, { recursive: true });
  writeFileSync(join(live, "state", "runner.db"), "live-db");
  writeFileSync(join(live, "state", "runner.db.old.bak"), "old-state-backup");
  writeFileSync(join(live, "state", "auth_token"), "secret");
  writeFileSync(join(live, "bin", "codex-issue-runner"), "active-binary");
  writeFileSync(join(live, "bin", "codex-issue-runner.build.stamp"), "stamp");
  writeFileSync(join(live, "bin", "codex-issue-runner.backup-old"), "old-binary");
  writeFileSync(join(live, "backups", "backup-old", "runner.db"), "old-backup");
  writeFileSync(join(live, "backups", "backup-new", "runner.db"), "new-backup");
  writeFileSync(join(live, "evidence", "issue-1", "snapshot.db"), "evidence-db");
  writeFileSync(join(live, "evidence", "issue-1", "manifest.json"), "{}");
  writeFileSync(join(live, "migration-artifacts", "run-1", "rehearsal.db"), "migration-db");
  writeFileSync(join(live, "migration-artifacts", "run-1", "report.json"), "{}");
  writeFileSync(join(live, "logs", "launchd.out.log"), "active-log");
  const old = new Date("2026-01-01T00:00:00Z");
  const fresh = new Date("2026-07-20T00:00:00Z");
  await utimes(join(live, "backups", "backup-old", "runner.db"), old, old);
  await utimes(join(live, "backups", "backup-new", "runner.db"), fresh, fresh);
  return { archive, live, root };
}
