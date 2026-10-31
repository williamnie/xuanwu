import { expect, test } from "bun:test";
import { getAgentSession, upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import type { ExecutorProvider } from "../../providers/types.ts";
import { insertProject } from "../../testing/harness.ts";
import type { TestFixture } from "./sessionApi.testFixture.ts";

export function registerReadsAnIndexedPiSessionCases(testScope: TestFixture) {
  const { sessionsFixture, SessionsProvider, ClaudeSessionsProvider, QoderSessionsProvider, PolicySessionsProvider, PiSessionProvider } = testScope;
  test("reads an indexed Pi session when the provider has no native readSession", async () => {
      const provider: ExecutorProvider = {
        id: "pi-coding-agent",
        capabilities: ["issue_execution", "sessions", "resume_session", "interrupt"],
        async run(): Promise<never> { throw new Error("not implemented"); }
      };
      const { api } = await sessionsFixture({ "pi-coding-agent": provider }, (db) => upsertAgentSession(db, {
        provider: "pi-coding-agent", provider_session_id: "pi-session-1", project_id: "demo",
        title: "Pi session", raw_ref: { model: "openai/gpt-5" }, status: "idle"
      }));
  
      expect(await api.get("/api/sessions/pi-coding-agent:pi-session-1")).toMatchObject({
        status: 200,
        body: {
          id: "pi-coding-agent:pi-session-1",
          provider: "pi-coding-agent",
          provider_session_id: "pi-session-1",
          title: "Pi session",
          model: "openai/gpt-5"
        }
      });
    });
  
  test("keeps Codex project defaults out of an explicitly selected Pi session and persists terminal state", async () => {
      const provider = new PiSessionProvider();
      const { database, api } = await sessionsFixture({ "pi-coding-agent": provider }, (db) => {
        insertProject(db, "xuanwu", { cwd: "/tmp/xuanwu", provider: "codex", model: "codex-default" });
      });
  
      expect(await api.post("/api/sessions", { project_id: "xuanwu", provider: "pi-coding-agent", prompt: "hello Pi" })).toMatchObject({
        status: 201,
        body: { id: "pi-coding-agent:pi-created", isRunning: false, provider: "pi-coding-agent", status: "idle" }
      });
      expect(provider.createInputs).toEqual([{ cwd: "/tmp/xuanwu", model: "", prompt: "hello Pi" }]);
      expect(getAgentSession(database, "pi-coding-agent:pi-created")).toMatchObject({ project_id: "xuanwu", status: "idle" });
      expect(getAgentSession(database, "pi-coding-agent:pi-created")?.raw_ref).not.toContain("codex-default");
  
      upsertAgentSession(database, {
        provider: "pi-coding-agent",
        provider_session_id: "pi-legacy",
        project_id: "xuanwu",
        status: "running",
        raw_ref: { model: "codex-default", approval_policy: "never" }
      });
      const detail = await api.get("/api/sessions/pi-coding-agent:pi-legacy");
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        model: "deepseek/deepseek-v4-flash",
        project_id: "xuanwu",
        status: "idle",
        runtime_settings: { model: "deepseek/deepseek-v4-flash" }
      });
      expect(detail.body.raw_ref).not.toContain("codex-default");
      expect(getAgentSession(database, "pi-coding-agent:pi-legacy")?.raw_ref).not.toContain("codex-default");
    });
  
  test("routes provider-qualified Claude create/read/message/list/interrupt without Codex reconciliation", async () => {
      const codex = new SessionsProvider();
      const claude = new ClaudeSessionsProvider();
      const { database, api } = await sessionsFixture({ codex, claude }, (db) => {
        insertProject(db, "claude-demo", { cwd: "/tmp/claude-demo", provider: "claude" });
        upsertAgentSession(db, {
          provider: "claude",
          provider_session_id: "claude-existing",
          project_id: "claude-demo",
          raw_ref: { model: "codex-default", provider_turn_id: "claude-turn-existing" },
          status: "running"
        });
      });
  
      const liveInterrupt = await api.raw("/api/sessions/claude:claude-live-unindexed/interrupt", { method: "POST" });
      const created = await api.post("/api/sessions", { project_id: "claude-demo", prompt: "hello Claude" });
      const list = await api.get<{ data: Array<Record<string, unknown>> }>("/api/sessions?provider=claude&limit=20");
      const legacyDetail = await api.get("/api/sessions/claude:claude-existing");
      const detail = await api.get("/api/sessions/claude:claude-new");
      const message = await api.post("/api/sessions/claude:claude-new/messages", { prompt: "continue" });
      const interrupt = await api.raw("/api/sessions/claude:claude-new/interrupt", { method: "POST" });
  
      expect(liveInterrupt.status).toBe(200);
      expect(await liveInterrupt.json()).toEqual({ interrupted: true });
      expect(created).toMatchObject({
        status: 201,
        body: { id: "claude:claude-new", provider: "claude", provider_session_id: "claude-new", provider_turn_id: "claude-turn-initial" }
      });
      expect(getAgentSession(database, "claude:claude-new")).toMatchObject({ project_id: "claude-demo", provider: "claude" });
      expect(list.status).toBe(200);
      expect(list.body.data.find((item) => item.id === "claude:claude-existing")).toMatchObject({ id: "claude:claude-existing", provider: "claude" });
      expect(getAgentSession(database, "claude:claude-existing")?.status).toBe("running");
      expect(legacyDetail.status).toBe(200);
      expect(legacyDetail.body).not.toHaveProperty("model");
      expect(legacyDetail.body.raw_ref).not.toContain("codex-default");
      expect(getAgentSession(database, "claude:claude-existing")?.raw_ref).not.toContain("codex-default");
      expect(detail).toMatchObject({ status: 200, body: { id: "claude:claude-new", provider: "claude" } });
      expect(message).toMatchObject({ status: 201 });
      expect(message.body).toEqual({ isRunning: true, provider: "claude", status: "running", thread_id: "claude-new", turn_id: "claude-turn-follow-up" });
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
        ["readSession", { includeTurns: false, sessionId: "claude-existing" }],
        ["readSession", { includeTurns: false, sessionId: "claude-new" }],
        ["sendSessionMessage", { cwd: "/tmp/claude-demo", sessionId: "claude-new", prompt: "continue" }]
      ]);
    });
  
  test("serves Qoder list/read contracts, keeps indexed running activity, and propagates bounded provider pagination", async () => {
      const qoder = new QoderSessionsProvider();
      const { database, api } = await sessionsFixture({ qoder }, (db) => upsertAgentSession(db, {
        provider: "qoder", provider_session_id: "qoder-existing", project_id: "qoder-demo", status: "running"
      }));
      const running = { id: "qoder:qoder-existing", isRunning: true, provider: "qoder", session_contract: "xw.provider-session.v1", status: "running" };
  
      expect(await api.get("/api/sessions?provider=qoder&limit=20")).toMatchObject({ status: 200, body: { data: [running], nextCursor: "20" } });
      expect(await api.get("/api/sessions/qoder:qoder-existing")).toMatchObject({ status: 200, body: { ...running, turns: [] } });
      expect(getAgentSession(database, "qoder:qoder-existing")?.status).toBe("running");
    });
  
  test("reports Qoder provider-unavailable state without a native-history fallback", async () => {
      const qoder = new QoderSessionsProvider();
      qoder.ready = false;
      const { api } = await sessionsFixture({ qoder });
  
      expect(await api.get("/api/sessions?provider=qoder")).toMatchObject({
        status: 200,
        body: { data: [], provider_errors: [{ provider: "qoder", error: expect.stringContaining("configuration required") }] }
      });
      const detail = await api.get("/api/sessions/qoder:qoder-existing");
      expect(detail.status).toBe(400);
      expect(JSON.stringify(detail.body)).toContain("configuration required");
      expect(qoder.calls).toEqual([]);
    });
  
  test("Session create and resume use the shared resolver for legacy and explicit policy inputs", async () => {
      const qoder = new PolicySessionsProvider();
      const { database, api } = await sessionsFixture({ qoder });
  
      expect((await api.post("/api/sessions", {
        approval_policy: "always", cwd: "/tmp", prompt: "legacy policy", provider: "qoder", sandbox: "danger-full-access"
      })).status).toBe(201);
      expect(qoder.createPolicies[0]?.requested).toEqual({
        contract: "xw.execution-policy.v1", access: "unrestricted-host", approval: "ask-every-side-effect"
      });
      expect(JSON.parse(getAgentSession(database, "qoder:policy-session")?.raw_ref ?? "{}")).toMatchObject({
        requested_execution_policy: { access: "unrestricted-host", approval: "ask-every-side-effect" }
      });
  
      const explicit = { contract: "xw.execution-policy.v1", access: "read-only", approval: "unattended" } as const;
      expect((await api.post("/api/sessions/qoder:policy-session/messages", { execution_policy: explicit, prompt: "explicit policy" })).status).toBe(201);
      expect(qoder.messagePolicies[0]?.requested).toEqual(explicit);
    });
  
  test("keeps legacy bare session ids routed to Codex", async () => {
      const codex = new SessionsProvider();
      const claude = new ClaudeSessionsProvider();
      const { api } = await sessionsFixture({ codex, claude });
  
      expect(await api.get("/api/sessions/thread-legacy")).toMatchObject({ status: 200, body: { id: "codex:thread-legacy", provider: "codex" } });
      expect(codex.calls).toEqual([["readSession", { includeTurns: false, sessionId: "thread-legacy" }]]);
      expect(claude.calls).toEqual([]);
    });
  
  test("redacts provider credentials from provider-neutral session errors", async () => {
      const claude = new ClaudeSessionsProvider();
      const secret = "anthropic-session-error-secret";
      claude.listSessions = async () => {
        throw new Error(`upstream rejected ANTHROPIC_API_KEY=${secret}`);
      };
      const { api } = await sessionsFixture({ claude });
  
      const response = await api.get("/api/sessions?provider=claude");
      const text = JSON.stringify(response.body);
      expect(response.status).toBe(200);
      expect(text).toContain("provider_errors");
      expect(text).not.toContain(secret);
      expect(text).toContain("ANTHROPIC_API_KEY=[redacted]");
    });
  
  test("fails a project-filtered session list closed when the project does not exist", async () => {
      const claude = new ClaudeSessionsProvider();
      const { api } = await sessionsFixture({ claude });
  
      expect((await api.get("/api/sessions?project_id=missing")).status).toBe(404);
      expect(claude.calls).toEqual([]);
    });
  
  test("reports an explicitly requested unready Claude SDK without routing to Codex", async () => {
      const codex = new SessionsProvider();
      const claude = new ClaudeSessionsProvider();
      claude.ready = false;
      const { api } = await sessionsFixture({ codex, claude });
  
      expect(await api.get("/api/sessions?provider=claude")).toMatchObject({
        status: 200,
        body: { provider_errors: [{ provider: "claude", error: expect.stringContaining("configuration required") }] }
      });
      const create = await api.post("/api/sessions", { cwd: "/tmp", prompt: "hello", provider: "claude" });
      expect(create.status).toBe(400);
      expect(JSON.stringify(create.body)).toContain("尚未就绪");
      expect(codex.calls).toEqual([]);
      expect(claude.calls).toEqual([]);
    });
}
