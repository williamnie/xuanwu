import { describe, expect, test } from "bun:test";
import type { SDKMessage, SDKResultMessage, SDKSessionInfo, SDKSystemInitMessage, SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import { checkManifest } from "../core/conformance.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { asProviderId, isProviderInterruptedError, type ProviderEvent } from "../types.ts";
import { qoderFactory, qoderManifest } from "./factory.ts";
import { QoderExecutorProvider } from "./provider.ts";
import {
  createFakeQoderSdkFacade,
  type QoderQueryResult,
  type QoderRunOptions,
  type QoderSdkFacade
} from "./sdkFacade.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";
import type { QoderSessionFunctions } from "./sessionHistory.ts";

const qoderConfig = buildConfig().providers.qoder!;
const readyProbe: QoderRuntimeProbe = {
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
    ready: true,
    version: "1.0.23",
    platform_profile: { cli_version: "1.1.23", protocol_version: "1.2.0", sdk_version: "1.0.23" }
  }
};

function init(sessionId = "qoder-session-9"): SDKSystemInitMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    qodercli_version: "1.1.23",
    protocol_version: "1.2.0",
    cwd: "/fixture/project",
    tools: [],
    mcp_servers: [],
    model: "performance",
    permissionMode: "dontAsk",
    slash_commands: [],
    output_style: "default",
    skills: [],
    plugins: [],
    uuid: "init-1",
    session_id: sessionId
  };
}

function taskNotification(status: "completed" | "failed" | "stopped", sessionId = "qoder-session-9"): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "t1",
    status,
    output_file: "",
    summary: "subagent update",
    uuid: `task-${status}`,
    session_id: sessionId
  };
}

function sdkResult(sessionId = "qoder-session-9", overrides: Partial<SDKResultMessage> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 12,
    duration_api_ms: 8,
    is_error: false,
    num_turns: 1,
    result: "ok",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      inference_geo: "",
      input_tokens: 1,
      iterations: [],
      output_tokens: 1,
      server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
      service_tier: "",
      speed: ""
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "result-1",
    session_id: sessionId,
    ...overrides
  } as SDKResultMessage;
}

function provider(
  facade: QoderSdkFacade,
  ids: { invocation?: string; session?: string } = {},
  sessionFunctions?: Partial<QoderSessionFunctions>
): QoderExecutorProvider {
  return new QoderExecutorProvider(qoderConfig, {
    facade,
    invocationIdFactory: () => ids.invocation ?? "qoder-inv-1",
    readiness: readyProbe,
    sessionIdFactory: () => ids.session ?? "qoder-session-9",
    sessionFunctions
  });
}

describe("Qoder Q2 executor lifecycle", () => {
  test("run projects init immediately and the main result owns refs and terminal", async () => {
    const events: ProviderEvent[] = [];
    const { facade } = createFakeQoderSdkFacade([init(), taskNotification("completed"), sdkResult()]);
    const result = await provider(facade).run({
      issueId: 1, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: (event) => events.push(event)
    });

    expect(result).toEqual({
      runId: "qoder-inv-1",
      session: { provider: "qoder", sessionId: "qoder-session-9", turnId: "result-1" }
    });
    expect(events[0]).toMatchObject({
      type: "provider.session_started",
      session: { sessionId: "qoder-session-9" },
      runEvent: { contract: "xw.run-event.v1", kind: "started", terminal: false }
    });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      session: { sessionId: "qoder-session-9", turnId: "result-1" },
      runEvent: { kind: "completed", outcome: "succeeded", terminal: true }
    });
  });

  test("task_notification failure remains subagent progress and cannot terminate the main Attempt", async () => {
    const events: ProviderEvent[] = [];
    const { facade } = createFakeQoderSdkFacade([init("s-main"), taskNotification("failed", "s-main"), sdkResult("s-main")]);
    await provider(facade, { session: "s-main" }).run({
      issueId: 1, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: (event) => events.push(event)
    });

    const task = events.find((event) => event.type === "subagent.failed");
    expect(task?.runEvent).toMatchObject({ kind: "progress", outcome: "running", terminal: false });
    expect(events.filter((event) => event.runEvent?.terminal)).toHaveLength(1);
    expect(events.at(-1)?.runEvent?.outcome).toBe("succeeded");
  });

  test("recover passes resume and never aliases the historical ref as a new sessionId", async () => {
    const { facade, calls } = createFakeQoderSdkFacade([init("orig-1"), sdkResult("orig-1")]);
    const result = await provider(facade).recover({
      issueId: 2,
      projectId: "p",
      cwd: "/tmp",
      prompt: "continue",
      session: { provider: "qoder", sessionId: "orig-1" },
      onEvent: () => {}
    });

    expect(result.session).toEqual({ provider: "qoder", sessionId: "orig-1", turnId: "result-1" });
    expect(calls[0]).toMatchObject({ cwd: "/tmp", invocationKey: "qoder-inv-1", resume: "orig-1" });
    expect(calls[0]?.sessionId).toBeUndefined();
  });

  test("SDK exception, no-result and result-before-init fail closed with one terminal error each", async () => {
    for (const messages of [[init(), "throw" as const], [init()], [sdkResult()]]) {
      const events: ProviderEvent[] = [];
      const { facade } = createFakeQoderSdkFacade(messages);
      await expect(provider(facade).run({
        issueId: 3, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: (event) => events.push(event)
      })).rejects.toThrow();
      expect(events.filter((event) => event.runEvent?.terminal)).toHaveLength(1);
      expect(events.at(-1)).toMatchObject({ type: "error", runEvent: { outcome: "failed", terminal: true } });
    }
  });

  test("preflight failure does not publish a synthetic Provider Session", async () => {
    const events: ProviderEvent[] = [];
    const { facade } = createFakeQoderSdkFacade(["throw"]);

    await expect(provider(facade, { session: "synthetic-session" }).run({
      issueId: 3,
      projectId: "p",
      cwd: "/tmp",
      prompt: "go",
      onEvent: (event) => events.push(event)
    })).rejects.toThrow();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "error", runEvent: { outcome: "failed", terminal: true } });
    expect(events[0]?.session).toBeUndefined();
    expect(events[0]?.runEvent?.metadata.provider_session_id).toBeUndefined();
  });

  test("result error and duplicate result never become fake success", async () => {
    const failed = sdkResult("qoder-session-9", {
      subtype: "error_during_execution",
      is_error: true,
      errors: ["QODER_PERSONAL_ACCESS_TOKEN=fixture-secret"]
    });
    for (const messages of [[init(), failed], [init(), sdkResult(), sdkResult("qoder-session-9", { uuid: "result-2" })]]) {
      const events: ProviderEvent[] = [];
      const { facade } = createFakeQoderSdkFacade(messages);
      await expect(provider(facade).run({
        issueId: 4, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: (event) => events.push(event)
      })).rejects.toThrow();
      expect(events.filter((event) => event.runEvent?.terminal)).toHaveLength(1);
      expect(JSON.stringify(events)).not.toContain("fixture-secret");
    }
  });

  test("explicit interrupt without a main result emits exactly one terminal", async () => {
    const events: ProviderEvent[] = [];
    const { facade } = createFakeQoderSdkFacade([init()], { terminal: "interrupted" });
    const failure = await provider(facade).run({
      issueId: 5, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: (event) => events.push(event)
    }).catch((error) => error);

    expect(failure).toSatisfy(isProviderInterruptedError);
    expect(events.filter((event) => event.runEvent?.terminal)).toHaveLength(1);
    expect(events.at(-1)?.runEvent?.outcome).toBe("interrupted");
  });

  test("two concurrent fake queries can interrupt one invocation without crossing or leaking", async () => {
    const facade = new ConcurrentFacade();
    let invocation = 0;
    let session = 0;
    const subject = new QoderExecutorProvider(qoderConfig, {
      facade,
      invocationIdFactory: () => `inv-${++invocation}`,
      readiness: readyProbe,
      sessionIdFactory: () => `session-${++session}`
    });
    const eventsOne: ProviderEvent[] = [];
    const eventsTwo: ProviderEvent[] = [];
    const first = subject.run({
      issueId: 10, projectId: "p", cwd: "/tmp", prompt: "one", onEvent: (event) => eventsOne.push(event)
    });
    const second = subject.run({
      issueId: 11, projectId: "p", cwd: "/tmp", prompt: "two", onEvent: (event) => eventsTwo.push(event)
    });
    await facade.ready;

    expect(subject.processLeases().map((lease) => lease.invocationOwner).sort()).toEqual(["inv-1", "inv-2"]);

    await subject.interrupt({ session: { provider: "qoder", sessionId: "session-1" } });
    expect(subject.processLeases().map((lease) => lease.invocationOwner)).toEqual(["inv-2"]);
    facade.succeed("inv-2");

    expect(await first.catch((error) => error)).toSatisfy(isProviderInterruptedError);
    await expect(second).resolves.toEqual({
      runId: "inv-2",
      session: { provider: "qoder", sessionId: "session-2", turnId: "result-inv-2" }
    });
    expect(facade.interrupted).toEqual(["inv-1"]);
    expect(eventsOne.filter((event) => event.runEvent?.terminal)).toHaveLength(1);
    expect(eventsOne.at(-1)?.runEvent?.outcome).toBe("interrupted");
    expect(eventsTwo.at(-1)?.runEvent?.outcome).toBe("succeeded");
    expect(subject.runtimeStatus().active_sessions).toBe(0);
    expect(subject.processLeases()).toEqual([]);
  });
});

describe("Qoder Q2 factory conformance", () => {
  test("manifest capabilities match the implemented provider surface", () => {
    const manifest = qoderManifest();
    const subject = provider(createFakeQoderSdkFacade([init(), sdkResult()]).facade);
    expect(() => checkManifest(manifest, subject as unknown as Record<string, unknown>)).not.toThrow();
    expect(manifest).toMatchObject({
      supportLevel: "preview",
      capabilities: {
        issueExecution: true,
        sessions: { create: true, resume: true, list: true, read: true },
        control: { interrupt: true, approvals: "host-callback" },
        models: { list: true, switchDuringSession: false },
        usage: { tokens: "attempt" }
      },
      processObservability: "lease"
    });
    expect(manifest.sessionPresentation?.viewContract).toBe("xw.provider-session.v1");
  });

  test("factory registers Qoder as ready with the fake runtime", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(qoderFactory({
      facade: createFakeQoderSdkFacade([init(), sdkResult()]).facade,
      runtimeProbe: () => readyProbe
    }));
    await registry.startConfigured({});
    expect(registry.list().map((entry) => String(entry.id))).toContain("qoder");
    expect(registry.describe(asProviderId("qoder")).state).toBe("ready");
  });
});

describe("Qoder Q5 models and usage", () => {
  test("live model discovery exposes only Qoder metadata and constrains effort choices", async () => {
    const fake = createFakeQoderSdkFacade([init(), sdkResult()]);
    fake.facade.listModels = async () => [{
      value: "performance",
      displayName: "Qoder Performance",
      description: "fixture",
      efforts: ["low", "high"],
      defaultEffort: "high",
      isDefault: true,
      isEnabled: true,
      priceFactor: 1.5
    }];

    await expect(provider(fake.facade).listModels()).resolves.toEqual([{
      creditsMultiplier: 1.5,
      defaultReasoningEffort: "high",
      displayName: "Qoder Performance",
      id: "performance",
      isDefault: true,
      model: "performance",
      source: "qoder_account_live",
      supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
      verified: true
    }]);
  });

  test("failed discovery returns marked Qoder suggestions without Codex model leakage", async () => {
    const fake = createFakeQoderSdkFacade([init(), sdkResult()]);
    fake.facade.listModels = async () => { throw new Error("QODER_PERSONAL_ACCESS_TOKEN=fixture-secret"); };

    const models = await provider(fake.facade).listModels() as Array<Record<string, unknown>>;
    expect(models.map((model) => model.id)).toEqual(["auto", "ultimate", "performance", "efficient", "lite"]);
    expect(models.every((model) => model.verified === false && model.source === "static_suggestion")).toBe(true);
    expect(models.every((model) => model.warning === "账号模型发现失败；请从 Qoder 静态建议中选择")).toBe(true);
    expect(JSON.stringify(models)).not.toContain("fixture-secret");
    expect(JSON.stringify(models)).not.toMatch(/gpt-|codex-default/);
  });

  test("multiple attempts do not re-add resume usage with unknown cumulative semantics", async () => {
    const initialEvents: ProviderEvent[] = [];
    const initial = createFakeQoderSdkFacade([init("resume-1"), sdkResult("resume-1", {
      usage: { ...sdkResult().usage, input_tokens: 100, output_tokens: 50, credits: 2 }
    })]);
    await provider(initial.facade, { session: "resume-1" }).run({
      issueId: 2,
      projectId: "p",
      cwd: "/fixture/project",
      prompt: "start",
      onEvent: (event) => initialEvents.push(event)
    });

    const resumedEvents: ProviderEvent[] = [];
    const resumed = createFakeQoderSdkFacade([init("resume-1"), sdkResult("resume-1", {
      total_credits: 9,
      usage: { ...sdkResult().usage, input_tokens: 100, output_tokens: 50, credits: 2 }
    })]);
    await provider(resumed.facade).recover({
      issueId: 2,
      projectId: "p",
      cwd: "/fixture/project",
      prompt: "continue",
      session: { provider: "qoder", sessionId: "resume-1" },
      onEvent: (event) => resumedEvents.push(event)
    });

    const initialTerminal = initialEvents.at(-1)!;
    const terminal = resumedEvents.at(-1)!;
    expect(initialTerminal.runEvent?.cost?.usage).toMatchObject({ input_tokens: 100, output_tokens: 50, total_tokens: 150 });
    expect(terminal.runEvent?.cost).toBeUndefined();
    expect(terminal.runEvent?.metadata.usage_scope).toBe("resume_semantics_unverified");
    expect(terminal.raw?.payload).toMatchObject({
      usage_projection: {
        credits: {
          request: { provenance: "result.usage", value: 2 },
          session: { provenance: "result.total_credits", semantics: "session_cumulative_unverified", value: 9 }
        },
        money: { completeness: "unavailable", reason: "qoder_credits_are_not_currency" }
      }
    });
  });
});

describe("Qoder Q3 Sessions", () => {
  const sessionInfo: SDKSessionInfo = {
    sessionId: "qoder-session-9",
    summary: "Qoder session",
    firstPrompt: "hello",
    cwd: "/fixture/project",
    createdAt: 1_700_000_000_000,
    lastModified: 1_700_000_100_000
  };
  const history = [{
    type: "user",
    uuid: "user-1",
    session_id: sessionInfo.sessionId,
    message: { role: "user", content: "hello" },
    parent_tool_use_id: null,
    parent_agent_id: null
  }] as SessionMessage[];

  test("lists and reads normalized history with bounded cursors", async () => {
    const calls: unknown[] = [];
    const subject = provider(createFakeQoderSdkFacade([init(), sdkResult()]).facade, {}, {
      async listSessions(options) {
        calls.push(options);
        return Array.from({ length: 100 }, (_, index) => ({
          ...sessionInfo,
          sessionId: `qoder-session-${index + 9}`
        }));
      },
      async getSessionInfo() { return sessionInfo; },
      async getSessionMessages(_id, options) { calls.push(options); return (options?.offset ?? 0) === 0 ? history : []; }
    });

    const list = await subject.listSessions({ cursor: "40", cwd: "/fixture/project", limit: 500 });
    const detail = await subject.readSession(sessionInfo.sessionId);

    expect(list.nextCursor).toBe("140");
    expect(list.data).toHaveLength(100);
    expect(list.data[0]).toMatchObject({ id: "qoder:qoder-session-9" });
    expect(detail).toMatchObject({
      session_contract: "xw.provider-session.v1",
      id: "qoder:qoder-session-9",
      provider_version: "1.0.23",
      cli_version: "1.1.23",
      turns: [{ items: [{ type: "userMessage" }] }]
    });
    expect(calls[0]).toEqual({ dir: "/fixture/project", limit: 100, offset: 40 });
    expect(calls[1]).toMatchObject({ dir: "/fixture/project", includeSystemMessages: true, limit: 100, offset: 0 });
  });

  test("resumes only an existing history with options.resume and returns the same session plus a new result ref", async () => {
    const fake = createFakeQoderSdkFacade([init(), sdkResult()]);
    const subject = provider(fake.facade, {}, {
      async getSessionInfo() { return sessionInfo; },
      async getSessionMessages() { return history; },
      async listSessions() { return [sessionInfo]; }
    });

    const result = await subject.sendSessionMessage({ sessionId: sessionInfo.sessionId, prompt: "continue" });
    expect(result).toEqual({
      provider: "qoder",
      provider_session_id: sessionInfo.sessionId,
      sessionId: sessionInfo.sessionId,
      turn_id: "result-1"
    });
    expect(fake.calls[0]).toMatchObject({ resume: sessionInfo.sessionId });
    expect(fake.calls[0]?.sessionId).toBeUndefined();
  });

  test("missing resume history fails before a model invocation instead of creating an empty session", async () => {
    const fake = createFakeQoderSdkFacade([init(), sdkResult()]);
    const subject = provider(fake.facade, {}, {
      async getSessionInfo() { return undefined; },
      async getSessionMessages() { return []; },
      async listSessions() { return []; }
    });

    await expect(subject.sendSessionMessage({ sessionId: "missing", prompt: "continue" })).rejects.toThrow("refusing to create");
    expect(fake.calls).toEqual([]);
  });

  test("known metadata with an empty transcript also fails before resume", async () => {
    const fake = createFakeQoderSdkFacade([init(), sdkResult()]);
    const subject = provider(fake.facade, {}, {
      async getSessionInfo() { return sessionInfo; },
      async getSessionMessages() { return []; },
      async listSessions() { return []; }
    });

    await expect(subject.sendSessionMessage({ sessionId: sessionInfo.sessionId, prompt: "continue" })).rejects.toThrow("history is empty");
    expect(fake.calls).toEqual([]);
  });

  test("empty known history reads as an empty transcript while an unknown session fails", async () => {
    const known = provider(createFakeQoderSdkFacade([]).facade, {}, {
      async getSessionInfo() { return sessionInfo; },
      async getSessionMessages() { return []; },
      async listSessions() { return []; }
    });
    const missing = provider(createFakeQoderSdkFacade([]).facade, {}, {
      async getSessionInfo() { return undefined; },
      async getSessionMessages() { return []; },
      async listSessions() { return []; }
    });

    await expect(known.readSession(sessionInfo.sessionId)).resolves.toMatchObject({ turns: [] });
    await expect(missing.readSession("missing")).rejects.toThrow("was not found");
  });
});

class ConcurrentFacade implements QoderSdkFacade {
  readonly available = true;
  readonly interrupted: string[] = [];
  private readonly active = new Map<string, {
    onMessage?: (message: SDKMessage, context: { interrupted: boolean }) => void;
    options: QoderRunOptions;
    resolve: (outcome: QoderQueryResult) => void;
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
      onMessage?.(init(options.sessionId), { interrupted: false });
      this.readyCount += 1;
      if (this.readyCount === 2) this.resolveReady();
    });
  }

  async interrupt(invocationKey: string): Promise<void> {
    const active = this.active.get(invocationKey);
    if (!active) throw new Error("not active");
    this.interrupted.push(invocationKey);
    const sessionId = active.options.sessionId ?? "";
    const result = sdkResult(sessionId, { uuid: `result-${invocationKey}` });
    active.onMessage?.(result, { interrupted: true });
    this.active.delete(invocationKey);
    active.resolve({
      invocationRef: invocationKey,
      messageRef: result.uuid,
      sessionId,
      terminal: "interrupted"
    });
  }

  succeed(invocationKey: string): void {
    const active = this.active.get(invocationKey);
    if (!active) throw new Error("not active");
    const sessionId = active.options.sessionId ?? "";
    const result = sdkResult(sessionId, { uuid: `result-${invocationKey}` });
    active.onMessage?.(result, { interrupted: false });
    this.active.delete(invocationKey);
    active.resolve({
      invocationRef: invocationKey,
      messageRef: result.uuid,
      sessionId,
      terminal: "succeeded"
    });
  }

  activeCount(): number { return this.active.size; }
  async listModels() { return []; }
  processLeases() {
    return [...this.active.keys()].map((invocationOwner, index) => ({
      commandLabel: "fake-qoder",
      invocationOwner,
      pid: 1000 + index,
      startedAt: "2026-08-12T00:00:00Z"
    }));
  }
  async close(): Promise<void> { this.active.clear(); }
}
