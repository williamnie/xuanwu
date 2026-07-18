#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../backend-ts/src/db/database.ts";
import { createDefaultRouter, createRequestHandler } from "../backend-ts/src/http/server.ts";
import {
  GOLDEN_JOURNEY_SCENARIOS,
  type GoldenJourneyScenario
} from "../backend-ts/src/xuanwu/goldenJourneyScenarios.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const DEFAULT_ARTIFACT_ROOT = join(REPO_ROOT, ".runner", "artifacts", "golden-journeys");

type StageName = "fixture" | "backend" | "frontend" | "browser_api" | "cleanup";
type StageResult = {
  command?: string[];
  duration_ms: number;
  finished_at: string;
  name: StageName;
  started_at: string;
  status: "passed" | "failed";
};
type Failure = { error: string; journey_id: string; stage: StageName };
type ScenarioResult = {
  fixture_root: string;
  id: GoldenJourneyScenario["id"];
  name: string;
  stages: StageResult[];
  status: "passed" | "failed";
};

async function main(): Promise<void> {
  const options = parseArgs(Bun.argv.slice(2));
  if (options.list) {
    for (const scenario of GOLDEN_JOURNEY_SCENARIOS) console.log(`${scenario.id}\t${scenario.name}`);
    return;
  }
  const selected = selectScenarios(options.scenarioIDs);
  const runID = new Date().toISOString().replace(/[:.]/g, "-");
  const artifactDir = resolve(options.artifactDir || join(DEFAULT_ARTIFACT_ROOT, runID));
  await mkdir(artifactDir, { recursive: true });
  const results: ScenarioResult[] = [];
  let failure: Failure | undefined;

  for (const scenario of selected) {
    const result = await runScenario(scenario, artifactDir, options.keepFixtures);
    results.push(result.result);
    if (result.failure) {
      failure = result.failure;
      break;
    }
  }

  const summary = {
    artifact_dir: artifactDir,
    cleanup: options.keepFixtures ? "fixture roots retained by explicit --keep-fixtures" : "fixture roots removed and absence asserted",
    failure: failure ?? null,
    finished_at: new Date().toISOString(),
    journey_count: results.length,
    requested_journey_count: selected.length,
    results,
    source_of_truth: "existing SQLite/API/Runner/Guardian/PI/Git authorities; this runner only orchestrates isolated fixtures and assertions",
    status: failure ? "failed" : "passed"
  };
  await writeJson(join(artifactDir, "summary.json"), summary);
  if (failure) {
    await writeJson(join(artifactDir, "failure-report.json"), {
      ...failure,
      message: "Stopped at the earliest uncertain stage; later stages and journeys were not executed.",
      replay: replayCommand(failure.journey_id, artifactDir)
    });
  }
  console.log(JSON.stringify(summary, null, 2));
  if (failure) process.exitCode = 1;
}

async function runScenario(
  scenario: GoldenJourneyScenario,
  artifactDir: string,
  keepFixtures: boolean
): Promise<{ failure?: Failure; result: ScenarioResult }> {
  const scenarioDir = join(artifactDir, scenario.id);
  await mkdir(scenarioDir, { recursive: true });
  await mkdir(join(REPO_ROOT, ".runner"), { recursive: true });
  const fixtureRoot = await mkdtemp(join(REPO_ROOT, ".runner", `golden-${scenario.id.toLowerCase()}-`));
  const stages: StageResult[] = [];
  let failure: Failure | undefined;
  let database: RunnerDatabase | undefined;

  try {
    await stage(stages, "fixture", async () => {
      database = await openDatabase({ stateDir: join(fixtureRoot, "state") });
      const projects = await createFixtureProjects(scenario, fixtureRoot);
      await writeJson(join(scenarioDir, "fixture.json"), {
        project_count: scenario.fixture_projects,
        projects,
        state_dir: join(fixtureRoot, "state")
      });
    });

    await commandStage(stages, "backend", ["bun", "test", ...scenario.backend_tests], scenarioDir);
    await commandStage(stages, "frontend", ["node", "--test", ...scenario.frontend_tests], scenarioDir);
    await stage(stages, "browser_api", async () => {
      if (!database) throw new Error("fixture database is not open");
      const assertions = await browserApiAssertions(scenario, database, fixtureRoot);
      await writeJson(join(scenarioDir, "browser-api.json"), assertions);
    });
  } catch (error) {
    const failedStage = stages.at(-1)?.name ?? "fixture";
    failure = { error: errorMessage(error), journey_id: scenario.id, stage: failedStage };
  } finally {
    database?.close();
    try {
      await stage(stages, "cleanup", async () => {
        if (keepFixtures) return;
        await rm(fixtureRoot, { force: true, recursive: true });
        if (existsSync(fixtureRoot)) throw new Error(`fixture cleanup failed: ${fixtureRoot}`);
      });
    } catch (error) {
      failure ??= { error: errorMessage(error), journey_id: scenario.id, stage: "cleanup" };
    }
  }

  const result: ScenarioResult = {
    fixture_root: fixtureRoot,
    id: scenario.id,
    name: scenario.name,
    stages,
    status: failure ? "failed" : "passed"
  };
  await writeJson(join(scenarioDir, "result.json"), result);
  return { failure, result };
}

async function browserApiAssertions(
  scenario: GoldenJourneyScenario,
  db: RunnerDatabase,
  fixtureRoot: string
): Promise<Record<string, unknown>> {
  const router = createDefaultRouter({ database: db });
  const handle = createRequestHandler(router, "", { webDir: join(REPO_ROOT, "frontend") });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handle });
  const baseURL = `http://127.0.0.1:${server.port}`;
  try {
    const projects = [];
    for (let index = 0; index < scenario.fixture_projects; index += 1) {
      const id = `${scenario.id.toLowerCase()}-project-${index + 1}`;
      const response = await jsonFetch(`${baseURL}/api/projects`, {
        method: "POST",
        body: JSON.stringify({ id, name: id, cwd: fixtureProjectPaths(scenario, fixtureRoot)[index], provider: "fake-execution-only" }),
        headers: { "content-type": "application/json" }
      });
      assert(response.status === 201, `project API returned ${response.status}`);
      projects.push(response.body);
    }
    const issue = await jsonFetch(`${baseURL}/api/issues`, {
      method: "POST",
      body: JSON.stringify({
        project_id: `${scenario.id.toLowerCase()}-project-1`,
        status: "triage",
        title: `${scenario.id} isolated replay fixture`
      }),
      headers: { "content-type": "application/json" }
    });
    assert(issue.status === 201, `issue API returned ${issue.status}`);
    const issueID = Number((issue.body as { id?: unknown }).id);
    assert(Number.isInteger(issueID) && issueID > 0, "issue API did not return an id");

    const apiAssertions: Array<{ path: string; status: number }> = [];
    for (const template of scenario.api_paths) {
      const path = template.replace("{issue_id}", String(issueID));
      const response = await fetch(`${baseURL}${path}`);
      assert(response.status === 200, `${path} returned ${response.status}`);
      apiAssertions.push({ path, status: response.status });
    }
    const issueDetail = await fetch(`${baseURL}/api/issues/${issueID}`);
    assert(issueDetail.status === 200, `issue detail API returned ${issueDetail.status}`);
    const shell = await fetch(`${baseURL}/${scenario.frontend_route}`);
    const html = await shell.text();
    assert(shell.status === 200, `frontend shell returned ${shell.status}`);
    assert(shell.headers.get("content-type")?.includes("text/html") === true, "frontend shell content-type is not HTML");
    assert(html.includes('id="root"'), "frontend shell is missing #root");
    assert(html.includes('/src/main.jsx'), "frontend shell is missing the Vite entrypoint");
    const dbCount = db.sqlite.query<{ count: number }, []>("select count(*) as count from issues").get()?.count ?? 0;
    assert(dbCount === 1, `fixture DB expected one issue, got ${dbCount}`);
    const gitAssertions = [];
    for (const path of fixtureProjectPaths(scenario, fixtureRoot)) {
      const [revision, status] = await Promise.all([
        git(path, "rev-parse", "HEAD"),
        git(path, "status", "--short")
      ]);
      assert(/^[0-9a-f]{40}$/.test(revision), `fixture Git baseline is invalid: ${path}`);
      assert(status === "", `fixture Git working tree is dirty: ${path}`);
      gitAssertions.push({ cwd: path, revision, status: "clean" });
    }
    return {
      api_assertions: apiAssertions,
      browser_assertion: { content_type: shell.headers.get("content-type"), route: scenario.frontend_route, status: shell.status },
      db_assertion: { issue_count: dbCount },
      fixture_project_ids: projects.map((project) => (project as { id?: unknown }).id),
      git_assertions: gitAssertions,
      issue_id: issueID,
      server: "ephemeral Bun HTTP server"
    };
  } finally {
    server.stop(true);
  }
}

async function commandStage(
  stages: StageResult[],
  name: Extract<StageName, "backend" | "frontend">,
  command: string[],
  scenarioDir: string
): Promise<void> {
  await stage(stages, name, async () => {
    const child = Bun.spawn(command, { cwd: REPO_ROOT, env: { ...process.env, NO_COLOR: "1" }, stderr: "pipe", stdout: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited
    ]);
    await writeFile(join(scenarioDir, `${name}.log`), `${stdout}${stderr}`, "utf8");
    if (exitCode !== 0) throw new Error(`${command.join(" ")} exited with ${exitCode}`);
  }, command);
}

async function stage(
  stages: StageResult[],
  name: StageName,
  run: () => Promise<void>,
  command?: string[]
): Promise<void> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const result: StageResult = {
    ...(command ? { command } : {}),
    duration_ms: 0,
    finished_at: "",
    name,
    started_at: startedAt,
    status: "passed"
  };
  stages.push(result);
  try {
    await run();
  } catch (error) {
    result.status = "failed";
    throw error;
  } finally {
    result.duration_ms = Math.round(performance.now() - started);
    result.finished_at = new Date().toISOString();
  }
}

async function createFixtureProjects(
  scenario: GoldenJourneyScenario,
  fixtureRoot: string
): Promise<Array<{ baseline_revision: string; cwd: string }>> {
  const projects = [];
  for (const [index, path] of fixtureProjectPaths(scenario, fixtureRoot).entries()) {
    await mkdir(join(path, "src"), { recursive: true });
    await writeFile(join(path, "README.md"), `# ${scenario.id} fixture project ${index + 1}\n`, "utf8");
    await writeFile(join(path, "src", "target.txt"), "clean baseline\n", "utf8");
    await git(path, "init", "-q", "-b", "main");
    await git(path, "add", "README.md", "src/target.txt");
    await git(path, "-c", "user.name=Xuanwu Fixture", "-c", "user.email=xuanwu@example.test", "commit", "-q", "-m", "test: create clean fixture baseline");
    projects.push({ baseline_revision: await git(path, "rev-parse", "HEAD"), cwd: path });
  }
  return projects;
}

function fixtureProjectPaths(scenario: GoldenJourneyScenario, fixtureRoot: string): string[] {
  return Array.from({ length: scenario.fixture_projects }, (_, index) => join(fixtureRoot, `project-${index + 1}`));
}

function parseArgs(args: string[]): { artifactDir: string; keepFixtures: boolean; list: boolean; scenarioIDs: string[] } {
  const output = { artifactDir: "", keepFixtures: false, list: false, scenarioIDs: [] as string[] };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--artifacts") output.artifactDir = requiredArg(args, ++index, arg);
    else if (arg === "--scenario") output.scenarioIDs.push(requiredArg(args, ++index, arg).toUpperCase());
    else if (arg === "--keep-fixtures") output.keepFixtures = true;
    else if (arg === "--list") output.list = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return output;
}

function selectScenarios(ids: string[]): GoldenJourneyScenario[] {
  if (ids.length === 0) return [...GOLDEN_JOURNEY_SCENARIOS];
  return ids.map((id) => {
    const scenario = GOLDEN_JOURNEY_SCENARIOS.find((item) => item.id === id);
    if (!scenario) throw new Error(`unknown scenario: ${id}`);
    return scenario;
  });
}

function requiredArg(args: string[], index: number, flag: string): string {
  const value = args[index]?.trim() ?? "";
  if (value === "") throw new Error(`${flag} requires a value`);
  return value;
}

async function jsonFetch(url: string, init?: RequestInit): Promise<{ body: Record<string, unknown>; status: number }> {
  const response = await fetch(url, init);
  return { body: await response.json() as Record<string, unknown>, status: response.status };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const child = Bun.spawn(["git", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

function replayCommand(journeyID: string, artifactDir: string): string {
  return `bun scripts/run-golden-journeys.ts --scenario ${journeyID} --artifacts ${JSON.stringify(join(artifactDir, "replay"))}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

void main().catch((error) => {
  console.error(errorMessage(error));
  process.exit(1);
});
