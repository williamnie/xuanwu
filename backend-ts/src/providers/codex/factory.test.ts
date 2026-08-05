import { describe, expect, test } from "bun:test";
import { createProviderRegistry } from "../core/registry.ts";
import { catalogEntryFromRegistry } from "../core/catalog.ts";
import { executionRefFromSessionRef, sessionRefFromExecutionRef, type ProviderExecutionRef } from "../types.ts";
import { codexFactory, codexManifest } from "./factory.ts";

describe("P7: Codex manifest 全能力", () => {
  test("manifest 声明 session/interrupt/approval/model_list + native action", () => {
    const manifest = codexManifest();
    expect(String(manifest.id)).toBe("codex");
    expect(manifest.supportLevel).toBe("tested");
    expect(manifest.capabilities.issueExecution).toBe(true);
    expect(manifest.capabilities.sessions?.resume).toBe(true);
    expect(manifest.capabilities.sessions?.create).toBe(true);
    expect(manifest.capabilities.control?.interrupt).toBe(true);
    expect(manifest.capabilities.control?.approvals).toBe("host-callback");
    expect(manifest.capabilities.models?.list).toBe(true);
    expect(manifest.sessionPresentation?.viewContract).toBe("xw.provider-session.v1");
    expect(manifest.sessionPresentation?.nativeActions?.[0]).toMatchObject({ id: "open-in-codex-app", kind: "open-in-app" });
  });

  test("thread/turn 映射为 session/message refs（legacyProjection 单一来源）", () => {
    const ref: ProviderExecutionRef = executionRefFromSessionRef(
      { provider: "codex", sessionId: "thread-abc", turnId: "turn-42" },
      "inv-1"
    );
    expect(ref).toMatchObject({ sessionRef: "thread-abc", messageRef: "turn-42", invocationRef: "inv-1" });
    // 回程
    const legacy = sessionRefFromExecutionRef(ref);
    expect(legacy).toEqual({ provider: "codex", sessionId: "thread-abc", turnId: "turn-42" });
  });
});

describe("P7: Codex factory 经 registry 装配", () => {
  test("注册后 getReady/list 发现（无需白名单改动），catalog 输出 native action 与 session actions", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(codexFactory({}));
    await registry.startConfigured({ codex: { command: "codex" } });
    expect(String(registry.getReady(registryEntryId("codex")).id)).toBe("codex");
    expect(registry.list().map((e) => String(e.id))).toContain("codex");
    const catalog = catalogEntryFromRegistry(registry.describe(registryEntryId("codex")));
    expect(catalog.session_actions).toEqual(expect.arrayContaining(["create", "resume", "interrupt"]));
    expect(catalog.native_actions).toHaveLength(1);
    expect(catalog.settings.settings.length).toBeGreaterThan(0);
    expect(catalog.legacy_capabilities).toEqual(
      expect.arrayContaining(["issue_execution", "sessions", "resume_session", "interrupt", "approvals", "model_list"])
    );
  });
});

function registryEntryId(id: string) {
  // 复用 types.ts 的 branded 校验（避免此处重复实现）
  const { asProviderId } = require("../types.ts") as typeof import("../types.ts");
  return asProviderId(id);
}
