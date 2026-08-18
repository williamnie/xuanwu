import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildConfig } from "../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { createProject } from "../db/repositories/projects.ts";
import { createProviderRegistry, type ProviderFactory } from "../providers/core/registry.ts";
import { asProviderId, type ExecutorProvider } from "../providers/types.ts";
import { qoderFactory } from "../providers/qoder/factory.ts";
import { createFakeQoderSdkFacade } from "../providers/qoder/sdkFacade.ts";
import type { QoderRuntimeProbe } from "../providers/qoder/runtime.ts";
import { createDefaultRouter } from "./server.ts";

const roots: string[] = [];
const BASE_URL = "http://127.0.0.1/api/code-agents";

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Code Agents API", () => {
  test("discovers, disables, persists and re-enables a managed code agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-code-agents-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    let installed = true;
    try {
      const config = buildConfig({ stateDir, dbPath: database.path });
      const registry = createProviderRegistry();
      registry.registerFactory(codexFactory(() => installed));
      await registry.startConfigured(config.providers);
      const providers = registry.readyProviders();
      const router = createDefaultRouter({ config, database, providers, providersRegistry: registry });

      const initial = await request(router, BASE_URL);
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        agents: [{ id: "codex", enabled: true, state: "ready", submittable: true }],
        available_ids: ["codex"]
      });

      const disabled = await request(router, `${BASE_URL}/codex`, "PATCH", { enabled: false });
      expect(disabled.status).toBe(200);
      expect(await disabled.json()).toMatchObject({
        agents: [{ id: "codex", enabled: false, state: "disabled", submittable: false }],
        available_ids: []
      });
      expect(providers.codex).toBeUndefined();
      expect(JSON.parse(await readFile(join(stateDir, "runner-settings.local.json"), "utf8"))).toMatchObject({
        providers: { codex: { enabled: false } }
      });

      installed = false;
      const unavailable = await request(router, `${BASE_URL}/codex`, "PATCH", { enabled: true });
      expect(await unavailable.json()).toMatchObject({
        agents: [{ id: "codex", enabled: true, state: "not_ready", submittable: false }]
      });
      expect(providers.codex).toBeUndefined();

      installed = true;
      const discovered = await request(router, `${BASE_URL}/discover`, "POST", {});
      expect(await discovered.json()).toMatchObject({
        agents: [{ id: "codex", enabled: true, state: "ready", submittable: true }],
        available_ids: ["codex"]
      });
      expect(providers.codex).toBeDefined();
    } finally {
      database.close();
    }
  });

  test("rejects unknown agents and non-boolean enabled values", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-code-agents-invalid-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    try {
      const config = buildConfig({ stateDir, dbPath: database.path });
      const registry = createProviderRegistry();
      registry.registerFactory(codexFactory(() => true));
      await registry.startConfigured(config.providers);
      const router = createDefaultRouter({ config, database, providers: registry.readyProviders(), providersRegistry: registry });

      expect((await request(router, `${BASE_URL}/unknown`, "PATCH", { enabled: true })).status).toBe(404);
      expect((await request(router, `${BASE_URL}/codex`, "PATCH", { enabled: "yes" })).status).toBe(400);
    } finally {
      database.close();
    }
  });

  test("lists Qoder as managed but not submittable when CLI or auth is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-code-agents-qoder-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    let ready = false;
    try {
      const config = buildConfig({ stateDir, dbPath: database.path });
      const registry = createProviderRegistry();
      registry.registerFactory(qoderFactory({
        facade: createFakeQoderSdkFacade([]).facade,
        runtimeProbe: () => qoderProbe(ready)
      }));
      await registry.startConfigured(config.providers);
      const providers = registry.readyProviders();
      const router = createDefaultRouter({ config, database, providers, providersRegistry: registry });

      const initial = await request(router, BASE_URL);
      expect(await initial.json()).toMatchObject({
        agents: [{
          id: "qoder",
          state: "not_ready",
          submittable: false,
          readiness_reason: "Qoder CLI/auth fixture is missing",
          runtime: {
            auth_configured: false,
            executable_ready: false,
            ready: false,
            platform_profile: {
              cli_version: "",
              protocol_status: "unavailable",
              sdk_version: "1.0.23"
            }
          }
        }],
        available_ids: []
      });
      expect(providers.qoder).toBeUndefined();

      ready = true;
      const discovered = await request(router, `${BASE_URL}/discover`, "POST", {});
      expect(await discovered.json()).toMatchObject({
        agents: [{ id: "qoder", state: "ready", submittable: true }],
        available_ids: ["qoder"]
      });
      expect(providers.qoder).toBeDefined();

      const disabled = await request(router, `${BASE_URL}/qoder`, "PATCH", { enabled: false });
      expect(await disabled.json()).toMatchObject({
        agents: [{ id: "qoder", enabled: false, state: "disabled", submittable: false }],
        available_ids: []
      });
      expect(JSON.parse(await readFile(join(stateDir, "runner-settings.local.json"), "utf8"))).toMatchObject({
        providers: { qoder: { enabled: false } }
      });
    } finally {
      database.close();
    }
  });

  test("refuses to disable a Code Agent with an active Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-code-agents-active-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    try {
      createProject(database, { cwd: root, id: "demo", name: "Demo", provider: "codex" });
      const issue = createIssue(database, { project_id: "demo", status: "in_progress", title: "Active" });
      createIssueRun(database, issue.id);
      const config = buildConfig({ stateDir, dbPath: database.path });
      const registry = createProviderRegistry();
      registry.registerFactory(codexFactory(() => true));
      await registry.startConfigured(config.providers);
      const providers = registry.readyProviders();
      const router = createDefaultRouter({ config, database, providers, providersRegistry: registry });

      const response = await request(router, `${BASE_URL}/codex`, "PATCH", { enabled: false });
      expect(response.status).toBe(409);
      expect(registry.describe(asProviderId("codex")).state).toBe("ready");
      expect(providers.codex).toBeDefined();
    } finally {
      database.close();
    }
  });

  test("refuses to disable Qoder with an active Run", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-code-agents-qoder-active-"));
    roots.push(root);
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    try {
      createProject(database, { cwd: root, id: "demo", name: "Demo", provider: "qoder" });
      const issue = createIssue(database, { project_id: "demo", status: "in_progress", title: "Active Qoder" });
      const run = createIssueRun(database, issue.id);
      database.sqlite.query("update issue_runs set provider='qoder' where id=?").run(run.id);
      const config = buildConfig({ stateDir, dbPath: database.path });
      const registry = createProviderRegistry();
      registry.registerFactory(qoderFactory({
        facade: createFakeQoderSdkFacade([]).facade,
        runtimeProbe: () => qoderProbe(true)
      }));
      await registry.startConfigured(config.providers);
      const providers = registry.readyProviders();
      const router = createDefaultRouter({ config, database, providers, providersRegistry: registry });

      const response = await request(router, `${BASE_URL}/qoder`, "PATCH", { enabled: false });
      expect(response.status).toBe(409);
      expect(registry.describe(asProviderId("qoder")).state).toBe("ready");
      expect(providers.qoder).toBeDefined();
    } finally {
      database.close();
    }
  });
});

function qoderProbe(ready: boolean): QoderRuntimeProbe {
  const reason = ready ? undefined : "Qoder CLI/auth fixture is missing";
  return {
    installed: ready,
    ready,
    ...(reason ? { reason } : {}),
    status: {
      active_sessions: 0,
      api_key_configured: ready,
      auth_configured: ready,
      auth_mode: "pat-env",
      auth_source: ready ? "environment" : "none",
      executable_ready: ready,
      mode: "sdk",
      ready,
      ...(reason ? { reason } : {}),
      platform_profile: {
        cli_version: ready ? "1.1.23" : "",
        config_dir_scope: "default",
        protocol_status: ready ? "expected" : "unavailable",
        protocol_version: "1.2.0",
        sdk_ready: true,
        sdk_version: "1.0.23"
      },
      version: "1.0.23"
    }
  };
}

function codexFactory(installed: () => boolean): ProviderFactory {
  const provider = {
    id: "codex",
    capabilities: ["issue_execution"],
    run: async () => ({ runId: "codex-run" }),
    stop: async () => {}
  } as ExecutorProvider;
  return {
    manifest: {
      id: asProviderId("codex"),
      displayName: "Codex",
      supportLevel: "tested",
      transports: ["stdio-json"],
      capabilities: { issueExecution: true }
    },
    parseConfig: (raw) => ({ ...(raw as Record<string, unknown>) }),
    autoDetect: () => ({ installed: installed(), ready: installed(), ...(installed() ? {} : { reason: "CLI not found" }) }),
    create: () => provider as never
  };
}

function request(router: ReturnType<typeof createDefaultRouter>, url: string, method = "GET", body?: unknown): Promise<Response> {
  return router.handle(new Request(url, {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } })
  }));
}
