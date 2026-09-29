import { afterEach, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, loadConfig, ENV_KEYS } from "../config/env.ts";
import { localSettingsPath, updateLocalSettingsFile } from "../config/localSettings.ts";
import { openDatabase } from "../db/database.ts";
import { createProject } from "../db/repositories/projects.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { GitHubIssueClient } from "../integrations/github/issueClient.ts";
import { GitHubIssueSyncRuntime } from "../integrations/github/issueSyncRuntime.ts";
import { observeGitHubIssue, updateGitHubIssueCase } from "../integrations/github/issueCaseStore.ts";
import { registerGitHubSettingsRoutes, type GitHubSettingsResponse } from "./githubSettingsApi.ts";
import { createRouter } from "./router.ts";
import { createDefaultRouter, createRequestHandler } from "./server.ts";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-976-"));
  const db = await openDatabase({ stateDir: root });
  const config = buildConfig({ stateDir: root });
  createProject(db, { id: "project", name: "Fixture", cwd: root });
  const calls: string[] = [];
  let responseStatus = 200;
  let label = "xuanwu";
  const client = new GitHubIssueClient({ apiBaseUrl: "https://api.github.com", token: async () => "fixture-secret", fetch: async (url, init) => {
    calls.push(`${init?.method} ${new URL(String(url)).pathname}`);
    if (responseStatus !== 200) return new Response("must-not-echo", { status: responseStatus });
    const pathname = new URL(String(url)).pathname;
    if (pathname === "/user") return Response.json({ login: "fixture-bot" });
    if (pathname.endsWith("/comments")) return Response.json(init?.method === "GET" ? [] : { id: 1 });
    if (pathname.endsWith("/issues")) return Response.json([{ node_id: "fixture-new", number: 1, title: "Fixture", body: "Expected fixture", state: "open", html_url: "https://github.com/owner/repo/issues/1", updated_at: new Date().toISOString(), labels: [{ name: "xuanwu" }], user: { login: "fixture" } }]);
    return Response.json(new URL(String(url)).pathname.includes("/labels/") ? { name: label } : { id: 7, full_name: "owner/repo", permissions: { pull: true, push: true } });
  } });
  const runtime = new GitHubIssueSyncRuntime({ config: config.integrations.github, stateDir: root, runtime: { database: db }, client });
  const router = createRouter();
  registerGitHubSettingsRoutes(router, { config, database: db, githubIssueSync: runtime, clientFactory: () => client });
  cleanup.push(async () => { await runtime.stop(); db.close(); await rm(root, { recursive: true, force: true }); });
  const request = async (suffix = "settings", method = "GET", body?: unknown) => router.handle(new Request(`http://localhost/api/integrations/trackers/github/${suffix}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const get = async () => read(await request());
  const draft = { ...config.integrations.github.issueSync, enabled: true, repositories: [{ repository: "owner/repo", projectId: "project", intakeLabel: "xuanwu", autoEnqueue: false, allowFix: false, allowPullRequest: false, closeOnMerge: false }] };
  return { root, db, config, runtime, request, get, draft, calls, setStatus: (value: number) => { responseStatus = value; }, setLabel: (value: string) => { label = value; } };
}

test("save preserves credentials/other settings, stays pending, applies explicitly and survives reload", async () => {
  const f = await fixture();
  await updateLocalSettingsFile(localSettingsPath(f.root), () => ({ providers: { codex: { enabled: true } }, integrations: { github: { tokenRef: "env://FIXTURE_GITHUB", issueSync: { jev: { enabled: false } } } } }));
  const before = await f.get();
  const saved = await f.request("settings", "PUT", { revision: before.revision, settings: f.draft });
  expect(saved.status).toBe(200);
  const data = await read(saved);
  expect(data.application.status).toBe("pending");
  expect(f.runtime.snapshot().enabled).toBe(false);
  expect(f.calls).toEqual([]);
  const persisted = JSON.parse(await readFile(localSettingsPath(f.root), "utf8"));
  expect(persisted.providers.codex.enabled).toBe(true);
  expect(persisted.integrations.github.tokenRef).toBe("env://FIXTURE_GITHUB");
  expect(persisted.integrations.github.issueSync.jev).toEqual({ enabled: false });
  expect(persisted.integrations.github.token).toBeUndefined();
  expect(loadConfig([], { [ENV_KEYS.stateDir]: f.root, FIXTURE_GITHUB: "fixture-value" }).integrations.github.issueSync.enabled).toBe(true);
  const applied = await f.request("reload", "POST", { revision: data.revision });
  expect(applied.status).toBe(200);
  expect((await read(applied)).application.status).toBe("applied");
  expect((await f.get()).permissions).toMatchObject({ merge: false, deploy: false });
});

test("simultaneous saves conflict and unrelated settings updates are preserved", async () => {
  const f = await fixture();
  const before = await f.get();
  const responses = await Promise.all([
    f.request("settings", "PUT", { revision: before.revision, settings: f.draft }),
    f.request("settings", "PUT", { revision: before.revision, settings: { ...f.draft, pollIntervalSeconds: 120 } })
  ]);
  expect(responses.slice(0, 2).map(r => (r as Response).status).sort()).toEqual([200, 409]);
  await Promise.all([
    updateLocalSettingsFile(localSettingsPath(f.root), value => ({ ...value, runner: { maxParallelProjects: 3 } })),
    updateLocalSettingsFile(localSettingsPath(f.root), value => ({ ...value, providers: { codex: { enabled: true } } }))
  ]);
  const persisted = JSON.parse(await readFile(localSettingsPath(f.root), "utf8"));
  expect(persisted.providers.codex.enabled).toBe(true);
  expect(persisted.runner.maxParallelProjects).toBe(3);
  expect(persisted.integrations.github.issueSync.enabled).toBe(true);
});

test("strict input rejects hidden grants, tokens, wrong types and unknown projects", async () => {
  const f = await fixture();
  for (const settings of [
    { ...f.draft, token: "secret" }, { ...f.draft, enabled: "true" },
    { ...f.draft, auth: { mode: "connector", privateKeyRef: "secret-value" } },
    { ...f.draft, repositories: [{ ...f.draft.repositories[0], allowMerge: true }] },
    { ...f.draft, repositories: [{ ...f.draft.repositories[0], projectId: "missing" }] }
  ]) {
    expect((await f.request("settings", "PUT", { revision: (await f.get()).revision, settings })).status).toBe(400);
  }
  expect((await f.get()).settings.enabled).toBe(false);
});

test("connection probe is read only, does not save, distinguishes denied, inaccessible and label mismatch", async () => {
  const f = await fixture();
  const before = await f.get();
  const probe = async () => (await f.request("test", "POST", { settings: f.draft })).json() as Promise<{ repositories: Array<{ status: string; write_permission: string }> }>;
  expect((await probe()).repositories[0]).toMatchObject({ status: "connected", write_permission: "unverified" });
  expect(f.calls.every(call => call.startsWith("GET "))).toBe(true);
  f.setStatus(403);
  expect((await probe()).repositories[0].status).toBe("permission_denied");
  f.setStatus(404);
  expect((await probe()).repositories[0].status).toBe("repository_unavailable");
  f.setStatus(200); f.setLabel("different");
  expect((await probe()).repositories[0].status).toBe("label_mismatch");
  expect((await f.get()).revision).toBe(before.revision);
  expect(JSON.stringify(await probe())).not.toContain("fixture-secret");
});

test("reload failure keeps saved settings pending and preserves running configuration", async () => {
  const f = await fixture();
  const saved = await read(await f.request("settings", "PUT", { revision: (await f.get()).revision, settings: f.draft }));
  f.runtime.reload = () => { throw new Error("private-runtime-diagnostic"); };
  const failed = await f.request("reload", "POST", { revision: saved.revision });
  expect(failed.status).toBe(409);
  expect(await failed.text()).toContain("reload_failed");
  expect((await f.get()).application.status).toBe("pending");
  expect(f.config.integrations.github.issueSync.enabled).toBe(false);
});

test("Case status shows stages, waiting Work, label withdrawal and mapping conflicts without changing data", async () => {
  const f = await fixture();
  const issue = createIssue(f.db, { project_id: "project", title: "fixture", status: "needs_user" });
  for (const [index, stage] of ["investigate", "repair", "review", "paused", "resolved"].entries()) {
    const nodeId = `node-${index}`;
    observeGitHubIssue(f.db, { nodeId, repositoryId: 7, repository: "owner/repo", number: index + 1, title: "fixture", body: "private", author: "fixture", url: "https://github.com/owner/repo/issues/1", state: "open", stateReason: "", updatedAt: new Date().toISOString(), labels: index === 3 ? [] : ["xuanwu"] }, "project");
    updateGitHubIssueCase(f.db, nodeId, 1, { stage: stage as "review", issue_id: index === 0 ? issue.id : null, pull_request_number: index === 2 ? 10 : null });
  }
  await f.request("settings", "PUT", { revision: (await f.get()).revision, settings: f.draft });
  const data = await f.get();
  data.repositories[0].cases.sort((a: { issue_number: number }, b: { issue_number: number }) => a.issue_number - b.issue_number);
  expect(data.repositories[0].cases.map((c: { phase: string }) => c.phase)).toEqual(["needs_user", "repair", "review", "paused", "resolved"]);
  expect(data.repositories[0].cases[3].intake_status).toBe("label_mismatch");
  expect(data.repositories[0].cases[2].pull_request_number).toBe(10);
  expect(JSON.stringify(data)).not.toContain('"body":"private"');
  createProject(f.db, { id: "other", name: "Other", cwd: tmpdir() });
  const conflicting = { ...f.draft, repositories: [{ ...f.draft.repositories[0], projectId: "other" }] };
  expect((await f.request("settings", "PUT", { revision: data.revision, settings: conflicting })).status).toBe(409);
});

test("routes require existing bearer auth; credentials never returned", async () => {
  const f = await fixture();
  f.config.integrations.github.token = "private-token";
  const handler = createRequestHandler(createDefaultRouter({ config: f.config, database: f.db, githubIssueSync: f.runtime }), "fixture-bearer");
  for (const [suffix, method] of [["settings", "GET"], ["settings", "PUT"], ["reload", "POST"], ["test", "POST"]]) {
    expect((await handler(new Request(`http://localhost/api/integrations/trackers/github/${suffix}`, { method }))).status).toBe(401);
  }
  const result = await handler(new Request("http://localhost/api/integrations/trackers/github/settings", { headers: { authorization: "Bearer fixture-bearer" } }));
  expect(result.status).toBe(200);
  expect(await result.text()).not.toContain("private-token");
});


test("saved mapping to fixture intake to Case status forms an isolated creation flow", async () => {
  const f = await fixture();
  const saved = await read(await f.request("settings", "PUT", { revision: (await f.get()).revision, settings: f.draft }));
  expect((await f.request("reload", "POST", { revision: saved.revision })).status).toBe(200);
  await f.runtime.sync();
  const status = await f.get();
  expect(status.application.status).toBe("applied");
  expect(status.repositories[0].cases).toHaveLength(1);
  expect(status.repositories[0].cases[0]).toMatchObject({ phase: "investigate", work_status: "triage", intake_status: "matched", project_id: "project" });
  expect(status.repositories[0].cases[0].issue_id).toBeGreaterThan(0);
  expect(f.db.sqlite.query("select count(*) as count from issue_runs").get()).toEqual({ count: 0 });
});

function read(response: Response) { return response.json() as Promise<GitHubSettingsResponse>; }


test("filesystem permission failure is explicit and a later save can recover", async () => {
  const f = await fixture();
  const revision = (await f.get()).revision;
  await chmod(f.root, 0o500);
  try {
    const failed = await f.request("settings", "PUT", { revision, settings: f.draft });
    expect(failed.status).toBe(403);
    expect(await failed.text()).toContain("settings_permission_denied");
    expect((await f.get()).settings.enabled).toBe(false);
  } finally { await chmod(f.root, 0o700); }
  expect((await f.request("settings", "PUT", { revision, settings: f.draft })).status).toBe(200);
  expect((await stat(localSettingsPath(f.root))).mode & 0o777).toBe(0o600);
});

test("stale apply rejects without mutation and absent runtime remains explicitly unavailable", async () => {
  const f = await fixture();
  const before = await f.get();
  await f.request("settings", "PUT", { revision: before.revision, settings: f.draft });
  expect((await f.request("reload", "POST", { revision: before.revision })).status).toBe(409);
  expect(f.runtime.configuration().enabled).toBe(false);
  const router = createRouter();
  registerGitHubSettingsRoutes(router, { database: f.db, config: f.config });
  const response = await router.handle(new Request("http://localhost/api/integrations/trackers/github/settings"));
  expect((await read(response)).application.status).toBe("unavailable");
  const unavailable = await router.handle(new Request("http://localhost/api/integrations/trackers/github/reload", { method: "POST", body: JSON.stringify({ revision: (await f.get()).revision }) }));
  expect(unavailable.status).toBe(503);
});
