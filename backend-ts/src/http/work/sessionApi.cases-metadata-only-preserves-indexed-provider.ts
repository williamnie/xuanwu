import { expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentSession, upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import type { ExecutorProvider } from "../../providers/types.ts";
import { providerSessionDetail } from "../../providers/core/sessionView.ts";
import type { TestFixture } from "./sessionApi.testFixture.ts";

export function registerMetadataOnlyPreservesIndexedProviderCases(testScope: TestFixture) {
  const { EMPTY_ROLLOUT_ERROR, sessionsFixture, demoProject, indexCodex, sessionSummary, SessionsProvider } = testScope;
  test("metadata-only preserves indexed provider model without loading transcript", async () => {
      const claude: ExecutorProvider = {
        id: "claude", capabilities: ["sessions"],
        async run(): Promise<never> { throw new Error("not used by metadata reads"); },
        async readSession(id, input = {}) {
          expect(input.includeTurns).toBe(false);
          return providerSessionDetail("claude", { sessionRef: id, name: "Native title", cwd: "/tmp/project", status: "idle" });
        }
      };
      const { database, api } = await sessionsFixture({ claude }, (db) => upsertAgentSession(db, {
        provider: "claude", provider_session_id: "metadata", title: "Indexed title",
        raw_ref: { model: "claude-history-model", settings_provider: "claude" }, status: "idle",
      }));
  
      expect(await api.get("/api/sessions/claude:metadata")).toMatchObject({
        status: 200,
        body: { model: "claude-history-model", name: "Native title", cwd: "/tmp/project", status: "idle", turns: [] }
      });
      expect(JSON.parse(getAgentSession(database, "claude:metadata")!.raw_ref).model).toBe("claude-history-model");
    });
  
  test("Codex 创建请求传递用户明确指定的标题", async () => {
      const provider = new SessionsProvider();
      let title: string | undefined;
      const create = provider.createSession.bind(provider);
      provider.createSession = async (input) => { title = input.title as string | undefined; return create(input); };
      const { api } = await sessionsFixture({ codex: provider }, demoProject);
  
      expect((await api.post("/api/sessions", { project_id: "demo", prompt: "修复消息重复", title: " 用户的标题 " })).status).toBe(201);
      expect(title).toBe("用户的标题");
    });
  
  test("lists, creates, reads, and sends Codex session turns", async () => {
      const provider = new SessionsProvider();
      const { api } = await sessionsFixture({ codex: provider }, demoProject);
  
      const created = await api.post("/api/sessions", { project_id: "demo", prompt: "hello session", reasoning_effort: "high", service_tier: "priority" });
      const list = await api.get("/api/sessions?limit=20");
      const detail = await api.get("/api/sessions/codex:thread-new");
      const turns = await api.get("/api/sessions/codex:thread-new/turns?limit=20");
      const message = await api.post("/api/sessions/codex:thread-new/messages", { prompt: "follow up", model: "codex-default", service_tier: "priority" });
      const interrupt = await api.raw("/api/sessions/codex:thread-new/interrupt", { method: "POST" });
  
      expect(created).toMatchObject({ status: 201 });
      expect(created.body).toEqual({
        id: "codex:thread-new",
        isRunning: true,
        provider: "codex",
        provider_session_id: "thread-new",
        provider_turn_id: "turn-initial",
        status: "running",
        thread_id: "thread-new",
        turn_id: "turn-initial"
      });
      expect(list).toMatchObject({ status: 200, body: { data: [{ id: "codex:thread-new", provider_session_id: "thread-new" }] } });
      expect(detail).toMatchObject({ status: 200, body: { id: "codex:thread-new", provider_session_id: "thread-new", turns: [] } });
      expect(turns).toMatchObject({ status: 200, body: { data: [{ id: "turn-new" }], nextCursor: "older" } });
      expect(message).toMatchObject({ status: 201 });
      expect(message.body).toEqual({ isRunning: true, provider: "codex", status: "running", thread_id: "thread-new", turn_id: "turn-follow-up" });
      expect(interrupt.status).toBe(200);
      expect(await interrupt.json()).toEqual({ interrupted: true });
      expect(provider.interrupts).toEqual([{ sessionId: "thread-new", turnId: "turn-follow-up" }]);
      expect(provider.calls).toEqual([
        ["createSession", { cwd: "/tmp/demo", prompt: "hello session", reasoningEffort: "high", serviceTier: "priority" }],
        ["listSessions", { limit: 20 }],
        ["readSession", { includeTurns: false, sessionId: "thread-new" }],
        ["listSessionTurns", { itemsView: "summary", limit: 20, sessionId: "thread-new", sortDirection: "desc" }],
        ["sendSessionMessage", { sessionId: "thread-new", prompt: "follow up", serviceTier: "priority" }]
      ]);
    });
  
  test("steers a running persisted Codex session turn", async () => {
      const provider = new SessionsProvider();
      const { api } = await sessionsFixture({ codex: provider }, (db) => indexCodex(db, "thread-running", "running", { provider_turn_id: "turn-running" }));
  
      const response = await api.post("/api/sessions/codex:thread-running/messages", { prompt: "adjust", mode: "steer" });
  
      expect(response.status).toBe(201);
      expect(response.body).toEqual({ isRunning: true, provider: "codex", status: "running", thread_id: "thread-running", turn_id: "turn-running" });
      expect(provider.calls).toEqual([
        ["sendSessionMessage", { sessionId: "thread-running", prompt: "adjust", mode: "steer", turnId: "turn-running" }]
      ]);
    });
  
  test("read session detail exposes runtime settings from rollout turn context", async () => {
      const provider = new SessionsProvider();
      const { database, api } = await sessionsFixture({ codex: provider });
      const rolloutPath = join(database.path, "..", "rollout.jsonl");
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
      const settings = { model: "gpt-5.5", reasoning_effort: "xhigh", service_tier: "priority", approval_policy: "never", sandbox: "danger-full-access" };
  
      expect(await api.get("/api/sessions/codex:thread-runtime")).toMatchObject({ status: 200, body: { ...settings, runtime_settings: settings } });
    });
  
  test("keeps a newly created Codex session selectable while rollout file is still empty", async () => {
      const provider = new SessionsProvider();
      provider.readSessionError = new Error(EMPTY_ROLLOUT_ERROR);
      const { api } = await sessionsFixture({ codex: provider }, (db) => indexCodex(db, "thread-empty", "running", { provider_turn_id: "turn-pending" }));
  
      expect(await api.get("/api/sessions/codex:thread-empty")).toMatchObject({
        status: 200,
        body: { id: "codex:thread-empty", provider: "codex", provider_session_id: "thread-empty", sessionId: "thread-empty", turns: [], isRunning: true }
      });
      expect(provider.calls).toEqual([["readSession", { includeTurns: false, sessionId: "thread-empty" }]]);
    });
  
  test("read session detail reconciles a stale running Codex session index", async () => {
      const provider = new SessionsProvider();
      provider.readSessionResult = { ...sessionSummary("thread-idle"), status: { type: "idle" }, turns: [{ id: "turn-idle", status: "completed" }] };
      const { database, api } = await sessionsFixture({ codex: provider }, (db) => indexCodex(db, "thread-idle", "running"));
  
      expect(await api.get("/api/sessions/codex:thread-idle")).toMatchObject({
        status: 200,
        body: { id: "codex:thread-idle", provider_session_id: "thread-idle", status: { type: "idle" } }
      });
      expect(getAgentSession(database, "codex:thread-idle")).toMatchObject({ provider_session_id: "thread-idle", status: "idle" });
    });
  
  test("read session detail does not persist Codex process load state as lifecycle activity", async () => {
      const provider = new SessionsProvider();
      provider.readSessionResult = { ...sessionSummary("thread-passive"), status: { type: "notLoaded" }, turns: [{ id: "turn-passive", status: "completed" }] };
      const { database, api } = await sessionsFixture({ codex: provider }, (db) => indexCodex(db, "thread-passive", "idle"));
      const before = getAgentSession(database, "codex:thread-passive");
  
      expect(await api.get("/api/sessions/codex:thread-passive")).toMatchObject({
        status: 200,
        body: { id: "codex:thread-passive", status: { type: "notLoaded" } }
      });
      expect(getAgentSession(database, "codex:thread-passive")).toMatchObject({ status: "idle", updated_at: before?.updated_at });
    });
  
  test("read session detail preserves indexed Codex activity when the fresh process reports notLoaded", async () => {
      const provider = new SessionsProvider();
      provider.readSessionResult = { ...sessionSummary("thread-running-not-loaded"), status: { type: "notLoaded" }, turns: [] };
      const { database, api } = await sessionsFixture({ codex: provider }, (db) => indexCodex(db, "thread-running-not-loaded", "running"));
  
      expect(await api.get("/api/sessions/codex:thread-running-not-loaded")).toMatchObject({
        status: 200,
        body: { id: "codex:thread-running-not-loaded", status: "running", isRunning: true }
      });
      expect(getAgentSession(database, "codex:thread-running-not-loaded")).toMatchObject({ status: "running" });
    });
  
  test("list sessions reconciles stale running Codex session indexes", async () => {
      const provider = new SessionsProvider();
      provider.listResult = { data: [{ ...sessionSummary("thread-idle"), status: { type: "idle" } }], nextCursor: "" };
      const { database, api } = await sessionsFixture({ codex: provider }, (db) => upsertAgentSession(db, {
        provider: "codex", provider_session_id: "thread-idle", project_id: "demo", status: "running"
      }));
  
      expect(await api.get("/api/sessions?limit=20")).toMatchObject({
        status: 200,
        body: { data: [{ id: "codex:thread-idle", status: { type: "idle" } }] }
      });
      expect(getAgentSession(database, "codex:thread-idle")).toMatchObject({ project_id: "demo", status: "idle" });
    });
  
  test("persists a created Codex session even before a provider turn id exists", async () => {
      const provider = new SessionsProvider();
      provider.createResult = { id: "codex:thread-created", provider: "codex", provider_session_id: "thread-created", thread_id: "thread-created" };
      const { database, api } = await sessionsFixture({ codex: provider }, demoProject);
  
      expect((await api.post("/api/sessions", { project_id: "demo", prompt: "needs approval before first turn" })).status).toBe(201);
      expect(getAgentSession(database, "codex:thread-created")).toMatchObject({
        provider_session_id: "thread-created",
        project_id: "demo",
        status: "running"
      });
    });
  
  test("filters indexed sessions by role without breaking PI session reads", async () => {
      const provider = new SessionsProvider();
      const { api } = await sessionsFixture({ codex: provider }, (db) => {
        upsertAgentSession(db, {
          provider: "pi-sdk", provider_session_id: "conv-1", agent_role: "pi_manager", project_id: "demo",
          title: "PI manager", raw_ref: { conversation_id: "conv-1" }, status: "active"
        });
        upsertAgentSession(db, {
          provider: "codex", provider_session_id: "thread-reviewer", agent_role: "reviewer", project_id: "demo", issue_id: 260, status: "running"
        });
      });
  
      expect(await api.get("/api/sessions?role=reviewer")).toMatchObject({
        status: 200,
        body: { data: [{ agent_role: "reviewer", id: "codex:thread-reviewer", issue_id: 260, provider_session_id: "thread-reviewer" }] }
      });
      expect(await api.get("/api/sessions?role=pi_manager")).toMatchObject({
        status: 200,
        body: { data: [{ agent_role: "pi_manager", id: "pi-sdk:conv-1", provider: "pi-sdk", provider_session_id: "conv-1" }] }
      });
      expect(await api.get("/api/sessions/pi-sdk:conv-1")).toMatchObject({
        status: 200,
        body: { agent_role: "pi_manager", id: "pi-sdk:conv-1", raw_ref: "{\"conversation_id\":\"conv-1\"}" }
      });
      expect(provider.calls).toEqual([]);
    });
}
