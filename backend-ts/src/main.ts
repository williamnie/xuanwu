import { runCli } from "./cli/command.ts";
import { formatBunVersion } from "./buildInfo.ts";
import { commandMode } from "./mainMode.ts";
import { loadConfig } from "./config/env.ts";
import { openDatabase } from "./db/database.ts";
import { EventBus } from "./events/bus.ts";
import { runProjectPiCycle } from "./http/piProjectControlApi.ts";
import { startServer } from "./http/server.ts";
import { createClaudeExecutorProvider } from "./providers/claude/provider.ts";
import { createCodexExecutorProvider } from "./providers/codex/provider.ts";
import { createPiAutoManageScheduler } from "./runner/piAutoManageScheduler.ts";
import { startProjectLoop } from "./runner/projectLoopManager.ts";
import { recoverInProgressIssues } from "./runner/recovery.ts";
import { redactSensitiveText } from "./util/redact.ts";

const { serve, args, version } = commandMode(Bun.argv.slice(2));

if (version) {
  process.stdout.write(formatBunVersion());
  process.exit(0);
}

if (!serve) {
  process.exit(await runCli(args));
}

const config = loadConfig(args);
const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
const providers = executorProviders(config);
const bus = new EventBus();
const server = await startServer(config, { bus, database, providers });
void startAutoRunLoops(database, providers, bus, config.codexSessionsDir, config);

console.log(JSON.stringify({
  ok: true,
  service: "codex-issue-runner backend-ts",
  listen: `${server.hostname}:${server.port}`,
  config: {
    addr: config.addr,
    stateDir: config.stateDir,
    dbPath: database.path
  }
}, null, 2));

function executorProviders(config: ReturnType<typeof loadConfig>) {
  const providers: Partial<Record<"codex" | "claude", ReturnType<typeof createCodexExecutorProvider> | ReturnType<typeof createClaudeExecutorProvider>>> = {};
  const codexConfig = config.providers.codex;
  const claudeConfig = config.providers.claude;
  if (codexConfig) providers.codex = createCodexExecutorProvider(codexConfig);
  if (claudeConfig) providers.claude = createClaudeExecutorProvider(claudeConfig);
  return providers;
}

async function startAutoRunLoops(
  database: Awaited<ReturnType<typeof openDatabase>>,
  providers: ReturnType<typeof executorProviders>,
  bus: EventBus,
  codexSessionsDir: string,
  config: ReturnType<typeof loadConfig>
): Promise<void> {
  await recoverInProgressIssues({ database, providers }).catch((error) => {
    console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", error: safeError(error) }));
  });
  const projects = database.sqlite.query<{ id: string }, []>(
    "select id from projects where auto_run=1 order by sort_order asc, created_at asc, id asc"
  ).all();
  for (const project of projects) startProjectLoop({ database, providers, onError: logProjectLoopError }, project.id);
  createPiAutoManageScheduler({
    bus,
    codexSessionsDir,
    config,
    database,
    providers,
    onError: (error) => {
      console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", error: safeError(error) }));
    },
    runProjectCycle: ({ maxActions, projectId }) => runProjectPiCycle({ database }, { maxActions, projectId })
  }).start();
}

function logProjectLoopError(error: unknown, projectId: string): void {
  console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", projectId, error: safeError(error) }));
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
