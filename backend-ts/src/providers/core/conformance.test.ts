import { describe, expect, test } from "bun:test";
import { createProviderRegistry } from "./registry.ts";
import { BUILTIN_FACTORIES } from "../testing/conformanceFactories.ts";
import { checkManifest } from "./conformance.ts";
import { normalizeTranscriptItem } from "./transcript.ts";
import { assertProviderSessionView } from "./sessionView.ts";
import { asProviderId } from "../types.ts";

/**
 * P12：Provider conformance harness（计划 §20 矩阵自动断言）。
 * 对三类 fixture（execution-only / resumable / full-session）断言：
 * initial execution、稳定 invocation ref、resume 拒绝/支持、interrupt 按 capability、
 * unknown event preserve。新 adapter 接入后经 factory 注册即可纳入矩阵。
 */

async function fixtureRegistry() {
  const registry = createProviderRegistry();
  for (const factory of BUILTIN_FACTORIES) registry.registerFactory(factory);
  await registry.startConfigured({});
  return registry;
}

describe("P12: conformance matrix（§20）", () => {
  test("所有已注册 fixture 通过 conformance（capability/method 一致）", async () => {
    const registry = await fixtureRegistry();
    for (const entry of registry.list()) {
      expect(entry.state).toBe("ready");
      expect(() => checkManifest(entry.manifest, entry.instance as unknown as Record<string, unknown>)).not.toThrow();
    }
  });

  test("initial execution 返回稳定 invocation ref（runId 非空）", async () => {
    const registry = await fixtureRegistry();
    for (const entry of registry.list()) {
      const instance = entry.instance!;
      const result = await instance.run({ issueId: 1, projectId: `p-${entry.id}`, cwd: "/tmp", prompt: "run", onEvent: () => {} });
      expect(result.runId).toBeTruthy();
    }
  });

  test("resume：execution-only 明确拒绝，resumable/full-session 支持", async () => {
    const registry = await fixtureRegistry();
    const executionOnly = registry.getReady(asProviderId("fake-execution-only"));
    expect(executionOnly.capabilities).not.toContain("resume_session");
    expect(typeof executionOnly.recover).toBe("undefined");
    const resumable = registry.getReady(asProviderId("fake-resumable"));
    expect(resumable.capabilities).toContain("resume_session");
    expect(typeof resumable.recover).toBe("function");
    const full = registry.getReady(asProviderId("fake-full-session"));
    expect(full.capabilities).toContain("resume_session");
    expect(typeof full.recover).toBe("function");
  });

  test("interrupt/model list 按 capability 存在", async () => {
    const registry = await fixtureRegistry();
    const executionOnly = registry.getReady(asProviderId("fake-execution-only"));
    expect(executionOnly.capabilities).not.toContain("interrupt");
    expect(executionOnly.capabilities).not.toContain("model_list");
    const full = registry.getReady(asProviderId("fake-full-session"));
    expect(full.capabilities).toContain("interrupt");
    expect(full.capabilities).toContain("model_list");
    expect(typeof full.interrupt).toBe("function");
    expect(typeof full.listModels).toBe("function");
  });

  test("声明 v1 Session 详情的 adapter 返回请求对应的通用视图", async () => {
    const registry = await fixtureRegistry();
    const full = registry.getReady(asProviderId("fake-full-session"));
    const detail = await full.readSession!("session-contract-check");

    expect(() => assertProviderSessionView(full.id, detail, {
      detail: true,
      expectedSessionRef: "session-contract-check"
    })).not.toThrow();
  });

  test("unknown event preserve（不改变状态，kind=unknown）", () => {
    const item = normalizeTranscriptItem({ kind: "mystery" }, asProviderId("codex"), 0);
    expect(item.kind).toBe("unknown");
    expect(item.id).toBeTruthy();
  });

  test("支持矩阵快照：fixture 全量 ready，无 drifted capability", async () => {
    const registry = await fixtureRegistry();
    const snapshot = registry.list().map((entry) => ({
      id: String(entry.id),
      state: entry.state,
      capabilities: entry.instance?.capabilities?.slice().sort() ?? []
    }));
    expect(snapshot).toEqual([
      { id: "fake-execution-only", state: "ready", capabilities: ["issue_execution"] },
      { id: "fake-resumable", state: "ready", capabilities: ["issue_execution", "resume_session", "sessions"] },
      {
        id: "fake-full-session",
        state: "ready",
        capabilities: ["approvals", "interrupt", "issue_execution", "model_list", "resume_session", "sessions"]
      }
    ]);
  });
});
