import { describe, expect, test } from "bun:test";
import type { CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ProviderEvent } from "../types.ts";
import type { ExecutionPolicyRequest } from "../core/policyContracts.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import { CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter } from "./executionPolicy.ts";
import { ClaudePermissionBroker } from "./permissionBroker.ts";

describe("Claude execution policy approval bridge", () => {
  test("read-only and native-development ceilings fail closed", async () => {
    const broker = new ClaudePermissionBroker(1_000);
    const readOnly = broker.callback(context({ access: "read-only", approval: "unattended" }));
    await expect(readOnly("Write", { file_path: "README.md" }, options("read-only"))).resolves.toMatchObject({ behavior: "deny" });

    const development = broker.callback(context({ access: "provider-native-development", approval: "unattended" }));
    await expect(development("Edit", { file_path: "README.md" }, options("inside"))).resolves.toMatchObject({ behavior: "allow" });
    await expect(development("Edit", { file_path: "../outside.md" }, options("outside"))).resolves.toMatchObject({ behavior: "deny" });
    await expect(development("Bash", { command: "rm -rf build" }, options("unsafe-command"))).resolves.toMatchObject({ behavior: "deny" });
  });

  test("ask-sensitive only pauses sensitive effects and ask-every pauses routine writes", async () => {
    const broker = new ClaudePermissionBroker(1_000);
    const events: ProviderEvent[] = [];
    const sensitive = broker.callback(context({ access: "unrestricted-host", approval: "ask-sensitive" }, events));
    await expect(sensitive("Edit", { file_path: "README.md" }, options("routine"))).resolves.toMatchObject({ behavior: "allow" });
    const bash = sensitive("Bash", { command: "rm -rf build" }, options("sensitive"));
    await waitFor(() => events.some((event) => event.raw?.method === "approval/requested"));
    const sensitiveId = String((events.find((event) => event.raw?.method === "approval/requested")?.payload as { id?: string })?.id ?? "");
    await broker.resolveApproval(sensitiveId, { decision: "deny" });
    await expect(bash).resolves.toMatchObject({ behavior: "deny" });

    const everyEvents: ProviderEvent[] = [];
    const every = broker.callback(context({ access: "unrestricted-host", approval: "ask-every-side-effect" }, everyEvents));
    const edit = every("Edit", { file_path: "README.md" }, options("every"));
    await waitFor(() => everyEvents.length > 0);
    const everyId = String((everyEvents[0].payload as { id?: string })?.id ?? "");
    await broker.resolveApproval(everyId, { decision: "approve" });
    await expect(edit).resolves.toMatchObject({ behavior: "allow" });
  });

  test("timeout and abort deny pending callbacks", async () => {
    const timeoutBroker = new ClaudePermissionBroker(5);
    const callback = timeoutBroker.callback(context({ access: "unrestricted-host", approval: "ask-every-side-effect" }));
    await expect(callback("Write", { file_path: "README.md" }, options("timeout"))).resolves.toMatchObject({
      behavior: "deny",
      message: "Claude approval timed out"
    });

    const controller = new AbortController();
    const aborted = callback("Write", { file_path: "README.md" }, options("abort", controller.signal));
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ behavior: "deny", interrupt: true });
  });
});

function context(request: Omit<ExecutionPolicyRequest, "contract">, events: ProviderEvent[] = []) {
  const policy = resolveExecutionPolicy({ contract: "xw.execution-policy.v1", ...request }, {
    cwd: process.cwd(),
    invocationRef: "claude-invocation",
    projectId: "project",
    providerId: "claude",
    providerVersion: "0.3.152",
    source: "local-user",
    transport: "sdk"
  }, CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter);
  return {
    cwd: process.cwd(),
    invocationRef: "claude-invocation",
    onEvent: (event: ProviderEvent) => events.push(event),
    policy,
    session: () => ({ provider: "claude" as const, sessionId: "claude-session" })
  };
}

function options(toolUseID: string, signal = new AbortController().signal): Parameters<CanUseTool>[2] {
  return { signal, suggestions: [], toolUseID };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("fixture condition was not reached");
}
