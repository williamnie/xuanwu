import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { isSqliteContention } from "../http/errors.ts";

const STARTUP_RETRY_WINDOW_MS = 10_000;
const STARTUP_RETRY_DELAY_MS = 100;

/** Core 重启时 Agentic 仍可能持有写锁；仅对临时锁冲突重试，并在两次尝试间让出事件循环。 */
export async function openCoreDatabase(
  options: { dbPath: string; stateDir: string },
  retry: { windowMs?: number; delayMs?: number } = {}
): Promise<RunnerDatabase> {
  const started = performance.now();
  const deadline = started + (retry.windowMs ?? STARTUP_RETRY_WINDOW_MS);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      // openDatabase 失败会关闭连接；重开后重新读取 migration 状态，不复用失败事务。
      return await openDatabase(options);
    } catch (error) {
      const remaining = deadline - performance.now();
      if (!isSqliteContention(error) || remaining <= 0) throw error;
      console.warn(JSON.stringify({
        event: "runner.database_startup_retry",
        attempt,
        elapsed_ms: Math.round(performance.now() - started),
        reason: "sqlite_contention"
      }));
      await Bun.sleep(Math.min(retry.delayMs ?? STARTUP_RETRY_DELAY_MS, remaining));
      if (performance.now() >= deadline) throw error;
    }
  }
}
