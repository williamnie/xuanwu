import { afterEach, describe, expect, test } from "bun:test";
import type {
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKSystemInitMessage,
  SessionMessage
} from "@qoder-ai/qoder-agent-sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig } from "../../config/env.ts";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { getAgentProfile } from "../../db/repositories/agentProfiles.ts";
import { getAgentSession } from "../../db/repositories/agentSessions.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { createDefaultRouter } from "../../http/server.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { asProviderId, isProviderInterruptedError, type ProviderRunInput } from "../types.ts";
import { runProjectLoopOnce } from "../../runner/projectLoop.ts";
import { runIssueWithProvider } from "../../runner/providerRuntime.ts";
import { qoderFactory } from "./factory.ts";
import { QoderExecutorProvider } from "./provider.ts";
import {
  createFakeQoderSdkFacade,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";

const BASE_URL = "http://127.0.0.1:3008";
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("Qoder Q6 offline acceptance", () => {
  test("walks enabled agent -> profile -> Issue/Run/Attempt -> events -> Session/Runs -> two resumes", async () => {
    const root = await fixtureRoot("xuanwu-qoder-q6-");
    const stateDir = join(root, "state");
    const database = await openDatabase({ stateDir });
    const facade = new SequentialFacade();
    let invocation = 0;
    let session = 0;
    try {
      const config = buildConfig({
        dbPath: database.path,
        qoderEnabled: false,
        stateDir
      });
      const registry = createProviderRegistry();
      registry.registerFactory(qoderFactory({
        facade,
        invocationIdFactory: () => `qoder-q6-inv-${++invocation}`,
        runtimeProbe: () => readyProbe(),
        sessionFunctions: historyFunctions(),
        sessionIdFactory: () => `qoder-q6-session-${++session}`
      }));
      await registry.startConfigured(config.providers);
      const providers = registry.readyProviders();
      const router = createDefaultRouter({ config, database, providers, providersRegistry: registry });

      expect(registry.describe(asProviderId("qoder")).state).toBe("disabled");
      const enabled = await request(router, "/api/code-agents/qoder", "PATCH", { enabled: true });
      expect(enabled.status).toBe(200);
      expect(await enabled.json()).toMatchObject({
        agents: [{ id: "qoder", state: "ready", submittable: true }],
        available_ids: ["qoder"]
      });
      expect(getAgentProfile(database, "xuanwu-provider-qoder")).toMatchObject({
        id: "xuanwu-provider-qoder",
        model: "",
        provider: "qoder"
      });

      const createdProject = await request(router, "/api/projects", "POST", {
        auto_run: false,
        cwd: root,
        default_agent_profile_id: "xuanwu-provider-qoder",
        id: "qoder-q6",
        model: "performance",
        provider: "qoder"
      });
      expect(createdProject.status).toBe(201);
      expect(await createdProject.json()).toMatchObject({
        default_agent_profile_id: "xuanwu-provider-qoder",
        model: "performance",
        provider: "qoder"
      });

      const createdIssue = await request(router, "/api/issues", "POST", {
        agent_profile_id: "xuanwu-provider-qoder",
        description: "Run the isolated Qoder fixture without network access.",
        issue_log_mode: "debug",
        project_id: "qoder-q6",
        status: "triage",
        title: "Qoder Q6 fixture"
      });
      expect(createdIssue.status).toBe(201);
      const issue = await createdIssue.json() as { id: number };
      updateIssue(database, issue.id, { status: "todo" });

      const loop = await runProjectLoopOnce({ database, projectId: "qoder-q6", providers });
      expect(loop).toMatchObject({ claimed: true, issue: { id: issue.id } });
      const run = listIssueRuns(database, issue.id).at(-1);
      expect(run).toMatchObject({
        agent_profile_id: "xuanwu-provider-qoder",
        provider: "qoder",
        provider_session_id: "qoder-q6-session-1",
        provider_turn_id: "qoder-q6-result-1",
        selection_reason: "issue assigned agent_profile_id",
        status: "succeeded"
      });
      expect(JSON.parse(run?.runtime_metadata_json ?? "{}")).toMatchObject({ run_id: "qoder-q6-inv-1" });
      expect(getIssue(database, issue.id)?.status).toBe("in_progress");
      expect(getAgentSession(database, "qoder:qoder-q6-session-1")).toMatchObject({
        issue_id: issue.id,
        provider: "qoder",
        status: "completed"
      });

      const persistedEvents = listIssueEvents(database, issue.id);
      const persisted = JSON.stringify(persistedEvents);
      expect(persisted).toContain("qoder/future_event");
      expect(persistedEvents.some((event) => {
        const payload = event.payload ? JSON.parse(event.payload) as Record<string, any> : {};
        return payload.raw_method === "qoder/future_event" && payload.run_event?.kind === "unknown" &&
          payload.run_event?.terminal === false;
      })).toBe(true);
      expect(persisted).not.toContain("fixture-secret");
      expect(database.sqlite.query<{ status: string }, [number]>(`
        select attempt.status from run_attempts attempt
        join issue_runs run on run.id=attempt.issue_run_id
        where run.issue_id=? order by attempt.sequence desc limit 1
      `).get(issue.id)?.status).toBe("succeeded");

      const runId = `xw:run:issue_runs:${run?.id}`;
      const runDetail = await request(router, `/api/runs/${encodeURIComponent(runId)}`);
      expect(runDetail.status).toBe(200);
      const runBody = await runDetail.json() as Record<string, any>;
      const observationRef = runBody.run.attempts[0].provider_ref.observation_ref;
      expect(observationRef).toBe("qoder:qoder-q6-session-1");
      expect(runBody.run.attempts[0]).toMatchObject({
        provider_ref: {
          invocation_ref: run?.id,
          provider: "qoder",
          session_ref: "qoder-q6-session-1",
          turn_ref: "qoder-q6-result-1"
        },
        status: "succeeded"
      });

      const sessionDetail = await request(router, `/api/sessions/${encodeURIComponent(observationRef)}`);
      expect(sessionDetail.status).toBe(200);
      expect(await sessionDetail.json()).toMatchObject({
        id: "qoder:qoder-q6-session-1",
        provider: "qoder",
        session_contract: "xw.provider-session.v1",
        turns: [{ items: [{ type: "userMessage" }, { type: "agentMessage" }] }]
      });

      for (const prompt of ["resume round one", "resume round two"]) {
        const resumed = await request(
          router,
          `/api/sessions/${encodeURIComponent(observationRef)}/messages`,
          "POST",
          { prompt }
        );
        expect(resumed.status).toBe(201);
        expect(await resumed.json()).toMatchObject({
          provider: "qoder",
          thread_id: "qoder-q6-session-1"
        });
      }
      expect(facade.calls).toHaveLength(3);
      expect(facade.calls[0]).toMatchObject({ sessionId: "qoder-q6-session-1" });
      for (const call of facade.calls.slice(1)) {
        expect(call).toMatchObject({ resume: "qoder-q6-session-1" });
        expect(call).not.toHaveProperty("sessionId");
      }
      expect(JSON.parse(getAgentSession(database, "qoder:qoder-q6-session-1")?.raw_ref ?? "{}")).toMatchObject({
        provider_turn_id: "qoder-q6-result-3"
      });
      expect(registry.collectProcessLeases()).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("keeps concurrent interrupt scoped, clears leases, and redacts a failed terminal", async () => {
    const held = new HeldFacade();
    let invocation = 0;
    let session = 0;
    const provider = new QoderExecutorProvider(buildConfig().providers.qoder!, {
      facade: held,
      invocationIdFactory: () => `held-inv-${++invocation}`,
      readiness: readyProbe(),
      sessionIdFactory: () => `held-session-${++session}`
    });
    const first = provider.run(runInput(1, "first"));
    const second = provider.run(runInput(2, "second"));
    await held.ready;

    expect(provider.processLeases().map((lease) => lease.invocationOwner).sort()).toEqual(["held-inv-1", "held-inv-2"]);
    await provider.interrupt({ session: { provider: "qoder", sessionId: "held-session-1" } });
    held.succeed("held-inv-2");
    expect(await first.catch((error) => error)).toSatisfy(isProviderInterruptedError);
    await expect(second).resolves.toMatchObject({ session: { sessionId: "held-session-2" } });
    expect(held.interrupted).toEqual(["held-inv-1"]);
    expect(provider.processLeases()).toEqual([]);
    expect(provider.runtimeStatus().active_sessions).toBe(0);

    const root = await fixtureRoot("xuanwu-qoder-q6-failure-");
    const database = await openDatabase({ stateDir: join(root, "state") });
    try {
      database.sqlite.run(
        `insert into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)`,
        ["failure", "failure", root, "2026-08-12T00:00:00Z", "2026-08-12T00:00:00Z"]
      );
      database.sqlite.run(
        `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
        ["failure", "Qoder failure", "in_progress", "2026-08-12T00:00:00Z", "2026-08-12T00:00:00Z"]
      );
      const issueId = Number(database.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
      const issueRunId = createIssueRun(database, issueId).id;
      const sessionId = "qoder-failed-session";
      const fake = createFakeQoderSdkFacade([
        qoderInit(sessionId),
        qoderResult(sessionId, 1, {
          errors: ["QODER_PERSONAL_ACCESS_TOKEN=fixture-secret"],
          is_error: true,
          subtype: "error_during_execution"
        })
      ]);
      const failing = new QoderExecutorProvider(buildConfig().providers.qoder!, {
        facade: fake.facade,
        invocationIdFactory: () => "qoder-failed-inv",
        readiness: readyProbe(),
        sessionIdFactory: () => sessionId
      });

      await expect(runIssueWithProvider(failing, {
        cwd: root,
        database,
        issueId,
        issueRunId,
        projectId: "failure",
        prompt: "fail safely"
      })).rejects.toThrow();
      const rows = JSON.stringify({
        events: listIssueEvents(database, issueId),
        runs: listIssueRuns(database, issueId)
      });
      expect(rows).not.toContain("fixture-secret");
      expect(listIssueRuns(database, issueId).at(-1)).toMatchObject({ status: "failed" });
      expect(database.sqlite.query<{ count: number }, [number]>(`
        select count(*) as count from run_attempts attempt
        join issue_runs run on run.id=attempt.issue_run_id
        where run.issue_id=? and attempt.status='failed'
      `).get(issueId)?.count).toBe(1);
    } finally {
      database.close();
    }
  });
});

class SequentialFacade implements QoderSdkFacade {
  readonly available = true;
  readonly calls: QoderRunOptions[] = [];

  async run(
    _prompt: string,
    options: QoderRunOptions,
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void
  ): Promise<QoderQueryResult> {
    this.calls.push({ ...options });
    const sequence = this.calls.length;
    const sessionId = options.resume ?? options.sessionId ?? "";
    onMessage?.(qoderInit(sessionId), { interrupted: false });
    if (sequence === 1) {
      onMessage?.({ type: "future_event", session_id: sessionId, uuid: "future-1" } as unknown as SDKMessage, {
        interrupted: false
      });
      onMessage?.({
        type: "assistant",
        message: {
          content: [{ text: "QODER_PERSONAL_ACCESS_TOKEN=fixture-secret", type: "text" }],
          model: "performance",
          role: "assistant"
        },
        request_id: "request-1",
        session_id: sessionId,
        uuid: "assistant-1"
      } as unknown as SDKMessage, { interrupted: false });
    }
    const result = qoderResult(sessionId, sequence);
    onMessage?.(result, { interrupted: false });
    return {
      invocationRef: options.invocationKey,
      messageRef: result.uuid,
      sessionId,
      terminal: "succeeded"
    };
  }

  activeCount(): number { return 0; }
  async listModels() { return []; }
  processLeases() { return []; }
  async interrupt(): Promise<void> { throw new Error("no active Qoder invocation"); }
  async close(): Promise<void> {}
}

class HeldFacade implements QoderSdkFacade {
  readonly available = true;
  readonly interrupted: string[] = [];
  private readonly active = new Map<string, {
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void;
    options: QoderRunOptions;
    resolve: (result: QoderQueryResult) => void;
  }>();
  private readyCount = 0;
  private resolveReady!: () => void;
  readonly ready = new Promise<void>((resolve) => { this.resolveReady = resolve; });

  run(
    _prompt: string,
    options: QoderRunOptions,
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void
  ): Promise<QoderQueryResult> {
    return new Promise((resolve) => {
      this.active.set(options.invocationKey, { onMessage, options, resolve });
      onMessage?.(qoderInit(options.sessionId ?? ""), { interrupted: false });
      this.readyCount += 1;
      if (this.readyCount === 2) this.resolveReady();
    });
  }

  async interrupt(invocationKey: string): Promise<void> {
    const active = this.active.get(invocationKey);
    if (!active) throw new Error("Qoder invocation is not active");
    this.interrupted.push(invocationKey);
    this.finish(invocationKey, true);
  }

  succeed(invocationKey: string): void { this.finish(invocationKey, false); }
  activeCount(): number { return this.active.size; }
  async listModels() { return []; }
  processLeases() {
    return [...this.active.keys()].map((invocationOwner, index) => ({
      commandLabel: "qoder-q6-fixture",
      invocationOwner,
      pid: 7_000 + index,
      startedAt: "2026-08-12T00:00:00Z"
    }));
  }
  async close(): Promise<void> { this.active.clear(); }

  private finish(invocationKey: string, interrupted: boolean): void {
    const active = this.active.get(invocationKey);
    if (!active) throw new Error("Qoder invocation is not active");
    const sessionId = active.options.sessionId ?? "";
    const result = qoderResult(sessionId, Number(invocationKey.split("-").at(-1)));
    active.onMessage?.(result, { interrupted });
    this.active.delete(invocationKey);
    active.resolve({
      invocationRef: invocationKey,
      messageRef: result.uuid,
      sessionId,
      terminal: interrupted ? "interrupted" : "succeeded"
    });
  }
}

function historyFunctions() {
  const info: SDKSessionInfo = {
    createdAt: 1_723_420_800_000,
    cwd: "/fixture/qoder-q6",
    firstPrompt: "Run the isolated Qoder fixture without network access.",
    lastModified: 1_723_420_801_000,
    sessionId: "qoder-q6-session-1",
    summary: "Qoder Q6 offline fixture"
  };
  const messages = [{
    message: { role: "user", content: "Run the fixture" },
    parent_agent_id: null,
    parent_tool_use_id: null,
    session_id: info.sessionId,
    type: "user",
    uuid: "history-user-1"
  }, {
    message: { role: "assistant", content: [{ type: "text", text: "fixture completed" }] },
    parent_agent_id: null,
    parent_tool_use_id: null,
    request_id: "history-request-1",
    session_id: info.sessionId,
    type: "assistant",
    uuid: "history-assistant-1"
  }] as unknown as SessionMessage[];
  return {
    async getSessionInfo(sessionId: string) { return sessionId === info.sessionId ? info : undefined; },
    async getSessionMessages(sessionId: string, options?: { offset?: number }) {
      return sessionId === info.sessionId && (options?.offset ?? 0) === 0 ? messages : [];
    },
    async listSessions() { return [info]; }
  };
}

function qoderInit(sessionId: string): SDKSystemInitMessage {
  return {
    apiKeySource: "none",
    cwd: "/fixture/qoder-q6",
    mcp_servers: [],
    model: "performance",
    output_style: "default",
    permissionMode: "dontAsk",
    plugins: [],
    protocol_version: "1.2.0",
    qodercli_version: "1.1.23",
    session_id: sessionId,
    skills: [],
    slash_commands: [],
    subtype: "init",
    tools: [],
    type: "system",
    uuid: `qoder-q6-init-${sessionId}`
  };
}

function qoderResult(
  sessionId: string,
  sequence: number,
  overrides: Partial<SDKResultMessage> = {}
): SDKResultMessage {
  return {
    duration_api_ms: 5,
    duration_ms: 8,
    is_error: false,
    modelUsage: {},
    num_turns: 1,
    permission_denials: [],
    result: "RUNNER_OUTCOME: completed | Qoder Q6 fixture completed",
    session_id: sessionId,
    stop_reason: "end_turn",
    subtype: "success",
    total_cost_usd: 0,
    type: "result",
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "",
      input_tokens: 10,
      iterations: [],
      output_tokens: 4,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "",
      speed: ""
    },
    uuid: `qoder-q6-result-${sequence}`,
    ...overrides
  } as SDKResultMessage;
}

function readyProbe(): QoderRuntimeProbe {
  return {
    installed: true,
    ready: true,
    status: {
      active_sessions: 0,
      api_key_configured: true,
      auth_configured: true,
      auth_mode: "pat-env",
      auth_source: "environment",
      executable_ready: true,
      mode: "sdk",
      platform_profile: {
        cli_version: "1.1.23",
        protocol_status: "expected",
        protocol_version: "1.2.0",
        sdk_ready: true,
        sdk_version: "1.0.23"
      },
      ready: true,
      version: "1.0.23"
    }
  };
}

function runInput(issueId: number, prompt: string): ProviderRunInput {
  return {
    cwd: "/fixture/qoder-q6",
    issueId,
    onEvent: () => {},
    projectId: "qoder-q6",
    prompt
  };
}

async function fixtureRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function request(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  method = "GET",
  body?: unknown
): Promise<Response> {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method,
    ...(body === undefined ? {} : {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" }
    })
  }));
}
