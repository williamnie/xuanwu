import { randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, mkdtemp, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { VOLATILE_PATH, SNAPSHOT_SCHEMA } from "./service.model.ts";
import type { BackupExportInput, SnapshotEntry, SecretRef, Manifest, BackupVerifyInput, BackupImportInput } from "./service.model.ts";
import { authorize, resolveRequired, exists, samePath, isSecretMaterialPath } from "./service.validation.ts";
import { retentionPlan, snapshotDatabase, entryFor, walkStateFiles, applyRetention, restorePath } from "./service.filesystem.ts";
import { writeEncryptedBundle, readAndVerifyBundle } from "./service.bundle.ts";

export async function exportBackup(input: BackupExportInput): Promise<Record<string, unknown>> {
  const authorization = authorize(input);
  const stateDir = resolveRequired(input.stateDir, "--state-dir");
  const dbPath = resolveRequired(input.dbPath, "--db");
  const outputPath = resolveRequired(input.outputPath, "--output");
  if (input.encrypt && !input.passphrase) throw new Error("--passphrase-file is required with --encrypt");
  if (await exists(outputPath)) throw new Error(`backup output already exists: ${outputPath}`);
  if (!(await stat(stateDir)).isDirectory()) throw new Error(`state directory does not exist: ${stateDir}`);
  if (!(await stat(dbPath)).isFile()) throw new Error(`database does not exist: ${dbPath}`);

  const parent = dirname(outputPath);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const retentionDeleted = await retentionPlan(parent, input.retain, outputPath);
  const staging = await mkdtemp(join(parent, ".xuanwu-backup-staging-"));
  try {
    const files: SnapshotEntry[] = [];
    const dbTarget = join(staging, "database", "runner.db");
    await mkdir(dirname(dbTarget), { recursive: true, mode: 0o700 });
    const database = snapshotDatabase(dbPath, dbTarget);
    files.push(await entryFor(staging, "database/runner.db"));

    const secretRefs: SecretRef[] = [];
    for await (const candidate of walkStateFiles(stateDir)) {
      const stateRelative = relative(stateDir, candidate).replaceAll(sep, "/");
      if (samePath(candidate, dbPath) || samePath(candidate, `${dbPath}-wal`) || samePath(candidate, `${dbPath}-shm`)) continue;
      if (VOLATILE_PATH.test(stateRelative)) continue;
      if (isSecretMaterialPath(stateRelative)) {
        secretRefs.push({
          path: `state/${stateRelative}`,
          restore: "Excluded from every backup. Resolve this secret reference from the protected environment or secret store after restore."
        });
        continue;
      }
      const target = join(staging, "state", stateRelative);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(candidate, target);
      await chmod(target, 0o600);
      files.push(await entryFor(staging, `state/${stateRelative}`));
    }

    const now = new Date().toISOString();
    const manifest: Manifest = {
      audit: { ...authorization, action: "backup.export", retention_deleted: retentionDeleted },
      created_at: now,
      database,
      encryption: { enabled: Boolean(input.encrypt), format: input.encrypt ? "aes-256-gcm+scrypt" : "none" },
      files,
      schema_version: SNAPSHOT_SCHEMA,
      secret_refs: secretRefs.sort((left, right) => left.path.localeCompare(right.path)),
      snapshot_id: `backup:${randomUUID()}`,
      source_of_truth: "runner.db is authoritative; copied state files are configuration and artifact companions"
    };
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });

    if (input.encrypt) {
      await writeEncryptedBundle(staging, outputPath, manifest, input.passphrase!);
      await rm(staging, { recursive: true, force: true });
    } else {
      await rename(staging, outputPath);
      await chmod(outputPath, 0o700);
    }

    await applyRetention(retentionDeleted);
    return {
      action: "backup.export",
      audit: authorization,
      database,
      encryption: manifest.encryption,
      files: files.length,
      output: outputPath,
      retention: { deleted: retentionDeleted, retain: input.retain ?? null },
      secret_refs: manifest.secret_refs,
      snapshot_id: manifest.snapshot_id,
      verified: true
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyBackup(input: BackupVerifyInput): Promise<Record<string, unknown>> {
  const bundle = await readAndVerifyBundle(resolveRequired(input.inputPath, "--input"), input.passphrase);
  return {
    action: "backup.verify",
    database: bundle.manifest.database,
    encryption: bundle.manifest.encryption,
    files: bundle.manifest.files.length,
    snapshot_id: bundle.manifest.snapshot_id,
    verified: true
  };
}

export async function importBackup(input: BackupImportInput): Promise<Record<string, unknown>> {
  const authorization = authorize(input);
  if (!input.apply) throw new Error("--apply is required for backup import");
  const target = resolveRequired(input.targetStateDir, "--target-state-dir");
  if (await exists(target)) {
    const targetStats = await stat(target);
    if (!targetStats.isDirectory() || (await readdir(target)).length > 0) {
      throw new Error("backup import target must not exist or must be an empty directory");
    }
    await rm(target, { recursive: true, force: true });
  }
  const bundle = await readAndVerifyBundle(resolveRequired(input.inputPath, "--input"), input.passphrase);
  const temporary = `${target}.restore-${randomUUID()}.partial`;
  try {
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    for (const entry of bundle.manifest.files) {
      const destination = restorePath(temporary, entry.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, bundle.files.get(entry.path)!, { mode: 0o600 });
    }
    const restoreAudit = {
      action: "backup.import",
      actor: authorization.actor,
      actor_kind: authorization.actorKind,
      audit_ref: authorization.auditRef,
      imported_at: new Date().toISOString(),
      reason: authorization.reason,
      snapshot_id: bundle.manifest.snapshot_id,
      verification: { quick_check: bundle.manifest.database.quick_check, status: "passed_before_restore" }
    };
    await writeFile(join(temporary, "restore-audit.json"), `${JSON.stringify(restoreAudit, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
    return {
      action: "backup.import",
      audit: authorization,
      restored_state_dir: target,
      secret_refs_required: bundle.manifest.secret_refs,
      snapshot_id: bundle.manifest.snapshot_id,
      verified: true
    };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
