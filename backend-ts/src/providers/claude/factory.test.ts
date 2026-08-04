import { describe, expect, test } from "bun:test";
import { asProviderId } from "../types.ts";
import { createProviderRegistry } from "../core/registry.ts";
import { catalogEntryFromRegistry } from "../core/catalog.ts";
import { claudeFactory, claudeManifest } from "./factory.ts";

describe("P8: Claude manifest 只声明实际实现（preview parity）", () => {
  test("capability 仅含 SDK/CLI 实际实现（无 approvals/model_list），supportLevel=preview", () => {
    const manifest = claudeManifest();
    expect(String(manifest.id)).toBe("claude");
    expect(manifest.supportLevel).toBe("preview");
    expect(manifest.capabilities.issueExecution).toBe(true);
    expect(manifest.capabilities.sessions?.create).toBe(true);
    expect(manifest.capabilities.sessions?.resume).toBe(true);
    expect(manifest.capabilities.control?.interrupt).toBe(true);
    // 未实现的不声明
    expect(manifest.capabilities.control?.approvals).toBe("none");
    expect(manifest.capabilities.models?.list).toBe(false);
    // 不出现 Codex 假设
    expect(manifest.sessionPresentation).toBeUndefined();
    expect(manifest.capabilities.sessions?.steerWhileRunning).toBe(false);
  });

  test("SDK 与 CLI transport 共享同一 manifest", () => {
    const manifest = claudeManifest();
    expect(manifest.transports).toEqual(expect.arrayContaining(["sdk", "stdio-json"]));
    expect(manifest.executionSettings?.settings.map((s) => s.key)).toEqual(["model", "mode", "auth_mode"]);
  });
});

describe("P8: Claude factory 经 registry 装配", () => {
  test("注册后 catalog 可见且 session actions 按 capability 投影", async () => {
    const registry = createProviderRegistry();
    registry.registerFactory(claudeFactory({}));
    await registry.startConfigured({ claude: { mode: "sdk", env: {} } });
    const catalog = catalogEntryFromRegistry(registry.describe(asProviderId("claude")));
    expect(catalog.submittable).toBe(true);
    expect(catalog.session_actions).toEqual(expect.arrayContaining(["create", "resume", "interrupt"]));
    // Claude 无 approvals → 不显示 approval action 相关能力
    expect(catalog.legacy_capabilities).not.toContain("approvals");
    expect(catalog.legacy_capabilities).not.toContain("model_list");
    expect(catalog.native_actions).toEqual([]);
  });
});
