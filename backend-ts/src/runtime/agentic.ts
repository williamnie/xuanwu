import { startAgenticServer } from "../agentic/server.ts";
import { bunBuildInfo } from "../buildInfo.ts";
import { loadConfig } from "../config/env.ts";
import { openDatabase } from "../db/database.ts";
import { assertInternalCoreAddress } from "../serverRole.ts";
import { reconcileStaleManagerCycleConversations } from "../runner/staleSessionReconciler.ts";

export async function startAgenticRuntime(args: string[]): Promise<void> {
  const config = loadConfig(args);
  assertInternalCoreAddress(config.addr, "Agentic Worker");
  const database = await openDatabase({
    dbPath: config.dbPath,
    stateDir: config.stateDir,
    writerBusyTimeoutMs: 5_000
  });
  const reconciliation = reconcileStaleManagerCycleConversations(database);
  const server = await startAgenticServer(config, database);
  installTerminationHandlers(server, database);
  console.log(JSON.stringify({
    build: bunBuildInfo(),
    listen: `${server.hostname}:${server.port}`,
    ok: true,
    reconciliation,
    role: "agentic",
    service: "codex-issue-runner agentic worker"
  }));
}

function installTerminationHandlers(
  server: { stop(closeActiveConnections?: boolean): void },
  database: Awaited<ReturnType<typeof openDatabase>>
): void {
  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.info(JSON.stringify({ event: "runner.shutdown_started", role: "agentic", signal }));
    server.stop(true);
    database.close();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));
}
