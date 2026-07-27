import { coldStartTrace } from "./benchmarks/coldStart.ts";
import { formatBunVersion } from "./buildInfo.ts";
import { commandMode } from "./mainMode.ts";
import { resolveServerRole } from "./serverRole.ts";

if (Bun.argv[2] === "__runtime-observability-worker") {
  const [, databasePath = "", parentPIDText = "0"] = Bun.argv.slice(2);
  const parentPID = Number(parentPIDText);
  const parentWatch = setInterval(() => {
    if (!Number.isInteger(parentPID) || parentPID <= 1) return;
    try { process.kill(parentPID, 0); } catch { process.exit(1); }
  }, 1000);
  let database: Awaited<ReturnType<typeof import("./db/database.ts").openDatabase>> | undefined;
  try {
    const [{ openDatabase }, { buildRuntimeObservability }] = await Promise.all([
      import("./db/database.ts"),
      import("./observability/runtimeObservability.ts")
    ]);
    database = await openDatabase({ readonlyImportPath: databasePath });
    const snapshot = buildRuntimeObservability(database, new Date());
    clearInterval(parentWatch);
    process.stdout.write(JSON.stringify({ ok: true, snapshot }));
    database.close();
    process.exit(0);
  } catch (error) {
    clearInterval(parentWatch);
    database?.close();
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

if (Bun.argv[2] === "__usage-index-worker") {
  const [, root = "", indexPath = "", forceRebuild = "0", parentPIDText = "0"] = Bun.argv.slice(2);
  const parentPID = Number(parentPIDText);
  const parentWatch = setInterval(() => {
    if (!Number.isInteger(parentPID) || parentPID <= 1) return;
    try { process.kill(parentPID, 0); } catch { process.exit(1); }
  }, 1000);
  try {
    const { refreshUsageIndex } = await import("./usage/usageIndex.ts");
    const metrics = await refreshUsageIndex(root, indexPath, { forceRebuild: forceRebuild === "1" });
    clearInterval(parentWatch);
    process.stdout.write(JSON.stringify({ metrics, ok: true }));
    process.exit(0);
  } catch (error) {
    clearInterval(parentWatch);
    process.stderr.write(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

const { serve, args, version } = commandMode(Bun.argv.slice(2));
coldStartTrace("entry_loaded");

if (version) {
  process.stdout.write(formatBunVersion());
  process.exit(0);
}

if (!serve) {
  const { runCli } = await import("./cli/command.ts");
  process.exit(await runCli(args));
}

const selected = resolveServerRole(args, Bun.env);
if (selected.role === "web") {
  const { startWebRuntime } = await import("./runtime/web.ts");
  await startWebRuntime(selected.args);
} else if (selected.role === "agentic") {
  const { startAgenticRuntime } = await import("./runtime/agentic.ts");
  await startAgenticRuntime(selected.args);
} else {
  const { startCoreRuntime } = await import("./runtime/core.ts");
  await startCoreRuntime(selected.args, selected.role);
}
