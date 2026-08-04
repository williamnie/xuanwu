import { afterEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { createDefaultRouter } from "./server.ts";

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
  return { cwd, database: await openDatabase({ stateDir: join(root, "state") }) };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun frontend API compatibility", () => {
  test("syncs missing local Codex workspace roots", async () => {
    const { cwd, database } = await openFixtureDatabase();
    const second = await tempDir("xuanwu-bun-sync-second-");
    const missing = join(second, "missing");
    const statePath = join(second, "codex-state.json");
    await writeFile(statePath, JSON.stringify({
      "electron-saved-workspace-roots": [cwd, second, missing],
      "active-workspace-roots": [second],
      "remote-projects": [{ hostId: "remote-ssh-discovered:claw", remotePath: "/home/xiaobei/project" }]
    }));
    const previousStatePath = Bun.env.XUANWU_CODEX_STATE;
    try {
      Bun.env.XUANWU_CODEX_STATE = statePath;
      const router = createDefaultRouter({ database });
      await requestJSON(router, "/api/projects", "POST", { id: "project", cwd }, 201);

      const result = await requestJSON(router, "/api/projects/sync/codex", "POST", {});
      const again = await requestJSON(router, "/api/projects/sync/codex", "POST", {});

      expect(result).toMatchObject({
        source: statePath,
        summary: { discovered: 4, created: 1, existing: 1, skipped: 2 },
        created: [{ id: expect.any(String), name: expect.any(String), cwd: second, auto_run: 1, pi_managed: 1, model: "codex-default" }],
        existing: [{ id: "project", cwd, auto_run: 1, pi_managed: 1 }],
        skipped: [
          { cwd: missing, reason: "path_not_found" },
          { cwd: "remote-ssh-discovered:claw:/home/xiaobei/project", reason: "remote_project" }
        ]
      });
      expect(again.summary).toMatchObject({ discovered: 4, created: 0, existing: 2, skipped: 2 });
    } finally {
      if (previousStatePath === undefined) delete Bun.env.XUANWU_CODEX_STATE;
      else Bun.env.XUANWU_CODEX_STATE = previousStatePath;
      database.close();
    }
  });

  test("skips Codex workspace roots from TCC sensitive folders", async () => {
    const { database } = await openFixtureDatabase();
    const root = await tempDir("xuanwu-bun-sync-sensitive-");
    const documents = join(root, "Documents", "safe-project");
    const downloads = join(root, "Downloads", "download-project");
    const music = join(root, "Music", "audio-project");
    const icloud = join(root, "Library", "Mobile Documents", "com~apple~CloudDocs", "cloud-project");
    const statePath = join(root, "codex-state.json");
    await mkdir(documents, { recursive: true });
    await mkdir(downloads, { recursive: true });
    await mkdir(music, { recursive: true });
    await mkdir(icloud, { recursive: true });
    await writeFile(statePath, JSON.stringify({
      "electron-saved-workspace-roots": [documents, downloads, music, icloud]
    }));
    const previousStatePath = Bun.env.XUANWU_CODEX_STATE;
    try {
      Bun.env.XUANWU_CODEX_STATE = statePath;
      const router = createDefaultRouter({ database });

      const result = await requestJSON(router, "/api/projects/sync/codex", "POST", {});

      expect(result).toMatchObject({
        summary: { discovered: 4, created: 1, existing: 0, skipped: 3 },
        created: [{ cwd: documents }],
        skipped: [
          { cwd: downloads, reason: "sensitive_folder" },
          { cwd: music, reason: "sensitive_folder" },
          { cwd: icloud, reason: "sensitive_folder" }
        ]
      });
    } finally {
      if (previousStatePath === undefined) delete Bun.env.XUANWU_CODEX_STATE;
      else Bun.env.XUANWU_CODEX_STATE = previousStatePath;
      database.close();
    }
  });

  test("covers project loop, profile, cron and reference endpoints", async () => {
    const { cwd, database } = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      const project = await requestJSON(router, "/api/projects", "POST", { id: "demo", cwd }, 201);
      const profile = await requestJSON(router, "/api/agent-profiles", "POST", { id: "Nightly Codex!", name: "Nightly", skill_intents: "[\"test\"]" }, 201);
      const patchedProfile = await requestJSON(router, "/api/agent-profiles/nightly-codex", "PATCH", { reasoning_effort: "high" });
      const projectsAfterProfile = await requestJSON(router, "/api/projects/demo", "PATCH", { default_agent_profile_id: "nightly-codex" });
      const reordered = await requestJSON(router, "/api/projects", "PATCH", { project_ids: ["demo"] });
      const started = await requestJSON(router, "/api/projects/demo/loop/start", "POST", {});
      const status = await requestJSON(router, "/api/projects/demo/loop/status", "GET");
      const stopped = await requestJSON(router, "/api/projects/demo/loop/stop", "POST", {});
      const references = await requestJSON(router, "/api/projects/demo/references/search?type=file&query=src&limit=10", "GET");
      insertHold(database, "demo");
      const resumed = await requestJSON(router, "/api/projects/demo/hold/resume", "POST", {});
      const removedTemplateRoute = await rawRequest(router, "/api/issue-templates", "POST", {});
      const cronRedirect = await rawRequest(router, "/api/cron-tasks", "POST", { project_id: "demo" });
      const capabilities = await requestJSON(router, "/api/capabilities", "GET");

      expect(project).toMatchObject({ id: "demo", cwd });
      expect(profile).toMatchObject({ id: "nightly-codex", name: "Nightly", skill_intents: "[\"test\"]" });
      expect(patchedProfile).toMatchObject({ id: "nightly-codex", reasoning_effort: "high" });
      expect(projectsAfterProfile).toMatchObject({ id: "demo", default_agent_profile_id: "nightly-codex" });
      expect((reordered as Array<Record<string, unknown>>).map((item) => item.id)).toEqual(["demo"]);
      expect(started).toEqual({ status: "running" });
      expect(status).toEqual({ status: "running" });
      expect(stopped).toEqual({ status: "stopped" });
      expect((references.files as Array<Record<string, unknown>>)[0]).toMatchObject({ type: "file", path: "src.txt" });
      expect(resumed).toMatchObject({ id: "demo" });
      expect((resumed as Record<string, unknown>).hold).toBeUndefined();
      expect(removedTemplateRoute.status).toBe(404);
      expect(cronRedirect.status).toBe(308);
      expect(cronRedirect.headers.get("location")).toBe("/api/automations");
      expect(Array.isArray(capabilities.skills)).toBe(true);
      expect(Array.isArray(capabilities.plugins)).toBe(true);
      const runnerSkill = (capabilities.skills as Array<Record<string, unknown>>).find((item) => item.id === "xuanwu");
      expect(runnerSkill).toMatchObject({
        id: "xuanwu",
        source_path: "repo:skills/xuanwu/SKILL.md"
      });
      expect(JSON.stringify(capabilities)).not.toContain(cwd);
    } finally {
      database.close();
    }
  });

  test("covers command, model, usage, upload and advisory issue endpoints", async () => {
    const { cwd, database } = await openFixtureDatabase();
    const sessionsDir = await tempDir("xuanwu-bun-empty-sessions-");
    try {
      const router = createDefaultRouter({ database, codexSessionsDir: sessionsDir });
      await requestJSON(router, "/api/projects", "POST", { id: "demo", cwd }, 201);
      const issue = await requestJSON(router, "/api/issues", "POST", { project_id: "demo", title: "Review one", status: "triage" }, 201);
      const commandIssue = await requestJSON(router, "/api/commands", "POST", { command: { name: "issue", args: { project_id: "demo" } }, prompt: "Command issue" });
      const commandRun = await requestJSON(router, "/api/commands", "POST", { command: { name: "run", args: { issue_id: commandIssue.issue.id, confirmed: true } } });
      const commandStatus = await requestJSON(router, "/api/commands", "POST", { command: { name: "status", args: { issue_id: commandIssue.issue.id } } });
      const models = await requestJSON(router, "/api/codex/models", "GET");
      const usage = await requestJSON(router, "/api/usage/codex?limit=1", "GET");
      const upload = await uploadPNG(router);
      const content = await rawRequest(router, `/api/uploads/${upload.id}/content`, "GET");
      const approval = await requestJSON(router, "/api/codex/approvals/req-1/resolve", "POST", { decision: "approved" });

      expect(commandIssue).toMatchObject({ summary: expect.stringContaining("created triage issue"), issue: { title: "Command issue" } });
      expect(commandRun).toMatchObject({ summary: expect.stringContaining("enqueued issue"), issue: { status: "todo" } });
      expect(commandStatus).toMatchObject({ summary: expect.stringContaining("issue #"), issue: { id: commandIssue.issue.id } });
      expect(models).toMatchObject({ data: expect.any(Array) });
      expect(usage).toMatchObject({ events_scanned: expect.any(Number), summary: expect.any(Object) });
      expect(upload).toMatchObject({ mime_type: "image/png", url: `/api/uploads/${upload.id}/content` });
      expect(content.status).toBe(200);
      expect(content.headers.get("content-type")).toContain("image/png");
      expect(approval).toEqual({ ok: true });
    } finally {
      database.close();
    }
  });

  test("serves Codex clipboard session images through a restricted proxy", async () => {
    const { cwd, database } = await openFixtureDatabase();
    const tempRoot = await tempDir("xuanwu-bun-session-image-");
    const imagePath = join(tempRoot, "codex-clipboard-test.png");
    await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
    try {
      const router = createDefaultRouter({ database });
      const image = await rawRequest(router, `/api/session-images?path=${encodeURIComponent(imagePath)}`, "GET");
      const rejected = await rawRequest(router, `/api/session-images?path=${encodeURIComponent(join(cwd, "src.txt"))}`, "GET");

      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toContain("image/png");
      expect(await image.arrayBuffer()).toHaveProperty("byteLength", 68);
      expect(rejected.status).toBe(400);
    } finally {
      database.close();
    }
  });

  test("downgrades compatibility approval session resolve to turn scope", async () => {
    const { database } = await openFixtureDatabase();
    const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
    try {
      const router = createDefaultRouter({
        database,
        providers: { codex: approvalProvider(resolutions) }
      });

      const approval = await requestJSON(router, "/api/codex/approvals/req-session/resolve", "POST", {
        decision: "approve_session",
        scope: "session"
      });

      expect(approval).toEqual({ ok: true });
      expect(resolutions).toEqual([{ decision: "approve", id: "req-session", scope: "turn" }]);
    } finally {
      database.close();
    }
  });

  test("lists notifications and marks them read", async () => {
    const { cwd, database } = await openFixtureDatabase();
    try {
      const router = createDefaultRouter({ database });
      await requestJSON(router, "/api/projects", "POST", { id: "demo", cwd }, 201);
      const issue = await requestJSON(router, "/api/issues", "POST", {
        project_id: "demo",
        status: "failed",
        title: "Needs user"
      }, 201);
      insertNotification(database, issue.id, "demo");

      const notifications = await requestJSON(router, "/api/notifications?project_id=demo&unread=1", "GET");
      const read = await requestJSON(router, `/api/notifications/${notifications[0].id}/read`, "POST", {});
      const unread = await requestJSON(router, "/api/notifications?project_id=demo&unread=1", "GET");

      expect(notifications).toMatchObject([
        { event: "pi.needs_user", issue_id: issue.id, project_id: "demo", read_at: "" }
      ]);
      expect(read).toMatchObject({ id: notifications[0].id, read_at: expect.any(String) });
      expect(read.read_at).not.toBe("");
      expect(unread).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("reads Codex usage from configured sessions dir", async () => {
    const { database } = await openFixtureDatabase();
    const sessionsDir = await tempDir("xuanwu-bun-sessions-");
    const usagePath = await writeUsageJSONL(sessionsDir, "2026/05/31/session.jsonl", [
      `{"timestamp":"2026-05-31T08:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}`
    ]);
    try {
      const router = createDefaultRouter({
        database,
        codexSessionsDir: sessionsDir,
        providers: { codex: usageProvider("codex"), claude: usageProvider("claude") }
      });

      const usage = await requestJSON(router, "/api/usage/codex?refresh=1", "GET");
      const providerUsage = await requestJSON(router, "/api/usage/providers?compact=1&refresh=1", "GET");

      expect(usage).toMatchObject({
        source: sessionsDir,
        events_scanned: 1,
        pi_usage: {
          completeness: "complete",
          sessions_scanned: 0,
          status: "available",
          summary: { today: { total_tokens: 0 } }
        },
        summary: { all_time: { total_tokens: 15 } },
        latest_usage: { last_token_usage: { total_tokens: 15 } }
      });
      expect(providerUsage).toMatchObject({
        providers: [{
          compact: true,
          events_scanned: 1,
          provider: { id: "codex", scope: "local_sessions" },
          summary: { all_time: { total_tokens: 15 } }
        }, {
          events_scanned: 0,
          provider: { id: "claude", scope: "runner_attempts" },
          rate_limits: null
        }]
      });

      await appendFile(usagePath,
        `{"timestamp":"2026-05-31T09:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":4,"output_tokens":3,"total_tokens":7}}}}\n`);
      const refreshed = await requestJSON(router, "/api/usage/codex?compact=1&refresh=1", "GET");
      expect(refreshed).toMatchObject({
        compact: true,
        events_scanned: 2,
        project_usage: [],
        summary: { all_time: { total_tokens: 22 } }
      });
    } finally {
      database.close();
    }
  });
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

async function requestError(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  method: string,
  body?: Record<string, unknown>
): Promise<any> {
  return await requestJSON(router, path, method, body, 400);
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
