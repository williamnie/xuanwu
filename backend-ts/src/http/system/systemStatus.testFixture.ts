import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createDefaultRouter, createRequestHandler, registerSystemStatusRoute } from "../server.ts";
import { FIXTURE_TIME, insertIssue, insertProject, insertRow, useDatabaseCleanup, useTempDirs } from "../../testing/harness.ts";

export type StatusBody = Record<string, any> & { connector_health: Array<Record<string, any>>; providers: Array<Record<string, any>> };

export type RuntimeOptions = Omit<NonNullable<Parameters<typeof buildConfig>[0]>, "authToken" | "stateDir"> & { secret?: string };

export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const tempDir = useTempDirs("xuanwu-bun-status-");

  const BASE_URL = "http://127.0.0.1:3008";

  const CODEX_CAPABILITIES = ["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"];

  const CLAUDE_CAPABILITIES = ["issue_execution", "sessions", "resume_session", "interrupt"];

  async function openFixtureRuntime({ secret, ...options }: RuntimeOptions = {}) {
    const config = buildConfig({ ...options, authToken: secret, stateDir: join(await tempDir(), "state") });
    const database = await openDatabase({ dbPath: config.dbPath, stateDir: config.stateDir }).then(trackDatabase);
    return { config, database };
  }

  async function systemStatus(
    options: RuntimeOptions = {},
    {
      path = "/api/system/status",
      route = {},
      seed = () => {}
    }: {
      path?: string;
      route?: Partial<Parameters<typeof registerSystemStatusRoute>[1]>;
      seed?: (runtime: Awaited<ReturnType<typeof openFixtureRuntime>>) => void;
    } = {}
  ) {
    const runtime = await openFixtureRuntime(options);
    seed(runtime);
    const router = createDefaultRouter();
    const secret = options.secret ?? "";
    registerSystemStatusRoute(router, { authToken: secret, config: runtime.config, database: runtime.database, ...route });
    const response = secret
      ? await createRequestHandler(router, secret)(new Request(`${BASE_URL}${path}`, { headers: { authorization: `Bearer ${secret}` } }))
      : await router.handle(new Request(`${BASE_URL}${path}`));
    const text = await response.text();
    return { ...runtime, status: response.status, text, body: JSON.parse(text) as StatusBody, router };
  }

  async function writeFakeExecutable(dir: string, name: string, version: string, loggedIn = false): Promise<void> {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh
if [ "$1" = "--version" ]; then echo "${version}"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo '{"apiProvider":"firstParty","authMethod":"claude.ai","loggedIn":${loggedIn}}'; exit 0; fi
exit 1
`, { mode: 0o755 });
  }

  function insertRunnerStatusFixture(database: RunnerDatabase): void {
    const at = { created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME };
    insertProject(database, "demo", { name: "Demo", auto_run: 1 });
    insertIssue(database, { title: "Running", status: "in_progress" });
    insertRow(database, "issue_runs", { id: "issue-1-attempt-1", issue_id: 1, attempt: 1, status: "in_progress", started_at: FIXTURE_TIME });
    insertRow(database, "project_holds", { project_id: "demo", reason: "manual", message: "waiting", hold_since: FIXTURE_TIME, updated_at: FIXTURE_TIME });
    insertRow(database, "agent_sessions", {
      session_key: "codex:thread-1", provider: "codex", provider_session_id: "thread-1", project_id: "demo", issue_id: 1, status: "running", ...at
    });
  }
  return { trackDatabase, tempDir, BASE_URL, CODEX_CAPABILITIES, CLAUDE_CAPABILITIES, openFixtureRuntime, systemStatus, writeFakeExecutable, insertRunnerStatusFixture };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
