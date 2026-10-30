import { describe, expect, test } from "bun:test";
import { codexAppServerRpcTimeoutMs, CodexStdioJsonRpcTransport } from "./jsonRpc.ts";
import type { ProviderEvent } from "../types.ts";
import type { CodexJsonRpcProcess } from "./jsonRpc.ts";
import { CodexProcessGroupLifecycle, type ProcessTreeEntry } from "./processLifecycle.ts";

import { FakeCodexProcess, FakeStdin, config, flushTimers, waitFor, encode } from "./jsonRpcTestFixtures.ts";

export function registerRoutesGrayCurrentWorkspaceCommandsThrough() {
test("routes gray current-workspace commands through pending approval events", async () => {
    let fake!: FakeCodexProcess;
    const events: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      onEvent: (event) => {
        events.push(event);
        if ((event.raw as { method?: string } | undefined)?.method === "approval/requested") {
          void transport.resolveApprovalRequest("item-command", { decision: "reject", scope: "turn" });
        }
      },
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-command",
                startedAtMs: 1,
                command: "git commit -m test",
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { decision: "decline" } });
    expect(events).toEqual([
      expect.objectContaining({ raw: expect.objectContaining({ method: "approval/requested" }), status: "pending" }),
      expect.objectContaining({ raw: expect.objectContaining({ method: "approval/resolved" }), status: "deny" })
    ]);
  });

test("declines deterministic high-risk approval requests without publishing approval events", async () => {
    let fake!: FakeCodexProcess;
    const events: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      onEvent: (event) => events.push(event),
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-command",
                command: "sudo cat CODEX_API_KEY=fixture-secret /Users/example/private.txt",
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { decision: "decline" } });
    expect(events).toEqual([]);
  });

test("accepts exact low-risk approval requests without publishing approval events", async () => {
    let fake!: FakeCodexProcess;
    const events: ProviderEvent[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      onEvent: (event) => events.push(event),
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-command",
                command: "git status",
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { decision: "accept" } });
    expect(events).toEqual([]);
  });

test("denies unknown permission scope without holding the RPC", async () => {
    let fake!: FakeCodexProcess;
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/permissions/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-permissions",
                permissions: { network: true },
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { permissions: {}, scope: "turn" } });
  });

test("writes fast approval responses before deferred audit hook failures", async () => {
    let fake!: FakeCodexProcess;
    const hookMethods: string[] = [];
    const transport = new CodexStdioJsonRpcTransport({ ...config, timeoutMs: 50 }, {
      onEvent: (event) => {
        hookMethods.push(event.raw?.method ?? "");
        throw new Error("audit unavailable");
      },
      processFactory: () => {
        fake = new FakeCodexProcess((request, process) => {
          if (request.method === "initialize") {
            process.sendStdout({
              id: 99,
              method: "item/commandExecution/requestApproval",
              params: {
                threadId: "thread-approval",
                turnId: "turn-approval",
                itemId: "item-command",
                command: "git status",
                cwd: "/repo"
              }
            });
          }
          if (request.id === 99 && request.result) {
            process.sendStdout({ id: 1, result: { protocolVersion: "fixture" } });
          }
        });
        return fake;
      }
    });

    await expect(transport.request("initialize", {})).resolves.toEqual({ protocolVersion: "fixture" });

    expect(fake.requests).toContainEqual({ id: 99, result: { decision: "accept" } });
    expect(hookMethods).toEqual([]);
    await flushTimers();
    expect(hookMethods).toEqual(["approval/fast_resolved"]);
  });
}
