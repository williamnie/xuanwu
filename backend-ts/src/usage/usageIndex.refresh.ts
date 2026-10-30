import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { basename } from "node:path";
import { WORKER_TIMEOUT_MS } from "./usageIndex.model.ts";
import type { RefreshOptions, UsageIndexMetrics, RefreshResult } from "./usageIndex.model.ts";
import { acquireLock } from "./usageIndex.locking.ts";
import { usageIndexIsValid, usageIndexIdentity } from "./usageIndex.identity.ts";
import { rebuildIndex, updateIndex } from "./usageIndex.update.ts";

export async function refreshUsageIndex(
  root: string,
  indexPath: string,
  options: RefreshOptions = {}
): Promise<UsageIndexMetrics> {
  return (await refreshUsageIndexWithIdentity(root, indexPath, options)).metrics;
}

export async function refreshUsageIndexWithIdentity(
  root: string,
  indexPath: string,
  options: RefreshOptions = {}
): Promise<RefreshResult> {
  await mkdir(dirname(indexPath), { recursive: true });
  const release = await acquireLock(`${indexPath}.lock`);
  try {
    const rebuild = options.forceRebuild || !usageIndexIsValid(indexPath, root, options.verifiedIndexIdentity);
    const metrics = rebuild ? await rebuildIndex(root, indexPath) : await updateIndex(root, indexPath);
    // 持锁记录已完成刷新对应的指纹，避免 Reader 误信刷新之后的外部写入。
    return { indexIdentity: usageIndexIdentity(indexPath), metrics };
  } finally {
    await release();
  }
}

export async function refreshUsageIndexInWorker(
  root: string,
  indexPath: string,
  options: RefreshOptions = {}
): Promise<RefreshResult> {
  const workerArgs = ["__usage-index-worker", root, indexPath, options.forceRebuild ? "1" : "0", String(process.pid), options.verifiedIndexIdentity ?? ""];
  const command = basename(process.execPath).startsWith("bun")
    ? [process.execPath, join(import.meta.dir, "../main.ts"), ...workerArgs]
    : [process.execPath, ...workerArgs];
  const child = Bun.spawn({
    cmd: command,
    env: workerEnvironment(),
    stderr: "pipe",
    stdout: "pipe"
  });
  const timeout = setTimeout(() => child.kill(), WORKER_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]).finally(() => clearTimeout(timeout));
  if (exitCode !== 0) throw new Error(`usage index worker failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  const parsed = JSON.parse(stdout) as { indexIdentity?: string; metrics?: UsageIndexMetrics; ok?: boolean };
  if (!parsed.ok || !parsed.metrics) throw new Error("usage index worker returned an invalid result");
  return { indexIdentity: parsed.indexIdentity, metrics: parsed.metrics };
}

export function workerEnvironment(): Record<string, string> {
  return Object.fromEntries(["HOME", "PATH", "TMPDIR", "TZ"]
    .map((key) => [key, Bun.env[key] ?? ""])
    .filter(([, value]) => value !== ""));
}
