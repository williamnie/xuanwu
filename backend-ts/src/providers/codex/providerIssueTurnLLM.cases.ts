import { describe, expect, test } from "bun:test";
import { CodexExecutorProvider, type CodexEventHandler } from "./provider.ts";
import type { CodexInitializeResult, ThreadStartResult, ThreadSummary, TurnStartResult } from "./adapter.ts";
import type { CodexUserInput, ThreadStartInput, TurnStartOptions } from "./threadLifecycle.ts";
import type { ProviderEvent } from "../types.ts";
import { CODEX_EXECUTION_POLICY_CAPABILITIES, codexExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import { EXECUTION_ACCESS_VALUES, EXECUTION_APPROVAL_VALUES } from "../core/policyContracts.ts";

import { FakeCodexIssueAdapter, FakeCodexEventSource, FakeCodexRuntimeControl } from "./providerTestFixtures.ts";

export function registerIssueTurnLLM() {
test("Issue turn 先启动，LLM 完成后才更新默认标题，恢复时不重复生成", async () => {
    const adapter = new FakeCodexIssueAdapter();
    let complete!: (value: string | null) => void;
    const result = new Promise<string | null>((resolve) => { complete = resolve; });
    let calls = 0;
    const provider = new CodexExecutorProvider(adapter, "instructions", undefined, undefined, async (input) => {
      calls++;
      expect(input.issueId).toBe(913);
      expect(input.thread.createdAt).toBe(Date.parse("2026-09-02T16:00:00Z") / 1000);
      return result;
    });
    try {
      const run = await provider.run({ issueId: 913, projectId: "demo", cwd: "/tmp/demo", prompt: "修复消息重复" });
      expect(run.session?.turnId).toBe("turn-1");
      expect(adapter.threadName).toBe("Issue #913");
      complete("#913｜修复｜消息重复");
      await Bun.sleep(0);
      expect(adapter.threadName).toBe("#913｜修复｜消息重复");
      await provider.recover({ issueId: 913, projectId: "demo", cwd: "/tmp/demo", prompt: "继续", session: run.session! });
      expect(calls).toBe(1);
    } finally { await provider.stop(); }
  });

test("手动指定标题时不调用 LLM，后续消息仍保留标题", async () => {
    const adapter = new FakeCodexIssueAdapter();
    let calls = 0;
    const provider = new CodexExecutorProvider(adapter, "instructions", undefined, undefined, async () => { calls++; return "0903｜修复｜消息重复"; });
    try {
      await provider.createSession({ cwd: "/tmp/demo", title: "我的原始标题", prompt: "修复消息重复" });
      await provider.sendSessionMessage({ sessionId: "thread-1", prompt: "继续" });
      expect(calls).toBe(0);
      expect(adapter.threadName).toBe("我的原始标题");
    } finally { await provider.stop(); }
  });

test("空会话收到第一条消息后自动生成标题", async () => {
    const adapter = new FakeCodexIssueAdapter();
    let calls = 0;
    const provider = new CodexExecutorProvider(adapter, "instructions", undefined, undefined, async () => { calls++; return "0903｜修复｜消息重复"; });
    try {
      await provider.createSession({ cwd: "/tmp/demo" });
      expect(calls).toBe(0);
      await provider.sendSessionMessage({ sessionId: "thread-1", prompt: "修复消息重复" });
      await Bun.sleep(0);
      expect(calls).toBe(1);
      expect(adapter.threadName).toBe("0903｜修复｜消息重复");
    } finally { await provider.stop(); }
  });

test("starts a Codex thread and one issue turn", async () => {
    const adapter = new FakeCodexIssueAdapter();
    const events: unknown[] = [];
    const result = await new CodexExecutorProvider(adapter).run({
      issueId: 160,
      projectId: "demo",
      cwd: "/tmp/demo",
      prompt: "issue body",
      model: "codex-default",
      reasoningEffort: "high",
      serviceTier: "priority",
      approvalPolicy: "never",
      sandbox: "workspace-write",
      onEvent: (event) => events.push(event)
    });

    expect(result).toEqual({
      runId: "codex:thread-1:turn-1",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" }
    });
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      provider: "codex",
      type: "provider.session_started",
      status: "running",
      session: { provider: "codex", sessionId: "thread-1" }
    });
    expect(events[1]).toMatchObject({
      provider: "codex",
      type: "turn_started",
      status: "inProgress",
      session: { provider: "codex", sessionId: "thread-1", turnId: "turn-1" },
      runEvent: {
        contract: "xw.run-event.v1",
        kind: "started",
        metadata: {
          model: "codex-default",
          protocol_version: "fixture",
          service_tier: "priority"
        },
        outcome: "running",
        terminal: false
      }
    });
    expect(adapter.calls).toEqual([
      { method: "initialize" },
      {
        method: "thread/start",
        params: {
          cwd: "/tmp/demo",
          model: "codex-default",
          reasoningEffort: "high",
          serviceTier: "priority",
          approvalPolicy: "never",
          sandbox: "workspace-write",
          developerInstructions: "Keep changes scoped to the runner issue. You are executing an Issue already claimed by Xuanwu. Never use Xuanwu CLI or API lifecycle commands to create, deduplicate, enqueue, retry, cancel, delete, or change the status of the current Issue, and never stop its current Run. Report the result with the RUNNER_OUTCOME marker required by the execution context; the Host reconciles the Run and PI alone decides semantic Issue status.",
          threadSource: "subagent"
        }
      },
      { method: "thread/name/set", params: { threadID: "thread-1", name: "Issue #160" } },
      {
        method: "turn/start",
        params: {
          threadID: "thread-1",
          input: [{ type: "text", text: "issue body", text_elements: [] }],
          options: {
            model: "codex-default",
            reasoningEffort: "high",
            serviceTier: "priority",
            approvalPolicy: "never",
            sandbox: "workspace-write"
          }
        }
      }
    ]);
  });

test("resolved policy is applied consistently to Codex thread and turn options", async () => {
    const sandboxByAccess = {
      "read-only": "read-only",
      "provider-native-development": "workspace-write",
      "unrestricted-host": "danger-full-access"
    } as const;
    const approvalByRequest = {
      unattended: "never",
      "ask-sensitive": "on-request",
      "ask-every-side-effect": "untrusted"
    } as const;
    for (const access of EXECUTION_ACCESS_VALUES) {
      for (const approval of EXECUTION_APPROVAL_VALUES) {
        const adapter = new FakeCodexIssueAdapter();
        const policy = resolveExecutionPolicy({ contract: "xw.execution-policy.v1", access, approval }, {
          cwd: "/tmp/demo",
          invocationRef: `codex-${access}-${approval}`,
          projectId: "demo",
          providerId: "codex",
          providerVersion: "0.146.0",
          source: "local-user",
          transport: "rpc"
        }, CODEX_EXECUTION_POLICY_CAPABILITIES, codexExecutionPolicyAdapter);
        await new CodexExecutorProvider(adapter).run({
          issueId: 170,
          projectId: "demo",
          cwd: "/tmp/demo",
          prompt: "policy",
          approvalPolicy: "legacy-must-not-win",
          sandbox: "legacy-must-not-win",
          policy
        });
        const expected = { approvalPolicy: approvalByRequest[approval], sandbox: sandboxByAccess[access] };
        expect(adapter.calls.find((call) => call.method === "thread/start")?.params).toMatchObject(expected);
        expect((adapter.calls.find((call) => call.method === "turn/start")?.params as { options?: unknown })?.options).toMatchObject(expected);
      }
    }
  });
}
