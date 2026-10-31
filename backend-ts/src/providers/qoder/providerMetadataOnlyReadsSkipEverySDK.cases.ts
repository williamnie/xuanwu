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

export function registerMetadataOnlyReadsSkipEverySDK() {
test("metadata-only reads skip every SDK message page", async () => {
    const { facade } = createFakeQoderSdkFacade([]);
    let reads = 0;
    const subject = provider(facade, {}, {
      getSessionInfo: async () => ({ sessionId: "metadata", summary: "Summary", lastModified: 2000 }),
      getSessionMessages: async () => { reads++; throw new Error("Transcript must not be read"); },
    });
    expect(await subject.readSession("metadata", { includeTurns: false })).toMatchObject({ id: "qoder:metadata", turns: [] });
    expect(reads).toBe(0);
  });

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
}
