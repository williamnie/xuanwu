import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { runBoundedProcess } from "../../util/boundedProcess.ts";
import type { CapturedGitWorkspaceBaseline, WorkspaceEntry } from "../evidence/runGitWorkspaceBaseline.ts";

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  get idle(): boolean { return this.active === 0 && this.waiters.length === 0; }

  acquire(deadline: number): Promise<(() => void) | null> {
    const remaining = deadline - performance.now();
    if (remaining <= 0) return Promise.resolve(null);
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(() => this.release());
    }
    if (this.waiters.length >= 32) return Promise.resolve(null);
    return new Promise((resolve) => {
      const grant = () => {
        clearTimeout(timeout);
        if (performance.now() >= deadline) {
          resolve(null);
          this.release();
          return;
        }
        // release 把现有名额直接交给等待者，避免唤醒与新请求之间的竞争。
        resolve(() => this.release());
      };
      const timeout = setTimeout(() => {
        const index = this.waiters.indexOf(grant);
        if (index < 0) return;
        this.waiters.splice(index, 1);
        resolve(null);
      }, remaining);
      this.waiters.push(grant);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active = Math.max(0, this.active - 1);
  }
}


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
  if (!input.run_id.trim()) return outcome("invalid_input");
  return withGitWorkspaceObservation(input.project_cwd, async (cwd, deadline) => {
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
  });
}

/** 启动与收尾观察共用并发上限及总时限，同一仓库串行读取。 */
export async function withGitWorkspaceObservation<T>(
  projectCwd: string,
  capture: (cwd: string, deadline: number) => Promise<T>
): Promise<T | null> {
  const deadline = performance.now() + OBSERVATION_DEADLINE_MS;
  const cwd = await canonicalCwd(projectCwd);
  if (!cwd) return outcome("invalid_input");
  const releaseGlobal = await globalSemaphore.acquire(deadline);
  if (!releaseGlobal) return outcome("queue_timeout");
  const cwdSemaphore = cwdSemaphores.get(cwd) ?? new Semaphore(1);
  cwdSemaphores.set(cwd, cwdSemaphore);
  const releaseCwd = await cwdSemaphore.acquire(deadline);
  if (!releaseCwd) {
    releaseGlobal();
    return outcome("queue_timeout");
  }
  try { return await capture(cwd, deadline); }
  finally {
    releaseCwd();
    releaseGlobal();
    if (cwdSemaphore.idle) cwdSemaphores.delete(cwd);
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
      if (performance.now() >= deadline) throw new Error("workspace observation deadline exceeded");
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
  const results = await Promise.allSettled(workers);
  if (results.some((result) => result.status === "rejected")) return null;
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

export async function runGit(cwd: string, args: string[], deadline: number): Promise<{ stdout: Uint8Array } | null> {
  const remaining = deadline - performance.now();
  if (remaining <= 0) return null;
  const result = await runBoundedProcess({
    command: "git", args, cwd, input: "", stdoutLimit: OUTPUT_LIMIT_BYTES,
    stderrLimit: OUTPUT_LIMIT_BYTES, timeoutMs: Math.min(CHILD_TIMEOUT_MS, remaining)
  });
  return result.status === 0 && !result.error ? { stdout: Buffer.from(result.stdout) } : null;
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
