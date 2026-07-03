import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getAgentSession, upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { createDefaultRouter } from "./server.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";

const BASE_URL = "http://127.0.0.1:3008";
const EMPTY_ROLLOUT_ERROR = [
  "codex thread/resume failed: codex rpc -32603: failed to read thread:",
  "thread-store internal error: failed to read thread /tmp/rollout.jsonl:",
  "rollout at /tmp/rollout.jsonl is empty"
].join(" ");
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-session-api-"));
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
        provider: "codex",
        provider_session_id: "thread-new",
        provider_turn_id: "turn-initial",
        thread_id: "thread-new",
        turn_id: "turn-initial"
      });
      expect(list.status).toBe(200);
      expect(await list.json()).toMatchObject({ data: [{ id: "codex:thread-new", provider_session_id: "thread-new" }] });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({ id: "codex:thread-new", provider_session_id: "thread-new" });
      expect(message.status).toBe(201);
      expect(await message.json()).toEqual({ thread_id: "thread-new", turn_id: "turn-follow-up" });
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
      expect(await response.json()).toEqual({ thread_id: "thread-running", turn_id: "turn-running" });
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
    const root = await mkdtemp(join(tmpdir(), "codex-runner-session-runtime-"));
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
        provider_session_id: "thread-verifier",
        agent_role: "verifier",
        project_id: "demo",
        issue_id: 260,
        status: "running"
      });

      const router = createDefaultRouter({ database, providers: { codex: provider } });
      const verifierList = await router.handle(new Request(`${BASE_URL}/api/sessions?role=verifier`));
      const piList = await router.handle(new Request(`${BASE_URL}/api/sessions?role=pi_manager`));
      const piDetail = await router.handle(new Request(`${BASE_URL}/api/sessions/pi-sdk:conv-1`));

      expect(verifierList.status).toBe(200);
      expect(await verifierList.json()).toMatchObject({
        data: [{
          agent_role: "verifier",
          id: "codex:thread-verifier",
          issue_id: 260,
          provider_session_id: "thread-verifier"
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

type SessionCreateFixture = {
  id: string;
  provider: "codex";
  provider_session_id: string;
  provider_turn_id?: string;
  thread_id: string;
  turn_id?: string;
};

function insertProject(db: RunnerDatabase, project: { cwd: string; id: string }): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [project.id, project.id, project.cwd, "codex", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
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
