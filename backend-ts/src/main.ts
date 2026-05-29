import { runCli } from "./cli/command.ts";
import { commandMode } from "./mainMode.ts";
import { loadConfig } from "./config/env.ts";
import { openDatabase } from "./db/database.ts";
import { startServer } from "./http/server.ts";
import { createCodexExecutorProvider } from "./providers/codex/provider.ts";
import { runProjectLoopOnce } from "./runner/projectLoop.ts";
import { recoverInProgressIssues } from "./runner/recovery.ts";
import { redactSensitiveText } from "./util/redact.ts";

const { serve, args } = commandMode(Bun.argv.slice(2));

if (!serve) {
  process.exit(await runCli(args));
}

const config = loadConfig(args);
const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
const provider = codexProvider(config);
const server = await startServer(config, { database, providers: provider ? { codex: provider } : undefined });
if (provider) void startAutoRunLoops(database, provider);

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

function codexProvider(config: ReturnType<typeof loadConfig>): ReturnType<typeof createCodexExecutorProvider> | undefined {
  const codexConfig = config.providers.codex;
  return codexConfig ? createCodexExecutorProvider(codexConfig) : undefined;
}

async function startAutoRunLoops(
  database: Awaited<ReturnType<typeof openDatabase>>,
  provider: ReturnType<typeof createCodexExecutorProvider>
): Promise<void> {
  await recoverInProgressIssues({ database, providers: { codex: provider } }).catch((error) => {
    console.error(JSON.stringify({ ok: false, service: "codex-issue-runner backend-ts", error: safeError(error) }));
  });
  const projects = database.sqlite.query<{ id: string }, []>(
    "select id from projects where auto_run=1 order by sort_order asc, created_at asc, id asc"
  ).all();
  for (const project of projects) runAutoProject(database, project.id, provider);
}

function runAutoProject(
  database: Awaited<ReturnType<typeof openDatabase>>,
  projectId: string,
  provider: ReturnType<typeof createCodexExecutorProvider>
): void {
  void (async () => {
    while (true) {
      const result = await runProjectLoopOnce({ database, projectId, providers: { codex: provider } });
      if (!result.claimed) break;
    }
  })().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      service: "codex-issue-runner backend-ts",
      projectId,
      error: safeError(error)
    }));
  });
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
