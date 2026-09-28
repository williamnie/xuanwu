import type { RunnerDatabase } from "../db/database.ts";
import { recordReflectionAttempt, unknownReflectionUsage } from "../pi/memoryReflectionTelemetry.ts";
import {
  claimMemoryReflection, failMemoryReflectionAttempt, finishMemoryReflection, getMemoryReflection,
  reconcileMemoryReflectionEvents, requireReflectionLease, REFLECTION_LIMITS,
  type MemoryReflection, type ReflectionLease
} from "../pi/memoryReflectionQueue.ts";

type Reflect = (request: MemoryReflection, lease: ReflectionLease, signal: AbortSignal) => Promise<string>;

export async function runMemoryReflectionOnce(db: RunnerDatabase, options: {
  reflect?: Reflect; timeoutMs?: number; signal?: AbortSignal
} = {}): Promise<boolean> {
  reconcileMemoryReflectionEvents(db);
  if (options.signal?.aborted) return false;
  const request = claimMemoryReflection(db);
  if (!request) return false;
  const lease = { id: request.id, token: request.lease_token };
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const usage = unknownReflectionUsage();
  let attemptError = "";
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("reflection worker stopped"));
  options.signal?.addEventListener("abort", abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: () => void = () => {};
  try {
    const timeoutMs = Math.min(options.timeoutMs ?? REFLECTION_LIMITS.timeoutMs, REFLECTION_LIMITS.timeoutMs);
    timer = setTimeout(() => controller.abort(new Error("reflection timed out")), timeoutMs);
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    const reflect = options.reflect ?? (async (row, token, signal) => {
      const { runMemoryReflectionRuntime } = await import("../pi/memoryReflectionRuntime.ts");
      return runMemoryReflectionRuntime(db, row, token, signal, usage);
    });
    const raw = await Promise.race([reflect(request, lease, controller.signal), cancelled]);
    // memory_remember 已将记忆和 completed 原子提交；尾部输出失败不撤销这个结果。
    if (getMemoryReflection(db, lease.id)?.status === "completed") return true;
    if (Buffer.byteLength(raw) > REFLECTION_LIMITS.outputBytes) throw new Error("reflection output budget exceeded");
    const result = JSON.parse(raw);
    if (result?.status !== "skipped" || typeof result.reason !== "string" || !result.reason.trim() || result.reason.length > 1000) {
      throw new Error("reflection requires a saved memory or an explicit skip reason");
    }
    db.transaction(() => {
      requireReflectionLease(db, lease);
      finishMemoryReflection(db, lease, "skipped", result.reason);
    }).immediate();
  } catch (error) {
    // 旧 worker 的迟到回调只能更新自己的 token，不能覆盖新领取或已完成的记录。
    attemptError = error instanceof Error ? error.message : String(error);
    failMemoryReflectionAttempt(db, lease, attemptError);
  } finally {
    if (timer) clearTimeout(timer);
    controller.signal.removeEventListener("abort", onAbort);
    options.signal?.removeEventListener("abort", abort);
    const current = getMemoryReflection(db, lease.id);
    // 即使记忆已原子提交，尾部模型失败仍单独报告；迟到回调不更新本次事实。
    try {
      recordReflectionAttempt(db, request, { startedAt, elapsedMs: Math.max(0, performance.now() - started),
        status: attemptError ? "failed" : current?.status ?? "unknown",
        reason: attemptError || current?.reason || "", usage: { ...usage } });
    } catch { console.warn("[pi-memory] reflection attempt telemetry unavailable"); }
  }
  return true;
}

export function startMemoryReflectionWorker(db: RunnerDatabase): () => void {
  const controller = new AbortController();
  let active = false;
  const tick = async () => {
    if (active || controller.signal.aborted) return;
    active = true;
    try { await runMemoryReflectionOnce(db, { signal: controller.signal }); }
    catch { console.warn("[pi-memory] reflection worker deferred after storage error"); }
    finally { active = false; }
  };
  const timer = setInterval(() => { void tick(); }, 5000);
  timer.unref();
  void tick();
  return () => { clearInterval(timer); controller.abort(); };
}
