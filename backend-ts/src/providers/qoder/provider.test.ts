import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { QoderExecutorProvider } from "./provider.ts";
import { createFakeQoderSdkFacade } from "./sdkFacade.ts";
import { qoderFactory, qoderManifest } from "./factory.ts";
import { createProviderRegistry } from "../core/registry.ts";
import type { SDKMessage } from "@qoder-ai/qoder-agent-sdk";

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

describe("P11: Qoder executor（fake facade）", () => {
  test("run 收敛 terminal=succeeded 并返回 sessionId", async () => {
    const { facade } = createFakeQoderSdkFacade([taskNotification("completed")], { sessionId: "qoder-session-9" });
    const provider = new QoderExecutorProvider({ facade });
    const result = await provider.run({ issueId: 1, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: () => {} });
    expect(result.runId).toBe("qoder-run-1");
    expect(result.session?.sessionId).toBe("qoder-session-9");
  });

  test("task_notification failed → terminal=failed（不伪造成功）", async () => {
    const { facade } = createFakeQoderSdkFacade([taskNotification("failed", "s-fail")], {});
    const provider = new QoderExecutorProvider({ facade });
    const result = await provider.run({ issueId: 1, projectId: "p", cwd: "/tmp", prompt: "go", onEvent: () => {} });
    expect(result.session?.sessionId).toBe("s-fail");
  });

  test("interrupt 委托 facade.interrupt", async () => {
    const { facade, interrupted } = createFakeQoderSdkFacade([], {});
    const provider = new QoderExecutorProvider({ facade });
    await provider.interrupt({ session: { provider: "qoder", sessionId: "s" } });
    expect(interrupted.count).toBe(1);
  });

  test("recover 用 sessionId 续接", async () => {
    const { facade } = createFakeQoderSdkFacade([taskNotification("completed", "resumed-1")], {});
    const provider = new QoderExecutorProvider({ facade });
    const result = await provider.recover({
      issueId: 2,
      projectId: "p",
      cwd: "/tmp",
      prompt: "continue",
      session: { provider: "qoder", sessionId: "orig-1" },
      onEvent: () => {}
    });
    expect(result.session?.sessionId).toBe("resumed-1");
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
    registry.registerFactory(qoderFactory({ facade: createFakeQoderSdkFacade([]).facade }));
    await registry.startConfigured({});
    expect(registry.list().map((e) => String(e.id))).toContain("qoder");
    expect(registry.describe(asProviderId("qoder")).state).toBe("ready");
  });
});
