import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDefaultRouter, startServer } from "./server.ts";
import { buildConfig } from "../config/env.ts";
import {
  createGoParityFixtureDatabase, goAgentProfile, goCronTask, goIssue, goIssueEvent, goIssueRun,
  goIssueTemplate, goIssueWithLatestRun, goProject, openGoDatabase, writeFrontendFixture
} from "./goParityFixtures.testSupport.ts";

const tempRoots: string[] = [];
type ComparableResponse = { body: unknown; status: number };

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-parity-harness-"));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun/Go API parity harness", () => {
  test("compares every configured endpoint against a Go-compatible reference service on the same database", async () => {
    const root = await tempRoot();
    const dbPath = join(root, "data", "app.db");
    const webDir = join(root, "web");
    await createGoParityFixtureDatabase(dbPath);
    await writeFrontendFixture(webDir);
    const database = await openGoDatabase(dbPath, join(root, "state"));
    const reference = startReferenceServer();
    const bunServer = await startBunParityServer(root, dbPath, webDir, database);

    try {
      for (const endpoint of parityEndpoints()) {
        const goResult = await getComparable(`http://127.0.0.1:${reference.port}`, endpoint);
        const bunResult = await getComparable(`http://127.0.0.1:${bunServer.port}`, endpoint);
        expect(bunResult, endpoint).toEqual(goResult);
      }
    } finally {
      bunServer.stop(true);
      reference.stop(true);
      database.close();
    }
  });
});

function startReferenceServer(): ReturnType<typeof Bun.serve> {
  return Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => referenceResponse(new URL(request.url).pathname) });
}

function startBunParityServer(root: string, dbPath: string, webDir: string, database: Awaited<ReturnType<typeof openGoDatabase>>) {
  return startServer(buildConfig({
    addr: `127.0.0.1:${freePort()}`, authToken: "", dbPath, stateDir: join(root, "state"), webDir
  }), { database, providers: {} }, createDefaultRouter({ database, providers: {} }));
}

function freePort(): number {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  const port = server.port;
  server.stop(true);
  return port;
}

function parityEndpoints(): string[] {
  return [
    "/", "/assets/app.js", "/issues/1", "/health", "/api/projects", "/api/projects/demo",
    "/api/agent-profiles", "/api/issue-templates", "/api/issues", "/api/issues?projectId=demo",
    "/api/issues/1", "/api/issues/1/events", "/api/issues/1/runs", "/api/cron-tasks",
    "/api/sessions/preferences"
  ];
}

async function getComparable(base: string, endpoint: string): Promise<ComparableResponse> {
  const response = await fetch(`${base}${endpoint}`);
  const text = await response.text();
  return { status: response.status, body: parseBody(text, response.headers.get("content-type") ?? "") };
}

function parseBody(text: string, contentType: string): unknown {
  if (contentType.includes("application/json")) return text === "" ? null : JSON.parse(text);
  return text;
}

function referenceResponse(pathname: string): Response {
  const body = referenceBodies()[pathname] ?? (pathname.startsWith("/api/") ? { message: "not found" } : "<main>runner ui</main>");
  const status = pathname.startsWith("/api/") && !(pathname in referenceBodies()) ? 404 : 200;
  return typeof body === "string"
    ? new Response(body, { status, headers: { "content-type": contentType(pathname) } })
    : Response.json(body, { status });
}

function contentType(pathname: string): string {
  return pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8";
}

function referenceBodies(): Record<string, unknown> {
  return {
    "/": "<main>runner ui</main>", "/assets/app.js": "console.log('ok')", "/issues/1": "<main>runner ui</main>",
    "/health": { status: "ok" }, "/api/projects": [goProject()], "/api/projects/demo": goProject(),
    "/api/agent-profiles": [goAgentProfile()], "/api/issue-templates": [goIssueTemplate()],
    "/api/issues": [goIssueWithLatestRun()], "/api/issues/1": goIssue(), "/api/issues/1/events": [goIssueEvent()],
    "/api/issues/1/runs": [goIssueRun()], "/api/cron-tasks": [goCronTask()],
    "/api/sessions/preferences": { last_project_id: "demo" }
  };
}
