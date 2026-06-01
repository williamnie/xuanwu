import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3018";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<{ cwd: string; database: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-frontend-api-"));
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
  test("covers project loop, profile, template, cron, notification and reference endpoints", async () => {
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
      await requestJSON(router, "/api/issue-templates", "POST", { id: "default", name: "Default", content: "{{issue.description}}", is_default: 1 }, 201);
      const template = await requestJSON(router, "/api/issue-templates", "POST", { id: "Custom Template", name: "Custom", content: "{{issue.title}}" }, 201);
      const patchedTemplate = await requestJSON(router, "/api/issue-templates/custom-template", "PATCH", { is_default: 1 });
      const deletedTemplate = await rawRequest(router, "/api/issue-templates/custom-template", "DELETE");
      const cron = await requestJSON(router, "/api/cron-tasks", "POST", { project_id: "demo", mode: "once", next_run_at: "2999-01-01T00:00:00Z" }, 201);
      const pausedCron = await requestJSON(router, `/api/cron-tasks/${cron.id}`, "PATCH", { status: "paused" });
      const deletedCron = await rawRequest(router, `/api/cron-tasks/${cron.id}`, "DELETE");
      const settings = await requestJSON(router, "/api/notifications/settings", "PATCH", { events: ["done"], active_start: "09:00", active_end: "18:30" });
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
      expect(template).toMatchObject({ id: "custom-template", name: "Custom" });
      expect(patchedTemplate).toMatchObject({ id: "custom-template", is_default: 1 });
      expect(deletedTemplate.status).toBe(204);
      expect(cron).toMatchObject({ id: expect.any(Number), project_id: "demo", status: "active" });
      expect(pausedCron).toMatchObject({ id: cron.id, status: "paused" });
      expect(deletedCron.status).toBe(204);
      expect(settings).toMatchObject({ events: ["done"], active_start: "09:00", active_end: "18:30" });
      expect(capabilities).toMatchObject({ skills: expect.any(Array), plugins: expect.any(Array) });
    } finally {
      database.close();
    }
  });

  test("covers nightly batch, command, model, usage, upload and advisory issue endpoints", async () => {
    const { cwd, database } = await openFixtureDatabase();
    const sessionsDir = await tempDir("codex-runner-bun-empty-sessions-");
    try {
      const router = createDefaultRouter({ database, codexSessionsDir: sessionsDir });
      await requestJSON(router, "/api/projects", "POST", { id: "demo", cwd }, 201);
      const issue = await requestJSON(router, "/api/issues", "POST", { project_id: "demo", title: "Nightly one", status: "triage" }, 201);
      const issueTwo = await requestJSON(router, "/api/issues", "POST", { project_id: "demo", title: "Nightly two", status: "triage" }, 201);
      const batch = await requestJSON(router, "/api/nightly-batches", "POST", { project_id: "demo", issue_ids: [issue.id, issueTwo.id], policy: "fail_stop" }, 201);
      const commandIssue = await requestJSON(router, "/api/commands", "POST", { command: { name: "issue", args: { project_id: "demo" } }, prompt: "Command issue" });
      const commandRun = await requestJSON(router, "/api/commands", "POST", { command: { name: "run", args: { issue_id: commandIssue.issue.id, confirmed: true } } });
      const commandStatus = await requestJSON(router, "/api/commands", "POST", { command: { name: "status", args: { issue_id: commandIssue.issue.id } } });
      const draft = await requestJSON(router, `/api/issues/${issueTwo.id}/refinement-draft`, "POST", {}, 201);
      await requestJSON(router, `/api/issues/${issue.id}`, "PATCH", { status: "pending_verification", error: "build passed; smoke missing" });
      const verifier = await requestJSON(router, `/api/issues/${issue.id}/verifier-report`, "POST", {}, 201);
      const models = await requestJSON(router, "/api/codex/models", "GET");
      const usage = await requestJSON(router, "/api/usage/codex?limit=1", "GET");
      const upload = await uploadPNG(router);
      const content = await rawRequest(router, `/api/uploads/${upload.id}/content`, "GET");
      const approval = await requestJSON(router, "/api/codex/approvals/req-1/resolve", "POST", { decision: "approved" });

      expect(batch).toMatchObject({ project_id: "demo", current_issue_id: issue.id, status: "active" });
      expect((batch.items as Array<Record<string, unknown>>)[0]).toMatchObject({ issue_id: issue.id, status: "current" });
      expect(commandIssue).toMatchObject({ summary: expect.stringContaining("created triage issue"), issue: { title: "Command issue" } });
      expect(commandRun).toMatchObject({ summary: expect.stringContaining("enqueued issue"), issue: { status: "todo" } });
      expect(commandStatus).toMatchObject({ summary: expect.stringContaining("issue #"), issue: { id: commandIssue.issue.id } });
      expect(draft).toMatchObject({ draft: { acceptanceCriteria: expect.any(String), verificationPlan: expect.any(String) } });
      expect(verifier).toMatchObject({ report: { recommendation: expect.any(String) }, event: { type: "issue.verification_report" } });
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

  test("reads Codex usage from configured sessions dir", async () => {
    const { database } = await openFixtureDatabase();
    const sessionsDir = await tempDir("codex-runner-bun-sessions-");
    await writeUsageJSONL(sessionsDir, "2026/05/31/session.jsonl", [
      `{"timestamp":"2026-05-31T08:00:00Z","type":"event_msg","payload":{"type":"token_count","info":{"last_token_usage":{"input_tokens":10,"output_tokens":5,"total_tokens":15}}}}`
    ]);
    try {
      const router = createDefaultRouter({ database, codexSessionsDir: sessionsDir });

      const usage = await requestJSON(router, "/api/usage/codex", "GET");

      expect(usage).toMatchObject({
        source: sessionsDir,
        events_scanned: 1,
        summary: { all_time: { total_tokens: 15 } },
        latest_usage: { last_token_usage: { total_tokens: 15 } }
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

async function tempDir(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

async function writeUsageJSONL(root: string, name: string, lines: string[]): Promise<void> {
  const path = join(root, ...name.split("/"));
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${lines.join("\n")}\n`);
}
