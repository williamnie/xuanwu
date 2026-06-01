import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { upsertAgentSession } from "../db/repositories/agentSessions.ts";
import { createDefaultRouter } from "./server.ts";
import type { ExecutorProvider, ProviderRunInput } from "../providers/types.ts";

const BASE_URL = "http://127.0.0.1:3008";
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
        reasoning_effort: "high"
      }));
      const list = await router.handle(new Request(`${BASE_URL}/api/sessions?limit=20`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/sessions/codex:thread-new`));
      const message = await router.handle(jsonRequest("/api/sessions/codex:thread-new/messages", {
        prompt: "follow up",
        model: "codex-default"
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
        ["createSession", { cwd: "/tmp/demo", prompt: "hello session", reasoningEffort: "high" }],
        ["listSessions", { limit: 20 }],
        ["readSession", { sessionId: "thread-new" }],
        ["sendSessionMessage", { sessionId: "thread-new", prompt: "follow up" }]
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
});

class SessionsProvider implements ExecutorProvider {
  readonly id = "codex" as const;
  readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  readonly interrupts: Array<{ sessionId: string; turnId: string }> = [];

  async run(_input: ProviderRunInput) {
    throw new Error("not implemented");
  }

  async interrupt(input: { session: { sessionId: string; turnId?: string } }): Promise<void> {
    this.interrupts.push({ sessionId: input.session.sessionId, turnId: input.session.turnId ?? "" });
  }

  async listSessions(input: { cursor?: string; limit?: number }) {
    this.calls.push(["listSessions", compact(input)]);
    return { data: [sessionSummary("thread-new")], nextCursor: "" };
  }

  async readSession(sessionId: string) {
    this.calls.push(["readSession", { sessionId }]);
    return sessionSummary(sessionId);
  }

  async createSession(input: Record<string, unknown>) {
    this.calls.push(["createSession", compact({
      cwd: input.cwd,
      prompt: input.prompt,
      reasoningEffort: input.reasoningEffort
    })]);
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
      turnId: input.turnId
    })]);
    return {
      provider: "codex" as const,
      provider_session_id: String(input.sessionId),
      sessionId: String(input.sessionId),
      turn_id: input.mode === "steer" ? String(input.turnId) : "turn-follow-up"
    };
  }
}

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
