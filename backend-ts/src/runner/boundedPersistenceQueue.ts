import { setImmediate as yieldToEventLoop } from "node:timers/promises";

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_ENTRIES = 1024;

/** 同步生产、异步串行消费；溢出不会创建更多 Promise，flush 必须显式报错。 */
export function createBoundedPersistenceQueue<T>(
  write: (value: T) => Promise<void>,
  options: { maxBytes?: number; maxEntries?: number } = {}
) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  if (![maxBytes, maxEntries].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError("persistence queue limits must be positive safe integers");
  }
  const entries: Array<{ value: T; bytes: number }> = [];
  let retainedBytes = 0;
  let retainedEntries = 0;
  let failure: Error | undefined;
  let running: Promise<void> | undefined;

  function start(): void {
    if (running || entries.length === 0) return;
    running = Promise.resolve().then(drain).finally(() => {
      running = undefined;
      start();
    });
  }

  async function drain(): Promise<void> {
    let completed = 0;
    while (entries.length > 0) {
      const entry = entries.shift()!;
      try {
        await write(entry.value);
      } catch (error) {
        failure ??= error instanceof Error ? error : new Error(String(error));
        entries.length = 0;
        retainedBytes = 0;
        retainedEntries = 0;
        return;
      }
      retainedBytes -= entry.bytes;
      retainedEntries -= 1;
      // 即使只有小型同步 SQL，也定期让出主事件循环，避免微任务持续占用。
      if (++completed % 16 === 0) await yieldToEventLoop();
    }
  }

  function push(value: T, bytes: number): boolean {
    if (failure) return false;
    if (!Number.isSafeInteger(bytes) || bytes < 0 ||
        retainedEntries >= maxEntries || retainedBytes + bytes > maxBytes) {
      failure = new Error("issue.log persistence queue budget exceeded; Run evidence could not be fully persisted");
      return false;
    }
    entries.push({ value, bytes });
    retainedBytes += bytes;
    retainedEntries += 1;
    start();
    return true;
  }

  function throwIfFailed(): void {
    if (failure) throw failure;
  }

  function fail(error: unknown): void {
    failure ??= error instanceof Error ? error : new Error(String(error));
  }

  async function flush(): Promise<void> {
    while (running) await running;
    throwIfFailed();
  }

  return { push, flush, throwIfFailed, fail };
}
