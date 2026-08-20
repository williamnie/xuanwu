import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { CapturedGitWorkspaceBaseline, WorkspaceEntry } from "../evidence/runGitWorkspaceBaseline.ts";

const OBSERVATION_DEADLINE_MS = 15_000;
const CHILD_TIMEOUT_MS = 10_000;
const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;
const globalSemaphore = new Semaphore(2);
const cwdSemaphores = new Map<string, Semaphore>();
const counters = new Map<string, number>();

export type GitWorkspaceObservationInput = {
  project_cwd: string;
  run_id: string;
};

export async function observeGitWorkspaceBaseline(
  input: GitWorkspaceObservationInput
): Promise<CapturedGitWorkspaceBaseline | null> {
  const started = performance.now();
  const deadline = started + OBSERVATION_DEADLINE_MS;
  const cwd = await canonicalCwd(input.project_cwd);
  if (!cwd || !input.run_id.trim()) return outcome("invalid_input");
  const releaseGlobal = await globalSemaphore.acquire(deadline);
  if (!releaseGlobal) return outcome("queue_timeout");
  const cwdSemaphore = cwdSemaphores.get(cwd) ?? new Semaphore(1);
  cwdSemaphores.set(cwd, cwdSemaphore);
  const releaseCwd = await cwdSemaphore.acquire(deadline);
  if (!releaseCwd) {
    releaseGlobal();
    return outcome("queue_timeout");
  }
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const captured = await captureOnce(cwd, deadline);
      if (!captured) return outcome("capture_failed");
      const stableHead = await gitText(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], deadline);
      if (stableHead === captured.base_revision) {
        increment("captured");
        return captured;
      }
      increment("head_changed");
    }
    return outcome("head_changed_twice");
  } finally {
    releaseCwd();
    releaseGlobal();
  }
}

export function gitWorkspaceObservationMetrics(): Record<string, number> {
  return Object.fromEntries([...counters.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

async function captureOnce(cwd: string, deadline: number): Promise<CapturedGitWorkspaceBaseline | null> {
  const baseRevision = await gitText(cwd, ["rev-parse", "--verify", "HEAD^{commit}"], deadline);
  if (!gitObjectID(baseRevision)) return null;
  const status = await runGit(cwd, [
    "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--ignored=no", "--"
  ], deadline);
  if (!status) return null;
  const fields = new TextDecoder().decode(status.stdout).split("\0").filter(Boolean);
  const entries = new Array<WorkspaceEntry>(fields.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(2, fields.length) }, async () => {
    while (cursor < fields.length) {
      const index = cursor++;
      const field = fields[index];
      if (field.length < 4 || field[2] !== " ") throw new Error("malformed status");
      const path = normalizedPath(field.slice(3));
      const oid = await gitText(cwd, ["hash-object", "--no-filters", "--", path], deadline);
      entries[index] = {
        content_oid: gitObjectID(oid) ? oid : "missing",
        path,
        status: field.slice(0, 2)
      };
    }
  });
  try { await Promise.all(workers); } catch { return null; }
  entries.sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path)));
  return {
    base_revision: baseRevision,
    captured_at: new Date().toISOString(),
    entries,
    snapshot_sha256: createHash("sha256").update(`${JSON.stringify(entries)}\n`).digest("hex")
  };
}

async function gitText(cwd: string, args: string[], deadline: number): Promise<string> {
  const result = await runGit(cwd, args, deadline);
  return result ? new TextDecoder().decode(result.stdout).trim().toLowerCase() : "";
}

async function runGit(cwd: string, args: string[], deadline: number): Promise<{ stdout: Uint8Array } | null> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return null;
  let process: ReturnType<typeof Bun.spawn>;
  try {
    process = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  } catch { return null; }
  const timeout = setTimeout(() => process.kill("SIGKILL"), Math.min(CHILD_TIMEOUT_MS, remaining));
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      readBounded(process.stdout, () => process.kill("SIGKILL")),
      readBounded(process.stderr, () => process.kill("SIGKILL")),
      process.exited
    ]);
    void stderr;
    if (exitCode !== 0 || !stdout) return null;
    return { stdout };
  } catch { return null; }
  finally { clearTimeout(timeout); }
}

async function readBounded(stream: ReadableStream<Uint8Array> | null, onOverflow: () => void): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > OUTPUT_LIMIT_BYTES) {
        onOverflow();
        return null;
      }
      chunks.push(item.value);
    }
  } finally { reader.releaseLock(); }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<{ active: boolean; grant: () => void }> = [];
  constructor(private readonly limit: number) {}

  async acquire(deadline: number): Promise<(() => void) | null> {
    if (this.active < this.limit) {
      this.active += 1;
      return () => this.release();
    }
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    const waiter = { active: true, grant: () => {} };
    const granted = new Promise<boolean>((resolve) => {
      waiter.grant = () => { if (waiter.active) resolve(true); };
      this.waiters.push(waiter);
    });
    const won = await Promise.race([
      granted,
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), remaining))
    ]);
    waiter.active = false;
    if (!won) return null;
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift()!;
      if (!waiter.active) continue;
      waiter.grant();
      break;
    }
  }
}

async function canonicalCwd(value: string): Promise<string> {
  const path = value.trim();
  if (!path) return "";
  try { return await realpath(path); } catch { return resolve(path); }
}
function normalizedPath(value: string): string {
  const path = value.trim().replaceAll("\\", "/");
  if (!path || path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new Error("workspace path escapes repository");
  }
  return path;
}
function gitObjectID(value: string): boolean { return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value); }
function increment(key: string): void { counters.set(key, (counters.get(key) ?? 0) + 1); }
function outcome(key: string): null { increment(key); return null; }
