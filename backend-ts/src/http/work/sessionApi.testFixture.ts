import { join } from "node:path";
import { type RunnerDatabase } from "../../db/database.ts";
import { upsertAgentSession } from "../../db/repositories/agentSessions.ts";
import { createDefaultRouter } from "../server.ts";
import type { ExecutorProvider, ProviderRunInput } from "../../providers/types.ts";
import { providerSessionDetail, providerSessionSummary } from "../../providers/core/sessionView.ts";
import { qoderManifest } from "../../providers/qoder/factory.ts";
import { qoderExecutionPolicyAdapter } from "../../providers/qoder/executionPolicy.ts";
import { apiClient, insertProject, useTestDatabase } from "../../testing/harness.ts";

export type Providers = NonNullable<Parameters<typeof createDefaultRouter>[0]>["providers"];

export function createTestFixture() {
  const EMPTY_ROLLOUT_ERROR = [
    "codex thread/resume failed: codex rpc -32603: failed to read thread:",
    "thread-store internal error: failed to read thread /tmp/rollout.jsonl:",
    "rollout at /tmp/rollout.jsonl is empty"
  ].join(" ");

  const openFixtureDatabase = useTestDatabase("xuanwu-bun-session-api-");

  async function sessionsFixture(providers: Providers, seed: (db: RunnerDatabase) => void = () => {}) {
    const database = await openFixtureDatabase();
    seed(database);
    return { database, api: apiClient(createDefaultRouter({ database, providers })) };
  }

  function demoProject(db: RunnerDatabase): void {
    insertProject(db, "demo", { cwd: "/tmp/demo", provider: "codex", model: "" });
  }

  function indexCodex(db: RunnerDatabase, sessionId: string, status: string, raw_ref?: Record<string, unknown>): void {
    upsertAgentSession(db, { provider: "codex", provider_session_id: sessionId, status, ...(raw_ref ? { raw_ref } : {}) });
  }

  function sessionSummary(sessionId: string): Record<string, unknown> {
    return { id: `codex:${sessionId}`, provider: "codex", provider_session_id: sessionId, sessionId, ephemeral: false };
  }

  function compact(input: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
  }

  function readiness(ready: boolean, version: string) {
    return { active_sessions: 0, api_key_configured: ready, mode: "sdk", ready, ...(ready ? {} : { reason: "configuration required" }), version };
  }

  abstract class RecordingProvider {
    readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
    readonly calls: Array<[string, Record<string, unknown>]> = [];
    readonly interrupts: Array<{ sessionId: string; turnId: string }> = [];
  
    async run(_input: ProviderRunInput): Promise<never> {
      throw new Error("not implemented");
    }
  
    async interrupt(input: { session: { sessionId: string; turnId?: string } }): Promise<void> {
      this.interrupts.push({ sessionId: input.session.sessionId, turnId: input.session.turnId ?? "" });
    }
  }

  class SessionsProvider extends RecordingProvider implements ExecutorProvider {
    readonly id = "codex" as const;
    createResult: { id: string; provider: "codex"; provider_session_id: string; provider_turn_id?: string; thread_id: string; turn_id?: string } | null = null;
    listResult: { data: Array<Record<string, unknown>>; nextCursor: string } | null = null;
    readSessionError: Error | null = null;
    readSessionResult: Record<string, unknown> | null = null;
  
    async listSessions(input: { cursor?: string; limit?: number }) {
      this.calls.push(["listSessions", compact(input)]);
      return this.listResult ?? { data: [sessionSummary("thread-new")], nextCursor: "" };
    }
  
    async readSession(sessionId: string, input: { includeTurns?: boolean } = {}) {
      this.calls.push(["readSession", { includeTurns: input.includeTurns, sessionId }]);
      if (this.readSessionError) throw this.readSessionError;
      return this.readSessionResult ?? sessionSummary(sessionId);
    }
  
    async listSessionTurns(sessionId: string, input: Record<string, unknown>) {
      this.calls.push(["listSessionTurns", compact({ sessionId, ...input })]);
      return { data: [{ id: "turn-new", items: [{ type: "agentMessage", text: "summary" }] }], nextCursor: "older" };
    }
  
    async createSession(input: Record<string, unknown>) {
      const { cwd, prompt, reasoningEffort, serviceTier } = input;
      this.calls.push(["createSession", compact({ cwd, prompt, reasoningEffort, serviceTier })]);
      return this.createResult ?? {
        id: "codex:thread-new",
        provider: "codex" as const,
        provider_session_id: "thread-new",
        provider_turn_id: "turn-initial",
        thread_id: "thread-new",
        turn_id: "turn-initial"
      };
    }
  
    async sendSessionMessage(input: Record<string, unknown>) {
      const { sessionId, prompt, mode, turnId, serviceTier } = input;
      this.calls.push(["sendSessionMessage", compact({ sessionId, prompt, mode, turnId, serviceTier })]);
      return {
        provider: "codex" as const,
        provider_session_id: String(sessionId),
        sessionId: String(sessionId),
        turn_id: mode === "steer" ? String(turnId) : "turn-follow-up"
      };
    }
  }

  class ClaudeSessionsProvider extends RecordingProvider implements ExecutorProvider {
    readonly id = "claude" as const;
    ready = true;
  
    runtimeStatus() {
      return readiness(this.ready, "0.3.152");
    }
  
    async listSessions(input: { cursor?: string; cwd?: string; limit?: number }) {
      this.calls.push(["listSessions", compact(input)]);
      return {
        data: [{ id: "claude:claude-existing", provider: "claude", provider_session_id: "claude-existing", status: "idle" }],
        nextCursor: ""
      };
    }
  
    async readSession(sessionId: string, input: { includeTurns?: boolean } = {}) {
      this.calls.push(["readSession", { includeTurns: input.includeTurns, sessionId }]);
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
      return { provider: "claude" as const, provider_session_id: String(input.sessionId), sessionId: String(input.sessionId), turn_id: "claude-turn-follow-up" };
    }
  }

  class QoderSessionsProvider implements ExecutorProvider {
    readonly id = "qoder" as const;
    readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
    readonly manifest = qoderManifest();
    readonly calls: string[] = [];
    ready = true;
  
    runtimeStatus() {
      return readiness(this.ready, "1.0.23");
    }
  
    async run(_input: ProviderRunInput): Promise<never> { throw new Error("not implemented"); }
  
    async listSessions() {
      this.calls.push("listSessions");
      return { data: [providerSessionSummary("qoder", { sessionRef: "qoder-existing", name: "Qoder session", status: "idle" })], nextCursor: "20" };
    }
  
    async readSession(sessionId: string) {
      this.calls.push("readSession");
      return providerSessionDetail("qoder", { sessionRef: sessionId, name: "Qoder session", status: "idle", turns: [] });
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
      return readiness(true, "1.0.23");
    }
  
    async run(_input: ProviderRunInput) { return { runId: "unused" }; }
  
    async createSession(input: Parameters<NonNullable<ExecutorProvider["createSession"]>>[0]) {
      if (input.policy) this.createPolicies.push(input.policy);
      return { id: "qoder:policy-session", provider: "qoder" as const, provider_session_id: "policy-session", thread_id: "policy-session", turn_id: "" };
    }
  
    async sendSessionMessage(input: Parameters<NonNullable<ExecutorProvider["sendSessionMessage"]>>[0]) {
      if (input.policy) this.messagePolicies.push(input.policy);
      return { provider: "qoder" as const, provider_session_id: input.sessionId, sessionId: input.sessionId, turn_id: "policy-turn" };
    }
  }

  class PiSessionProvider implements ExecutorProvider {
    readonly id = "pi-coding-agent" as const;
    readonly capabilities = ["issue_execution", "sessions", "resume_session", "interrupt"] as const;
    readonly createInputs: Array<Record<string, unknown>> = [];
  
    async run(_input: ProviderRunInput): Promise<never> { throw new Error("not implemented"); }
  
    async createSession(input: Record<string, unknown>) {
      this.createInputs.push({ cwd: input.cwd, model: input.model, prompt: input.prompt });
      return { id: "pi-created", provider: "pi-coding-agent" as const, provider_session_id: "pi-created", thread_id: "pi-created" };
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
  return { EMPTY_ROLLOUT_ERROR, openFixtureDatabase, sessionsFixture, demoProject, indexCodex, sessionSummary, compact, readiness, RecordingProvider, SessionsProvider, ClaudeSessionsProvider, QoderSessionsProvider, PolicySessionsProvider, PiSessionProvider };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
