import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import type { ExecutorProvider, ProviderRunInput } from "../../providers/types.ts";
import { createDefaultRouter } from "../server.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";



export function createTestFixture() {
  const trackDatabase = useDatabaseCleanup();

  const BASE_URL = "http://127.0.0.1:3008";

  const tempRoots: string[] = [];

  async function openFixtureDatabase(): Promise<{ cwd: string; database: RunnerDatabase }> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-frontend-api-"));
    const cwd = join(root, "project");
    tempRoots.push(root);
    await writeFile(join(cwd, "src.txt"), "reference text", { flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await Bun.$`mkdir -p ${cwd}`.quiet();
      await writeFile(join(cwd, "src.txt"), "reference text");
    });
    return { cwd, database: await openDatabase({ stateDir: join(root, "state") }).then(trackDatabase) };
  }

  afterEach(async () => {
    while (tempRoots.length > 0) {
      const path = tempRoots.pop();
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  async function requestJSON(
    router: ReturnType<typeof createDefaultRouter>,
    path: string,
    method: string,
    body?: Record<string, unknown>,
    expectedStatus = 200
  ): Promise<any> {
    const response = await rawRequest(router, path, method, body);
    expect(response.status).toBe(expectedStatus);
    return await response.json();
  }

  function approvalProvider(resolutions: Array<{ decision: string; id: string; scope: string }>): ExecutorProvider {
    return {
      capabilities: ["approvals"],
      id: "codex",
      async run(_input: ProviderRunInput): Promise<never> {
        throw new Error("not implemented");
      },
      async resolveApproval(id, decision) {
        resolutions.push({ id, decision: decision.decision, scope: decision.scope ?? "" });
      }
    };
  }

  function usageProvider(id: "claude" | "codex"): ExecutorProvider {
    return {
      capabilities: ["issue_execution"],
      id,
      async run(_input: ProviderRunInput): Promise<never> {
        throw new Error("not implemented");
      }
    };
  }

  function rawRequest(
    router: ReturnType<typeof createDefaultRouter>,
    path: string,
    method: string,
    body?: Record<string, unknown>
  ): Promise<Response> {
    return router.handle(new Request(`${BASE_URL}${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" }
    }));
  }

  async function uploadPNG(router: ReturnType<typeof createDefaultRouter>): Promise<Record<string, unknown>> {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64");
    const form = new FormData();
    form.append("file", new File([png], "one.png", { type: "image/png" }));
    const response = await router.handle(new Request(`${BASE_URL}/api/uploads/images`, { method: "POST", body: form }));
    expect(response.status).toBe(201);
    return await response.json() as Record<string, unknown>;
  }

  function insertHold(db: RunnerDatabase, projectId: string): void {
    db.sqlite.run(`insert into project_holds
    (project_id, reason, message, hold_since, updated_at) values (?, ?, ?, ?, ?)`,
      [projectId, "manual", "waiting", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]);
  }

  function insertNotification(db: RunnerDatabase, issueID: number, projectID: string): void {
    db.sqlite.run(
      `insert into notifications
      (event, project_id, issue_id, dedupe_key, title, message, payload, created_at, read_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["pi.needs_user", projectID, issueID, `pi.needs_user:${projectID}:${issueID}`,
        "Needs user", "Please review", "{}", "2026-01-01T00:00:00Z", ""]
    );
  }

  async function tempDir(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    tempRoots.push(root);
    return root;
  }

  async function writeUsageJSONL(root: string, name: string, lines: string[]): Promise<string> {
    const path = join(root, ...name.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, `${lines.join("\n")}\n`);
    return path;
  }
  return { trackDatabase, BASE_URL, tempRoots, openFixtureDatabase, requestJSON, approvalProvider, usageProvider, rawRequest, uploadPNG, insertHold, insertNotification, tempDir, writeUsageJSONL };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
