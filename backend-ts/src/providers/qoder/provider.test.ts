import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { QoderExecutorProvider } from "./provider.ts";
import { createFakeQoderSdkFacade } from "./sdkFacade.ts";
import { qoderFactory, qoderManifest } from "./factory.ts";
import { createProviderRegistry } from "../core/registry.ts";
import type { SDKMessage, SDKResultMessage } from "@qoder-ai/qoder-agent-sdk";
import { buildConfig } from "../../config/env.ts";
import type { QoderRuntimeProbe } from "./runtime.ts";

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
    version: "1.0.20"
  }
};

function taskNotification(status: "completed" | "failed" | "stopped", sessionId = "qoder-session-9"): SDKMessage {
  return {
    type: "system",
    subtype: "task_notification",
    task_id: "t1",
    status,
    output_file: "",
    summary: "",
    uuid: "u1",
    session_id: sessionId
  } as SDKMessage;
}

function sdkResult(sessionId = "qoder-session-9"): SDKResultMessage {
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
    session_id: sessionId
  };
}

describe("P11: Qoder executor（fake facade）", () => {
  test("run 收敛 terminal=succeeded 并返回 sessionId", async () => {
    const { facade } = createFakeQoderSdkFacade([taskNotification("completed"), sdkResult()]);
    const provider = new QoderExecutorProvider(qoderConfig, { facade, readiness: readyProbe });
    const result = await provider.run({ issueId: 1, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: () => {} });
    expect(result.runId).toBe("qoder-run-1");
    expect(result.session?.sessionId).toBe("qoder-session-9");
  });

  test("task_notification failed 后的主 result 仍是唯一终态", async () => {
    const { facade } = createFakeQoderSdkFacade([taskNotification("failed", "s-main"), sdkResult("s-main")]);
    const provider = new QoderExecutorProvider(qoderConfig, { facade, readiness: readyProbe });
    const result = await provider.run({ issueId: 1, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: () => {} });
    expect(result.session?.sessionId).toBe("s-main");
  });

  test("interrupt 委托 facade.interrupt", async () => {
    const { facade, interrupted } = createFakeQoderSdkFacade([], {});
    const provider = new QoderExecutorProvider(qoderConfig, { facade, readiness: readyProbe });
    await provider.interrupt({ session: { provider: "qoder", sessionId: "s" } });
    expect(interrupted.count).toBe(1);
  });

  test("recover 用 resume 续接，不能把历史 ref 填入 sessionId", async () => {
    const { facade, calls } = createFakeQoderSdkFacade([sdkResult("orig-1")]);
    const provider = new QoderExecutorProvider(qoderConfig, { facade, readiness: readyProbe });
    const result = await provider.recover({
      issueId: 2,
      projectId: "p",
      cwd: "/tmp",
      prompt: "continue",
      session: { provider: "qoder", sessionId: "orig-1" },
      onEvent: () => {}
    });
    expect(result.session?.sessionId).toBe("orig-1");
    expect(calls).toEqual([{ resume: "orig-1", model: undefined }]);
    expect(calls[0]?.sessionId).toBeUndefined();
  });
});

describe("P11: Qoder factory 与 manifest", () => {
  test("manifest 只声明实际实现（无 list/read/model list）", () => {
    const manifest = qoderManifest();
    expect(String(manifest.id)).toBe("qoder");
    expect(manifest.supportLevel).toBe("preview");
    expect(manifest.capabilities.issueExecution).toBe(true);
    expect(manifest.capabilities.sessions?.create).toBe(true);
    expect(manifest.capabilities.sessions?.resume).toBe(true);
    expect(manifest.capabilities.sessions?.list).toBe(false);
    expect(manifest.capabilities.control?.interrupt).toBe(true);
    expect(manifest.capabilities.models?.list).toBe(false);
  });

  test("factory 注册后可发现且 ready", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(qoderFactory({
      facade: createFakeQoderSdkFacade([]).facade,
      runtimeProbe: () => readyProbe
    }));
    await registry.startConfigured({});
    expect(registry.list().map((e) => String(e.id))).toContain("qoder");
    expect(registry.describe(asProviderId("qoder")).state).toBe("ready");
  });
});
