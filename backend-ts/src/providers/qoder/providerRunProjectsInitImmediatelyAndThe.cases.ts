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

import { qoderConfig, readyProbe, init, taskNotification, sdkResult, provider, sessionInfo, history, ConcurrentFacade } from "./providerTestFixtures.ts";

export function registerRunProjectsInitImmediatelyAndThe() {
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
}
