import type { AgenticActivitySnapshot } from "./protocol.ts";

type AgenticActivityTracker = {
  observeWorker(input: { pid: number; rss_bytes: number; started_at: string }): void;
  run<T>(operation: () => Promise<T>): Promise<T>;
  snapshot(): AgenticActivitySnapshot;
};

export function createAgenticActivityTracker(
  now: () => Date = () => new Date()
): AgenticActivityTracker {
  let inFlight = 0;
  let lastActivityAt = "";
  let worker: Pick<AgenticActivitySnapshot, "worker_pid" | "worker_rss_bytes" | "worker_started_at"> = {};

  return {
    observeWorker(input): void {
      if (!Number.isSafeInteger(input.pid) || input.pid <= 0) return;
      worker = {
        worker_pid: input.pid,
        worker_rss_bytes: Number.isSafeInteger(input.rss_bytes) && input.rss_bytes > 0 ? input.rss_bytes : 0,
        worker_started_at: input.started_at.trim()
      };
    },
    async run<T>(operation: () => Promise<T>): Promise<T> {
      inFlight += 1;
      lastActivityAt = now().toISOString();
      try {
        return await operation();
      } finally {
        inFlight = Math.max(0, inFlight - 1);
        lastActivityAt = now().toISOString();
      }
    },
    snapshot: () => ({
      in_flight: inFlight,
      last_activity_at: lastActivityAt,
      ...worker
    })
  };
}

export function createAgenticIdleMemoryReclaimer(input: {
  delayMs?: number;
  reclaim?: () => void;
} = {}): { requestFinished(): void; requestStarted(): void } {
  const delayMs = input.delayMs ?? 60_000;
  const reclaim = input.reclaim ?? (() => Bun.gc(true));
  let activeRequests = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  return {
    requestFinished() {
      activeRequests = Math.max(0, activeRequests - 1);
      if (activeRequests > 0) return;
      cancel();
      timer = setTimeout(() => {
        timer = undefined;
        reclaim();
      }, delayMs);
      timer.unref?.();
    },
    requestStarted() {
      activeRequests += 1;
      cancel();
    }
  };
}
