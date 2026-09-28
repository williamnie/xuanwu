import { runBoundedProcess, type BoundedProcessInput, type BoundedProcessResult } from "../util/boundedProcess.ts";

export type StdioProcessResult = BoundedProcessResult;
type ProcessInput = BoundedProcessInput & { beforeStart?: () => boolean };

const MAX_ACTIVE = 4;
const MAX_QUEUED = 32;
let active = 0;
const queue: Array<() => void> = [];

/** 超时包含排队时间；输出按字节限制，异常时终止独立进程组并关闭所有管道。 */
export function runStdioProcess(input: ProcessInput): Promise<StdioProcessResult> {
  if (active >= MAX_ACTIVE && queue.length >= MAX_QUEUED) {
    return Promise.resolve(failed("EBUSY", "MCP process queue is full"));
  }
  const timeoutMs = Number.isFinite(input.timeoutMs) && input.timeoutMs > 0
    ? Math.min(input.timeoutMs, 120_000) : 10_000;
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve) => {
    let queuedTimer: ReturnType<typeof setTimeout> | undefined;
    const start = () => {
      clearTimeout(queuedTimer);
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        resolve(failed("ETIMEDOUT", "MCP process queue timed out"));
        queue.shift()?.();
        return;
      }
      try {
        if (input.beforeStart && !input.beforeStart()) {
          resolve(failed("ECANCELED", "MCP process was disabled before start"));
          queue.shift()?.();
          return;
        }
      } catch {
        resolve(failed("ECANCELED", "MCP process preflight failed"));
        queue.shift()?.();
        return;
      }
      active += 1;
      runBoundedProcess({ ...input, timeoutMs: remaining }).then(resolve).finally(() => {
        active -= 1;
        queue.shift()?.();
      });
    };
    if (active < MAX_ACTIVE) start();
    else {
      queue.push(start);
      queuedTimer = setTimeout(() => {
        const index = queue.indexOf(start);
        if (index < 0) return;
        queue.splice(index, 1);
        resolve(failed("ETIMEDOUT", "MCP process queue timed out"));
      }, timeoutMs);
    }
  });
}

function failed(code: string, message: string): StdioProcessResult {
  return { error: Object.assign(new Error(message), { code }), signal: null, status: null, stderr: "", stdout: "" };
}
