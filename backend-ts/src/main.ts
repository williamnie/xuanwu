import { runCli } from "./cli/command.ts";
import { commandMode } from "./mainMode.ts";
import { loadConfig } from "./config/env.ts";
import { openDatabase } from "./db/database.ts";
import { startServer } from "./http/server.ts";
import { createCodexExecutorProvider } from "./providers/codex/provider.ts";
import { runProjectLoopOnce } from "./runner/projectLoop.ts";
import { redactSensitiveText } from "./util/redact.ts";

const { serve, args } = commandMode(Bun.argv.slice(2));

if (!serve) {
  process.exit(await runCli(args));
}

const config = loadConfig(args);
const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir });
const server = await startServer(config, { database });
startAutoRunLoops(database, config);

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

function startAutoRunLoops(database: Awaited<ReturnType<typeof openDatabase>>, config: ReturnType<typeof loadConfig>): void {
  const codexConfig = config.providers.codex;
  if (!codexConfig) return;
  const provider = createCodexExecutorProvider(codexConfig);
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
      error: redactSensitiveText(error instanceof Error ? error.message : String(error))
    }));
  });
}
