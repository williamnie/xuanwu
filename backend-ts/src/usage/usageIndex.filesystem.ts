import { createHash } from "node:crypto";
import { open, readdir, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { TAIL_BYTES } from "./usageIndex.model.ts";
import type { FileDescriptor } from "./usageIndex.model.ts";

export async function jsonlFileDescriptors(root: string): Promise<FileDescriptor[]> {
  const paths: string[] = [];
  await collectJsonlFiles(root, paths);
  paths.sort();
  return await Promise.all(paths.map(async (path) => {
    const value = await stat(path);
    return { inode: String(value.ino), mtimeMs: value.mtimeMs, path, size: value.size };
  }));
}

export async function collectJsonlFiles(dir: string, files: string[]): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await collectJsonlFiles(path, files);
    else if (entry.isFile() && extname(entry.name) === ".jsonl") files.push(path);
  }
}

export async function tailChecksum(path: string, offset: number): Promise<string> {
  const start = Math.max(0, offset - TAIL_BYTES);
  const length = Math.max(0, offset - start);
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, start);
    return createHash("sha256").update(buffer).digest("hex");
  } finally {
    await handle.close();
  }
}
