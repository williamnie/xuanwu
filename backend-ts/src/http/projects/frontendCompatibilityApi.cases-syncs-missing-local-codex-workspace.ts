import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./frontendCompatibilityApi.testFixture.ts";

export function registerSyncsMissingLocalCodexWorkspaceCases(testScope: TestFixture) {
  const { openFixtureDatabase, requestJSON, approvalProvider, rawRequest, uploadPNG, insertHold, tempDir } = testScope;
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
  
  test("previews Codex import read-only before syncing", async () => {
      const { cwd, database } = await openFixtureDatabase();
      const second = await tempDir("xuanwu-bun-sync-preview-");
      const statePath = join(second, "codex-state.json");
      const previousStatePath = Bun.env.XUANWU_CODEX_STATE;
      try {
        const router = createDefaultRouter({ database });
        Bun.env.XUANWU_CODEX_STATE = join(second, "absent.json");
        expect(await requestJSON(router, "/api/projects/sync/codex/preview", "GET"))
          .toEqual({ available: false, reason: "state_not_found" });
        await writeFile(statePath, "{not json");
        Bun.env.XUANWU_CODEX_STATE = statePath;
        expect(await requestJSON(router, "/api/projects/sync/codex/preview", "GET"))
          .toEqual({ available: false, reason: "state_unreadable" });
  
        await writeFile(statePath, JSON.stringify({
          "electron-saved-workspace-roots": [cwd, second, join(second, "missing")]
        }));
        await requestJSON(router, "/api/projects", "POST", { id: "project", cwd }, 201);
        database.sqlite.run("update projects set auto_run=0 where id='project'");
        const before = database.sqlite.query("select id, auto_run, updated_at from projects order by id").all();
        const preview = await requestJSON(router, "/api/projects/sync/codex/preview", "GET");
        expect(preview).toEqual({ available: true, summary: { discovered: 3, new: 1, existing: 1, enable_auto_run: 1, skipped: 1 } });
        expect(database.sqlite.query("select id, auto_run, updated_at from projects order by id").all()).toEqual(before);
  
        await requestJSON(router, "/api/projects/sync/codex", "POST", {});
        expect((await requestJSON(router, "/api/projects/sync/codex/preview", "GET")).summary)
          .toEqual({ discovered: 3, new: 0, existing: 2, enable_auto_run: 0, skipped: 1 });
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
      const router = createDefaultRouter({ database });
      const project = await requestJSON(router, "/api/projects", "POST", { id: "demo", cwd }, 201);
      const profile = await requestJSON(router, "/api/agent-profiles", "POST", { id: "Nightly Codex!", name: "Nightly", skill_intents: "[\"test\"]" }, 201);
      const piProfile = await requestJSON(router, "/api/agent-profiles", "POST", { id: "Pi Review", name: "Pi Review", provider: "pi-coding-agent", model: "" }, 201);
      const qoderProfile = await requestJSON(router, "/api/agent-profiles", "POST", { id: "Qoder Performance", name: "Qoder Performance", provider: "qoder", model: "performance", reasoning_effort: "high" }, 201);
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
      expect(piProfile).toMatchObject({ id: "pi-review", provider: "pi-coding-agent", model: "" });
      expect(qoderProfile).toMatchObject({ id: "qoder-performance", provider: "qoder", model: "performance", reasoning_effort: "high" });
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
    });
  
  test("covers command, model, usage, upload and advisory issue endpoints", async () => {
      const { cwd, database } = await openFixtureDatabase();
      const sessionsDir = await tempDir("xuanwu-bun-empty-sessions-");
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
    });
  
  test("serves Codex clipboard session images through a restricted proxy", async () => {
      const { cwd, database } = await openFixtureDatabase();
      const tempRoot = await tempDir("xuanwu-bun-session-image-");
      const imagePath = join(tempRoot, "codex-clipboard-test.png");
      await writeFile(imagePath, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=", "base64"));
      const router = createDefaultRouter({ database });
      const image = await rawRequest(router, `/api/session-images?path=${encodeURIComponent(imagePath)}`, "GET");
      const rejected = await rawRequest(router, `/api/session-images?path=${encodeURIComponent(join(cwd, "src.txt"))}`, "GET");
  
      expect(image.status).toBe(200);
      expect(image.headers.get("content-type")).toContain("image/png");
      expect(await image.arrayBuffer()).toHaveProperty("byteLength", 68);
      expect(rejected.status).toBe(400);
    });
  
  test("downgrades compatibility approval session resolve to turn scope", async () => {
      const { database } = await openFixtureDatabase();
      const resolutions: Array<{ decision: string; id: string; scope: string }> = [];
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
    });
}
