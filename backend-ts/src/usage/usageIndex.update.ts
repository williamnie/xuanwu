import { Database } from "bun:sqlite";
import { rename } from "node:fs/promises";
import { emptyMeta } from "./usageIndex.model.ts";
import type { UsageIndexMetrics, FileDescriptor, FileRow } from "./usageIndex.model.ts";
import { cleanupAbandonedIndexes, removeSQLiteFiles, removeSQLiteSidecars } from "./usageIndex.locking.ts";
import { openWritable, createSchema, fileRows, deleteFileRows, upsertFile, writeMetrics } from "./usageIndex.storage.ts";
import { jsonlFileDescriptors, tailChecksum } from "./usageIndex.filesystem.ts";
import { scanFile } from "./usageIndex.scan.ts";

export async function rebuildIndex(root: string, indexPath: string): Promise<UsageIndexMetrics> {
  await cleanupAbandonedIndexes(indexPath);
  const temp = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
  await removeSQLiteFiles(temp);
  const db = openWritable(temp, false);
  try {
    createSchema(db, root);
    const metrics = await applyFilesystemSnapshot(db, root, true);
    db.run("pragma wal_checkpoint(truncate)");
    db.close();
    await removeSQLiteSidecars(indexPath);
    await rename(temp, indexPath);
    return metrics;
  } catch (error) {
    try { db.run("rollback"); } catch { /* no active transaction */ }
    try { db.close(); } catch { /* already closed */ }
    await removeSQLiteFiles(temp);
    throw error;
  }
}

export async function updateIndex(root: string, indexPath: string): Promise<UsageIndexMetrics> {
  const db = openWritable(indexPath, true);
  try {
    return await applyFilesystemSnapshot(db, root, false);
  } finally {
    db.close();
  }
}

export async function applyFilesystemSnapshot(db: Database, root: string, rebuilt: boolean): Promise<UsageIndexMetrics> {
  const descriptors = await jsonlFileDescriptors(root);
  const previous = fileRows(db);
  const metrics: UsageIndexMetrics = {
    bytes_read: 0,
    corrupt_lines: 0,
    files_incremental: 0,
    files_reused: 0,
    files_scanned: 0,
    files_total: descriptors.length,
    index_hits: 0,
    index_rebuilds: rebuilt ? 1 : 0
  };
  const plans = await Promise.all(descriptors.map(async (descriptor) => ({
    descriptor,
    mode: await updateMode(descriptor, previous.get(descriptor.path))
  })));

  db.run("begin immediate");
  try {
    const livePaths = new Set(descriptors.map((item) => item.path));
    for (const path of previous.keys()) {
      if (!livePaths.has(path)) deleteFileRows(db, path);
    }
    for (const plan of plans) {
      const old = previous.get(plan.descriptor.path);
      if (plan.mode === "reuse" && old) {
        metrics.files_reused += 1;
        metrics.corrupt_lines += old.corruptLines;
        continue;
      }
      if (plan.mode === "scan") {
        deleteFileRows(db, plan.descriptor.path);
        metrics.files_scanned += 1;
      } else {
        metrics.files_incremental += 1;
      }
      const start = plan.mode === "append" ? old?.offset ?? 0 : 0;
      const initialMeta = plan.mode === "append" ? old?.lastMeta ?? emptyMeta() : emptyMeta();
      const initialCorrupt = plan.mode === "append" ? old?.corruptLines ?? 0 : 0;
      const scan = await scanFile(db, plan.descriptor, start, initialMeta, initialCorrupt);
      metrics.bytes_read += scan.bytesRead;
      metrics.corrupt_lines += scan.corruptLines;
      upsertFile(db, plan.descriptor, scan);
    }
    writeMetrics(db, root, metrics);
    db.run("commit");
    return metrics;
  } catch (error) {
    db.run("rollback");
    throw error;
  }
}

export async function updateMode(descriptor: FileDescriptor, old: FileRow | undefined): Promise<"append" | "reuse" | "scan"> {
  if (!old) return "scan";
  if (descriptor.inode !== old.inode) return "scan";
  if (descriptor.size === old.size && descriptor.mtimeMs === old.mtimeMs) return "reuse";
  if (descriptor.size <= old.size || descriptor.mtimeMs < old.mtimeMs) return "scan";
  return await tailChecksum(descriptor.path, old.offset) === old.tailChecksum ? "append" : "scan";
}
