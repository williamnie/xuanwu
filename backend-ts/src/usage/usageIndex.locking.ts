import { open, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { basename } from "node:path";
import { LOCK_STALE_MS } from "./usageIndex.model.ts";

export async function acquireLock(path: string): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const handle = await open(path, "wx");
      await handle.writeFile(JSON.stringify({ created_at: new Date().toISOString(), pid: process.pid }));
      await handle.close();
      return async () => { await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const value = await stat(path).catch(() => undefined);
      if (value && (Date.now() - value.mtimeMs > LOCK_STALE_MS || !await lockOwnerAlive(path))) {
        await rm(path, { force: true });
        continue;
      }
      await Bun.sleep(50);
    }
  }
  throw new Error("usage index refresh lock timeout");
}

export async function lockOwnerAlive(path: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
    const pid = Number(value.pid);
    if (!Number.isInteger(pid) || pid <= 1) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function cleanupAbandonedIndexes(indexPath: string): Promise<void> {
  const directory = dirname(indexPath);
  const prefix = `${basename(indexPath)}.tmp-`;
  for (const name of await readdir(directory)) {
    if (!name.startsWith(prefix)) continue;
    await rm(join(directory, name), { force: true });
  }
}

export async function removeSQLiteFiles(path: string): Promise<void> {
  await rm(path, { force: true });
  await removeSQLiteSidecars(path);
}

export async function removeSQLiteSidecars(path: string): Promise<void> {
  await rm(`${path}-wal`, { force: true });
  await rm(`${path}-shm`, { force: true });
}
