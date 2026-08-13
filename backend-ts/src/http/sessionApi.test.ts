import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { createDefaultRouter } from "./server.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";
import { claudeManifest } from "../providers/claude/factory.ts";
import { providerSessionDetail, providerSessionSummary } from "../providers/core/sessionView.ts";
import { qoderManifest } from "../providers/qoder/factory.ts";
import { qoderExecutionPolicyAdapter } from "../providers/qoder/executionPolicy.ts";

const BASE_URL = "http://127.0.0.1:3008";
const EMPTY_ROLLOUT_ERROR = [
  "codex thread/resume failed: codex rpc -32603: failed to read thread:",
  "thread-store internal error: failed to read thread /tmp/rollout.jsonl:",
  "rollout at /tmp/rollout.jsonl is empty"
].join(" ");
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-session-api-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun Sessions API compatibility", () => {
  test("lists, creates, reads, and sends Codex session turns", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    try {
      insertProject(database, { id: "demo", cwd: "/tmp/demo" });
      const router = createDefaultRouter({ database, providers: { codex: provider } });

      const created = await router.handle(jsonRequest("/api/sessions", {
        project_id: "demo",
        prompt: "hello session",
        reasoning_effort: "high",
        service_tier: "priority"
      }));
      const list = await router.handle(new Request(`${BASE_URL}/api/sessions?limit=20`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/sessions/codex:thread-new`));
      const message = await router.handle(jsonRequest("/api/sessions/codex:thread-new/messages", {
        prompt: "follow up",
        model: "codex-default",
        service_tier: "priority"
      }));
      const interrupt = await router.handle(new Request(`${BASE_URL}/api/sessions/codex:thread-new/interrupt`, { method: "POST" }));

      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({
        id: "codex:thread-new",
        isRunning: true,
        provider: "codex",
        provider_session_id: "thread-new",
        provider_turn_id: "turn-initial",
        status: "running",
        thread_id: "thread-new",
        turn_id: "turn-initial"
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ data: [{ id: "codex:thread-new", provider_session_id: "thread-new" }] });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: "codex:thread-new", provider_session_id: "thread-new" });
      expect(message.status).toBe(201);
      expect(await message.json()).toEqual({
        isRunning: true,
        provider: "codex",
        status: "running",
        thread_id: "thread-new",
        turn_id: "turn-follow-up"
      });
      expect(interrupt.status).toBe(200);
      expect(await interrupt.json()).toEqual({ interrupted: true });
      expect(provider.interrupts).toEqual([{ sessionId: "thread-new", turnId: "turn-follow-up" }]);
      expect(provider.calls).toEqual([
        ["createSession", { cwd: "/tmp/demo", prompt: "hello session", reasoningEffort: "high", serviceTier: "priority" }],
        ["listSessions", { limit: 20 }],
        ["readSession", { sessionId: "thread-new" }],
        ["sendSessionMessage", { sessionId: "thread-new", prompt: "follow up", serviceTier: "priority" }]
      ]);
    } finally {
      database.close();
    }
  });

  test("steers a running persisted Codex session turn", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    try {
      upsertAgentSession(database, {
        provider: "codex",
        provider_session_id: "thread-running",
        raw_ref: { provider_turn_id: "turn-running" },
        status: "running"
      });
      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(jsonRequest("/api/sessions/codex:thread-running/messages", {
        prompt: "adjust",
        mode: "steer"
      }));

      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({
        isRunning: true,
        provider: "codex",
        status: "running",
        thread_id: "thread-running",
        turn_id: "turn-running"
      });
      expect(provider.calls).toEqual([
        ["sendSessionMessage", { sessionId: "thread-running", prompt: "adjust", mode: "steer", turnId: "turn-running" }]
      ]);
    } finally {
      database.close();
    }
  });


  test("read session detail exposes runtime settings from rollout turn context", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    const root = await mkdtemp(join(tmpdir(), "xuanwu-session-runtime-"));
    tempRoots.push(root);
    const rolloutPath = join(root, "rollout.jsonl");
    await writeFile(rolloutPath, [
      JSON.stringify({ type: "session_meta", payload: { id: "thread-runtime", cwd: "/tmp/demo" } }),
      JSON.stringify({ type: "turn_context", payload: {
        model: "gpt-5.5",
        effort: "xhigh",
        service_tier: "priority",
        approval_policy: "never",
        sandbox_policy: { type: "danger-full-access" }
      } })
    ].join("\n") + "\n");
    provider.readSessionResult = { ...sessionSummary("thread-runtime"), path: rolloutPath };
    try {
      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/sessions/codex:thread-runtime`));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        model: "gpt-5.5",
        reasoning_effort: "xhigh",
        service_tier: "priority",
        approval_policy: "never",
        sandbox: "danger-full-access",
        runtime_settings: {
          model: "gpt-5.5",
          reasoning_effort: "xhigh",
          service_tier: "priority",
          approval_policy: "never",
          sandbox: "danger-full-access"
        }
      });
    } finally {
      database.close();
    }
  });

  test("keeps a newly created Codex session selectable while rollout file is still empty", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    provider.readSessionError = new Error(EMPTY_ROLLOUT_ERROR);
    try {
      upsertAgentSession(database, {
        provider: "codex",
        provider_session_id: "thread-empty",
        raw_ref: { provider_turn_id: "turn-pending" },
        status: "running"
      });
      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/sessions/codex:thread-empty`));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "codex:thread-empty",
        provider: "codex",
        provider_session_id: "thread-empty",
        sessionId: "thread-empty",
        turns: [],
        isRunning: true
      });
      expect(provider.calls).toEqual([
        ["readSession", { sessionId: "thread-empty" }]
      ]);
    } finally {
      database.close();
    }
  });

  test("read session detail reconciles a stale running Codex session index", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    provider.readSessionResult = {
      ...sessionSummary("thread-idle"),
      status: { type: "idle" },
      turns: [{ id: "turn-idle", status: "completed" }]
    };
    try {
      upsertAgentSession(database, {
        provider: "codex",
        provider_session_id: "thread-idle",
        status: "running"
      });

      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/sessions/codex:thread-idle`));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "codex:thread-idle",
        provider_session_id: "thread-idle",
        status: { type: "idle" }
      });
      expect(getAgentSession(database, "codex:thread-idle")).toMatchObject({
        provider_session_id: "thread-idle",
        status: "idle"
      });
    } finally {
      database.close();
    }
  });

  test("read session detail does not persist Codex process load state as lifecycle activity", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    provider.readSessionResult = {
      ...sessionSummary("thread-passive"),
      status: { type: "notLoaded" },
      turns: [{ id: "turn-passive", status: "completed" }]
    };
    try {
      upsertAgentSession(database, {
        provider: "codex",
        provider_session_id: "thread-passive",
        status: "idle"
      });
      const before = getAgentSession(database, "codex:thread-passive");

      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/sessions/codex:thread-passive`));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "codex:thread-passive",
        status: { type: "notLoaded" }
      });
      expect(getAgentSession(database, "codex:thread-passive")).toMatchObject({
        status: "idle",
        updated_at: before?.updated_at
      });
    } finally {
      database.close();
    }
  });

  test("list sessions reconciles stale running Codex session indexes", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    provider.listResult = {
      data: [{
        ...sessionSummary("thread-idle"),
        status: { type: "idle" }
      }],
      nextCursor: ""
    };
    try {
      upsertAgentSession(database, {
        provider: "codex",
        provider_session_id: "thread-idle",
        project_id: "demo",
        status: "running"
      });

      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(new Request(`${BASE_URL}/api/sessions?limit=20`));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: [{ id: "codex:thread-idle", status: { type: "idle" } }]
      });
      expect(getAgentSession(database, "codex:thread-idle")).toMatchObject({
        project_id: "demo",
        status: "idle"
      });
    } finally {
      database.close();
    }
  });

  test("persists a created Codex session even before a provider turn id exists", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    provider.createResult = {
      id: "codex:thread-created",
      provider: "codex",
      provider_session_id: "thread-created",
      thread_id: "thread-created"
    };
    try {
      insertProject(database, { id: "demo", cwd: "/tmp/demo" });
      const response = await createDefaultRouter({
        database,
        providers: { codex: provider }
      }).handle(jsonRequest("/api/sessions", {
        project_id: "demo",
        prompt: "needs approval before first turn"
      }));

      expect(response.status).toBe(201);
      expect(getAgentSession(database, "codex:thread-created")).toMatchObject({
        provider_session_id: "thread-created",
        project_id: "demo",
        status: "running"
      });
    } finally {
      database.close();
    }
  });

  test("filters indexed sessions by role without breaking PI session reads", async () => {
    const database = await openFixtureDatabase();
    const provider = new SessionsProvider();
    try {
      upsertAgentSession(database, {
        provider: "pi-sdk",
        provider_session_id: "conv-1",
        agent_role: "pi_manager",
        project_id: "demo",
        title: "PI manager",
        raw_ref: { conversation_id: "conv-1" },
        status: "active"
      });
      upsertAgentSession(database, {
        provider: "codex",
        provider_session_id: "thread-reviewer",
        agent_role: "reviewer",
        project_id: "demo",
        issue_id: 260,
        status: "running"
      });

      const router = createDefaultRouter({ database, providers: { codex: provider } });
      const reviewerList = await router.handle(new Request(`${BASE_URL}/api/sessions?role=reviewer`));
      const piList = await router.handle(new Request(`${BASE_URL}/api/sessions?role=pi_manager`));
      const piDetail = await router.handle(new Request(`${BASE_URL}/api/sessions/pi-sdk:conv-1`));

      expect(reviewerList.status).toBe(200);
      expect(await reviewerList.json()).toMatchObject({
        data: [{
          agent_role: "reviewer",
          id: "codex:thread-reviewer",
          issue_id: 260,
          provider_session_id: "thread-reviewer"
        }]
      });
      expect(piList.status).toBe(200);
      expect(await piList.json()).toMatchObject({
        data: [{
          agent_role: "pi_manager",
          id: "pi-sdk:conv-1",
          provider: "pi-sdk",
          provider_session_id: "conv-1"
        }]
      });
      expect(piDetail.status).toBe(200);
      expect(await piDetail.json()).toMatchObject({
        agent_role: "pi_manager",
        id: "pi-sdk:conv-1",
        raw_ref: "{\"conversation_id\":\"conv-1\"}"
      });
      expect(provider.calls).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("reads an indexed Pi session when the provider has no native readSession", async () => {
    const database = await openFixtureDatabase();
    const provider = new IndexedOnlyProvider();
    try {
      upsertAgentSession(database, {
        provider: "pi-coding-agent",
        provider_session_id: "pi-session-1",
        project_id: "demo",
        title: "Pi session",
        raw_ref: { model: "openai/gpt-5" },
        status: "idle"
      });

      const response = await createDefaultRouter({ database, providers: { "pi-coding-agent": provider } })
        .handle(new Request(`${BASE_URL}/api/sessions/pi-coding-agent:pi-session-1`));

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        id: "pi-coding-agent:pi-session-1",
        provider: "pi-coding-agent",
        provider_session_id: "pi-session-1",
        title: "Pi session",
        model: "openai/gpt-5"
      });
    } finally {
      database.close();
    }
  });

  test("keeps Codex project defaults out of an explicitly selected Pi session and persists terminal state", async () => {
    const database = await openFixtureDatabase();
    const provider = new PiSessionProvider();
    try {
      insertProject(database, {
        id: "xuanwu",
        cwd: "/tmp/xuanwu",
        provider: "codex",
        model: "codex-default"
      });
      const router = createDefaultRouter({ database, providers: { "pi-coding-agent": provider } });
      const created = await router.handle(jsonRequest("/api/sessions", {
        project_id: "xuanwu",
        provider: "pi-coding-agent",
        prompt: "hello Pi"
      }));

      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({
        id: "pi-coding-agent:pi-created",
        isRunning: false,
        provider: "pi-coding-agent",
        status: "idle"
      });
      expect(provider.createInputs).toEqual([{ cwd: "/tmp/xuanwu", model: "", prompt: "hello Pi" }]);
      expect(getAgentSession(database, "pi-coding-agent:pi-created")).toMatchObject({
        project_id: "xuanwu",
        status: "idle"
      });
      expect(getAgentSession(database, "pi-coding-agent:pi-created")?.raw_ref).not.toContain("codex-default");

      upsertAgentSession(database, {
        provider: "pi-coding-agent",
        provider_session_id: "pi-legacy",
        project_id: "xuanwu",
        status: "running",
        raw_ref: { model: "codex-default", approval_policy: "never" }
      });
      const detail = await router.handle(new Request("http://localhost/api/sessions/pi-coding-agent:pi-legacy"));
      expect(detail.status).toBe(200);
      const detailBody = await detail.json() as Record<string, unknown>;
      expect(detailBody).toMatchObject({
        model: "deepseek/deepseek-v4-flash",
        project_id: "xuanwu",
        status: "idle",
        runtime_settings: { model: "deepseek/deepseek-v4-flash" }
      });
      expect(detailBody.raw_ref).not.toContain("codex-default");
      expect(getAgentSession(database, "pi-coding-agent:pi-legacy")?.raw_ref).not.toContain("codex-default");
    } finally {
      database.close();
    }
  });

  test("routes provider-qualified Claude create/read/message/list/interrupt without Codex reconciliation", async () => {
    const database = await openFixtureDatabase();
    const codex = new SessionsProvider();
    const claude = new ClaudeSessionsProvider();
    try {
      insertProject(database, { id: "claude-demo", cwd: "/tmp/claude-demo", provider: "claude" });
      upsertAgentSession(database, {
        provider: "claude",
        provider_session_id: "claude-existing",
        project_id: "claude-demo",
        raw_ref: { model: "codex-default", provider_turn_id: "claude-turn-existing" },
        status: "running"
      });
      const router = createDefaultRouter({ database, providers: { codex, claude } });

      const liveInterrupt = await router.handle(new Request(`${BASE_URL}/api/sessions/claude:claude-live-unindexed/interrupt`, { method: "POST" }));
      const created = await router.handle(jsonRequest("/api/sessions", {
        project_id: "claude-demo",
        prompt: "hello Claude"
      }));
      const list = await router.handle(new Request(`${BASE_URL}/api/sessions?provider=claude&limit=20`));
      const legacyDetail = await router.handle(new Request(`${BASE_URL}/api/sessions/claude:claude-existing`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/sessions/claude:claude-new`));
      const message = await router.handle(jsonRequest("/api/sessions/claude:claude-new/messages", { prompt: "continue" }));
      const interrupt = await router.handle(new Request(`${BASE_URL}/api/sessions/claude:claude-new/interrupt`, { method: "POST" }));

      expect(created.status).toBe(201);
      expect(liveInterrupt.status).toBe(200);
      expect(await liveInterrupt.json()).toEqual({ interrupted: true });
      expect(await created.json()).toMatchObject({
        id: "claude:claude-new",
        provider: "claude",
        provider_session_id: "claude-new",
        provider_turn_id: "claude-turn-initial"
      });
      expect(getAgentSession(database, "claude:claude-new")).toMatchObject({
        project_id: "claude-demo",
        provider: "claude"
      });
      expect(list.status).toBe(200);
      const listed = await list.json() as { data: Array<Record<string, unknown>> };
      expect(listed.data.find((item) => item.id === "claude:claude-existing")).toMatchObject({
        id: "claude:claude-existing",
        provider: "claude"
      });
      expect(getAgentSession(database, "claude:claude-existing")?.status).toBe("running");
      expect(legacyDetail.status).toBe(200);
      const legacyBody = await legacyDetail.json() as Record<string, unknown>;
      expect(legacyBody).not.toHaveProperty("model");
      expect(legacyBody.raw_ref).not.toContain("codex-default");
      expect(getAgentSession(database, "claude:claude-existing")?.raw_ref).not.toContain("codex-default");
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: "claude:claude-new", provider: "claude" });
      expect(message.status).toBe(201);
      expect(await message.json()).toEqual({
        isRunning: false,
        provider: "claude",
        status: "idle",
        thread_id: "claude-new",
        turn_id: "claude-turn-follow-up"
      });
      expect(interrupt.status).toBe(200);
      expect(await interrupt.json()).toEqual({ interrupted: true });
      expect(claude.interrupts).toEqual([
        { sessionId: "claude-live-unindexed", turnId: "" },
        { sessionId: "claude-new", turnId: "claude-turn-follow-up" }
      ]);
      expect(codex.calls).toEqual([]);
      expect(claude.calls).toEqual([
        ["createSession", { cwd: "/tmp/claude-demo", prompt: "hello Claude" }],
        ["listSessions", { limit: 20 }],
        ["readSession", { sessionId: "claude-existing" }],
        ["readSession", { sessionId: "claude-new" }],
        ["sendSessionMessage", { cwd: "/tmp/claude-demo", sessionId: "claude-new", prompt: "continue" }]
      ]);
    } finally {
      database.close();
    }
  });

  test("serves Qoder list/read contracts, keeps indexed running activity, and propagates bounded provider pagination", async () => {
    const database = await openFixtureDatabase();
    const qoder = new QoderSessionsProvider();
    try {
      upsertAgentSession(database, {
        provider: "qoder",
        provider_session_id: "qoder-existing",
        project_id: "qoder-demo",
        status: "running"
      });
      const router = createDefaultRouter({ database, providers: { qoder } });
      const list = await router.handle(new Request(`${BASE_URL}/api/sessions?provider=qoder&limit=20`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/sessions/qoder:qoder-existing`));

      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        data: [{
          id: "qoder:qoder-existing",
          isRunning: true,
          provider: "qoder",
          session_contract: "xw.provider-session.v1",
          status: "running"
        }],
        nextCursor: "20"
      });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        id: "qoder:qoder-existing",
        isRunning: true,
        provider: "qoder",
        session_contract: "xw.provider-session.v1",
        status: "running",
        turns: []
      });
      expect(getAgentSession(database, "qoder:qoder-existing")?.status).toBe("running");
    } finally {
      database.close();
    }
  });

  test("reports Qoder provider-unavailable state without a native-history fallback", async () => {
    const database = await openFixtureDatabase();
    const qoder = new QoderSessionsProvider();
    qoder.ready = false;
    try {
      const router = createDefaultRouter({ database, providers: { qoder } });
      const list = await router.handle(new Request(`${BASE_URL}/api/sessions?provider=qoder`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/sessions/qoder:qoder-existing`));

      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        data: [],
        provider_errors: [{ provider: "qoder", error: expect.stringContaining("configuration required") }]
      });
      expect(detail.status).toBe(400);
      expect(await detail.text()).toContain("configuration required");
      expect(qoder.calls).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("Session create and resume use the shared resolver for legacy and explicit policy inputs", async () => {
    const database = await openFixtureDatabase();
    const qoder = new PolicySessionsProvider();
    try {
      const router = createDefaultRouter({ database, providers: { qoder } });
      const created = await router.handle(jsonRequest("/api/sessions", {
        approval_policy: "always",
        cwd: "/tmp",
        prompt: "legacy policy",
        provider: "qoder",
        sandbox: "danger-full-access"
      }));
      expect(created.status).toBe(201);
      expect(qoder.createPolicies[0]?.requested).toEqual({
        contract: "xw.execution-policy.v1",
        access: "unrestricted-host",
        approval: "ask-every-side-effect"
      });
      expect(JSON.parse(getAgentSession(database, "qoder:policy-session")?.raw_ref ?? "{}")).toMatchObject({
        requested_execution_policy: {
          access: "unrestricted-host",
          approval: "ask-every-side-effect"
        }
      });

      const resumed = await router.handle(jsonRequest("/api/sessions/qoder:policy-session/messages", {
        execution_policy: {
          contract: "xw.execution-policy.v1",
          access: "read-only",
          approval: "unattended"
        },
        prompt: "explicit policy"
      }));
      expect(resumed.status).toBe(201);
      expect(qoder.messagePolicies[0]?.requested).toEqual({
        contract: "xw.execution-policy.v1",
        access: "read-only",
        approval: "unattended"
      });
    } finally {
      database.close();
    }
  });

  test("keeps legacy bare session ids routed to Codex", async () => {
    const database = await openFixtureDatabase();
    const codex = new SessionsProvider();
    const claude = new ClaudeSessionsProvider();
    try {
      const response = await createDefaultRouter({ database, providers: { codex, claude } })
        .handle(new Request(`${BASE_URL}/api/sessions/thread-legacy`));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "codex:thread-legacy", provider: "codex" });
      expect(codex.calls).toEqual([["readSession", { sessionId: "thread-legacy" }]]);
      expect(claude.calls).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("redacts provider credentials from provider-neutral session errors", async () => {
    const database = await openFixtureDatabase();
    const claude = new ClaudeSessionsProvider();
    const secret = "anthropic-session-error-secret";
    claude.listSessions = async () => {
      throw new Error(`upstream rejected ANTHROPIC_API_KEY=${secret}`);
    };
    try {
      const response = await createDefaultRouter({ database, providers: { claude } })
        .handle(new Request(`${BASE_URL}/api/sessions?provider=claude`));
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).toContain("provider_errors");
      expect(text).not.toContain(secret);
      expect(text).toContain("ANTHROPIC_API_KEY=[redacted]");
    } finally {
      database.close();
    }
  });

  test("fails a project-filtered session list closed when the project does not exist", async () => {
    const database = await openFixtureDatabase();
    const claude = new ClaudeSessionsProvider();
    try {
      const response = await createDefaultRouter({ database, providers: { claude } })
        .handle(new Request(`${BASE_URL}/api/sessions?project_id=missing`));
      expect(response.status).toBe(404);
      expect(claude.calls).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("reports an explicitly requested unready Claude SDK without routing to Codex", async () => {
    const database = await openFixtureDatabase();
    const codex = new SessionsProvider();
    const claude = new ClaudeSessionsProvider();
    claude.ready = false;
    try {
      const router = createDefaultRouter({ database, providers: { codex, claude } });
      const list = await router.handle(new Request(`${BASE_URL}/api/sessions?provider=claude`));
      const create = await router.handle(jsonRequest("/api/sessions", {
        cwd: "/tmp",
        prompt: "hello",
        provider: "claude"
      }));

      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        provider_errors: [{ provider: "claude", error: expect.stringContaining("configuration required") }]
      });
      expect(create.status).toBe(400);
      expect(await create.text()).toContain("尚未就绪");
      expect(codex.calls).toEqual([]);
      expect(claude.calls).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("fails closed when a migrated adapter leaks provider-native session data", async () => {
    const database = await openFixtureDatabase();
    const claude = Object.assign(new ClaudeSessionsProvider(), { manifest: claudeManifest() });
    try {
      const router = createDefaultRouter({ database, providers: { claude } });
      const list = await router.handle(new Request(`${BASE_URL}/api/sessions?provider=claude`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/sessions/claude:claude-existing`));

      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({
        provider_errors: [{ provider: "claude", error: expect.stringContaining("invalid xw.provider-session.v1 view") }]
      });
      expect(detail.status).toBe(400);
      expect(await detail.text()).toContain("invalid xw.provider-session.v1 view");
    } finally {
      database.close();
    }
  });

  test("fails closed when a migrated adapter returns another Session detail", async () => {
    const database = await openFixtureDatabase();
    const claude = Object.assign(new ClaudeSessionsProvider(), {
      manifest: claudeManifest(),
      async readSession() {
        return providerSessionDetail("claude", { sessionRef: "claude-other", turns: [] });
      }
    });
    try {
      const detail = await createDefaultRouter({ database, providers: { claude } })
        .handle(new Request(`${BASE_URL}/api/sessions/claude:claude-requested`));

      expect(detail.status).toBe(400);
      expect(await detail.text()).toContain("invalid xw.provider-session.v1 view");
    } finally {
      database.close();
    }
  });
});

class SessionsProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  readonly interrupts: Array<{ sessionId: string; turnId: string }> = [];
  createResult: SessionCreateFixture | null = null;
  listResult: { data: Array<Record<string, unknown>>; nextCursor: string } | null = null;
  readSessionError: Error | null = null;
  readSessionResult: Record<string, unknown> | null = null;

  async run(_input: ProviderRunInput) {
    throw new Error("not implemented");
  }

  async interrupt(input: { session: { sessionId: string; turnId?: string } }): Promise<void> {
    this.interrupts.push({ sessionId: input.session.sessionId, turnId: input.session.turnId ?? "" });
  }

  async listSessions(input: { cursor?: string; limit?: number }) {
    this.calls.push(["listSessions", compact(input)]);
    if (this.listResult) return this.listResult;
    return { data: [sessionSummary("thread-new")], nextCursor: "" };
  }

  async readSession(sessionId: string) {
    this.calls.push(["readSession", { sessionId }]);
    if (this.readSessionError) throw this.readSessionError;
    return this.readSessionResult ?? sessionSummary(sessionId);
  }

  async createSession(input: Record<string, unknown>) {
    this.calls.push(["createSession", compact({
      cwd: input.cwd,
      prompt: input.prompt,
      reasoningEffort: input.reasoningEffort,
      serviceTier: input.serviceTier
    })]);
    if (this.createResult) return this.createResult;
    return {
      id: "codex:thread-new",
      provider: "codex" as const,
      provider_session_id: "thread-new",
      provider_turn_id: "turn-initial",
      thread_id: "thread-new",
      turn_id: "turn-initial"
    };
  }

  async sendSessionMessage(input: Record<string, unknown>) {
    this.calls.push(["sendSessionMessage", compact({
      sessionId: input.sessionId,
      prompt: input.prompt,
      mode: input.mode,
      turnId: input.turnId,
      serviceTier: input.serviceTier
    })]);
    return {
      provider: "codex" as const,
      provider_session_id: String(input.sessionId),
      sessionId: String(input.sessionId),
      turn_id: input.mode === "steer" ? String(input.turnId) : "turn-follow-up"
    };
  }
}

class ClaudeSessionsProvider implements ExecutorProvider {
  readonly id = "claude" as const;
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  readonly interrupts: Array<{ sessionId: string; turnId: string }> = [];
  ready = true;

  runtimeStatus() {
    return {
      active_sessions: 0,
      api_key_configured: this.ready,
      mode: "sdk",
      ready: this.ready,
      ...(this.ready ? {} : { reason: "configuration required" }),
      version: "0.3.152"
    };
  }

  async run(_input: ProviderRunInput) { throw new Error("not implemented"); }

  async interrupt(input: { session: { sessionId: string; turnId?: string } }): Promise<void> {
    this.interrupts.push({ sessionId: input.session.sessionId, turnId: input.session.turnId ?? "" });
  }

  async listSessions(input: { cursor?: string; cwd?: string; limit?: number }) {
    this.calls.push(["listSessions", compact(input)]);
    return {
      data: [{ id: "claude:claude-existing", provider: "claude", provider_session_id: "claude-existing", status: "idle" }],
      nextCursor: ""
    };
  }

  async readSession(sessionId: string) {
    this.calls.push(["readSession", { sessionId }]);
    return { id: `claude:${sessionId}`, provider: "claude", provider_session_id: sessionId, turns: [] };
  }

  async createSession(input: Record<string, unknown>) {
    this.calls.push(["createSession", compact({ cwd: input.cwd, prompt: input.prompt })]);
    return {
      id: "claude:claude-new",
      provider: "claude" as const,
      provider_session_id: "claude-new",
      provider_turn_id: "claude-turn-initial",
      thread_id: "claude-new",
      turn_id: "claude-turn-initial"
    };
  }

  async sendSessionMessage(input: Record<string, unknown>) {
    this.calls.push(["sendSessionMessage", compact({ cwd: input.cwd, sessionId: input.sessionId, prompt: input.prompt })]);
    return {
      provider: "claude" as const,
      provider_session_id: String(input.sessionId),
      sessionId: String(input.sessionId),
      turn_id: "claude-turn-follow-up"
    };
  }
}

class IndexedOnlyProvider implements ExecutorProvider {
  readonly id = "pi-coding-agent" as const;
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;

  async run(_input: ProviderRunInput) {
    throw new Error("not implemented");
  }
}

class QoderSessionsProvider implements ExecutorProvider {
  readonly id = "qoder" as const;
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
  readonly manifest = qoderManifest();
  readonly calls: string[] = [];
  ready = true;

  runtimeStatus() {
    return {
      active_sessions: 0,
      api_key_configured: this.ready,
      mode: "sdk",
      ready: this.ready,
      ...(this.ready ? {} : { reason: "configuration required" }),
      version: "1.0.20"
    };
  }

  async run(_input: ProviderRunInput) { throw new Error("not implemented"); }

  async listSessions() {
    this.calls.push("listSessions");
    return {
      data: [providerSessionSummary("qoder", {
        sessionRef: "qoder-existing",
        name: "Qoder session",
        status: "idle"
      })],
      nextCursor: "20"
    };
  }

  async readSession(sessionId: string) {
    this.calls.push("readSession");
    return providerSessionDetail("qoder", {
      sessionRef: sessionId,
      name: "Qoder session",
      status: "idle",
      turns: []
    });
  }
}

class PolicySessionsProvider implements ExecutorProvider {
  readonly id = "qoder" as const;
  readonly capabilities = ["issue_execution", "sessions", "resume_session"] as const;
  readonly manifest = qoderManifest();
  readonly policyAdapter = qoderExecutionPolicyAdapter;
  readonly createPolicies: Array<NonNullable<ProviderRunInput["policy"]>> = [];
  readonly messagePolicies: Array<NonNullable<ProviderRunInput["policy"]>> = [];

  runtimeStatus() {
    return { active_sessions: 0, api_key_configured: true, mode: "sdk", ready: true, version: "1.0.20" };
  }

  async run(_input: ProviderRunInput) { return { runId: "unused" }; }

  async createSession(input: Parameters<NonNullable<ExecutorProvider["createSession"]>>[0]) {
    if (input.policy) this.createPolicies.push(input.policy);
    return {
      id: "qoder:policy-session",
      provider: "qoder" as const,
      provider_session_id: "policy-session",
      thread_id: "policy-session",
      turn_id: ""
    };
  }

  async sendSessionMessage(input: Parameters<NonNullable<ExecutorProvider["sendSessionMessage"]>>[0]) {
    if (input.policy) this.messagePolicies.push(input.policy);
    return {
      provider: "qoder" as const,
      provider_session_id: input.sessionId,
      sessionId: input.sessionId,
      turn_id: "policy-turn"
    };
  }
}

class PiSessionProvider implements ExecutorProvider {
  readonly id = "pi-coding-agent" as const;
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
  readonly createInputs: Array<Record<string, unknown>> = [];

  async run(_input: ProviderRunInput) { throw new Error("not implemented"); }

  async createSession(input: Record<string, unknown>) {
    this.createInputs.push({ cwd: input.cwd, model: input.model, prompt: input.prompt });
    return {
      id: "pi-created",
      provider: "pi-coding-agent" as const,
      provider_session_id: "pi-created",
      thread_id: "pi-created"
    };
  }

  async readSession(sessionId: string) {
    return {
      id: `pi-coding-agent:${sessionId}`,
      provider: "pi-coding-agent" as const,
      provider_session_id: sessionId,
      model: "deepseek/deepseek-v4-flash",
      status: "idle",
      isRunning: false,
      turns: []
    };
  }
}

type SessionCreateFixture = {
  id: string;
  provider: "codex";
  provider_session_id: string;
  provider_turn_id?: string;
  thread_id: string;
  turn_id?: string;
};

function insertProject(db: RunnerDatabase, project: { cwd: string; id: string; model?: string; provider?: string }): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, model, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [project.id, project.id, project.cwd, project.provider ?? "codex", project.model ?? "", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  });
}

function sessionSummary(sessionId: string): Record<string, unknown> {
  return { id: `codex:${sessionId}`, provider: "codex", provider_session_id: sessionId, sessionId, ephemeral: false };
}

function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}
