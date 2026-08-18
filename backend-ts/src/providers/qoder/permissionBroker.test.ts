import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CanUseToolOptions } from "@qoder-ai/qoder-agent-sdk";
import type { ProviderEvent } from "../types.ts";
import { QoderPermissionBroker, qoderPermissionOptions } from "./permissionBroker.ts";
import { QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter } from "./executionPolicy.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import type { ExecutionPolicyRequest, ResolvedExecutionPolicy } from "../core/policyContracts.ts";

describe("Qoder Q5 permission and approval gate", () => {
  test("read-only and workspace path policy fail closed without claiming OS containment", async () => {
    const broker = new QoderPermissionBroker();
    const callback = broker.callback(context({ approvalPolicy: "never", sandbox: "workspace-write" }));

    await expect(callback("Read", { path: "/outside" }, toolOptions("read-1"))).resolves.toMatchObject({ behavior: "allow" });
    await expect(callback("Edit", { file_path: "src/app.ts" }, toolOptions("edit-1"))).resolves.toMatchObject({ behavior: "allow" });
    await expect(callback("Edit", { file_path: "../outside.ts" }, toolOptions("edit-2"))).resolves.toMatchObject({ behavior: "deny" });
    await expect(callback("Bash", { command: "pwd" }, toolOptions("bash-1"))).resolves.toMatchObject({ behavior: "deny" });

    const readOnly = broker.callback(context({ approvalPolicy: "never", sandbox: "read-only" }));
    await expect(readOnly("Write", { file_path: "README.md" }, toolOptions("write-1"))).resolves.toMatchObject({ behavior: "deny" });
    expect(qoderPermissionOptions("never", "danger-full-access")).toMatchObject({
      allowDangerouslySkipPermissions: true,
      permissionMode: "bypassPermissions"
    });
    expect(() => qoderPermissionOptions("always", "workspace-write")).toThrow("requires a canUseTool callback");
    expect(() => qoderPermissionOptions("never", "workspace-write")).toThrow("requires a canUseTool callback");
    expect(qoderPermissionOptions("never", "workspace-write", callback)).toMatchObject({
      allowedTools: ["Read", "Grep", "Glob"],
      permissionMode: "default",
      tools: ["Read", "Grep", "Glob", "Edit", "Write"]
    });
  });

  test("workspace writes reject symlink escapes because a lexical prefix is not containment", async () => {
    const root = await mkdtemp(join(tmpdir(), "qoder-permission-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside");
    try {
      await mkdir(workspace);
      await mkdir(outside);
      await symlink(outside, join(workspace, "linked-outside"));
      const callback = new QoderPermissionBroker().callback(context({ cwd: workspace }));
      await expect(callback("Write", { file_path: "linked-outside/file.txt" }, toolOptions("symlink"))).resolves.toMatchObject({
        behavior: "deny"
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("unrestricted unattended maps to Qoder double bypass", () => {
    const policy = resolved({ access: "unrestricted-host", approval: "unattended" });
    expect(qoderPermissionOptions(undefined, undefined, undefined, policy)).toMatchObject({
      allowDangerouslySkipPermissions: true,
      disallowedTools: [],
      permissionMode: "bypassPermissions",
      tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "NotebookEdit"]
    });
  });

  test("ask-sensitive permits routine changes while ask-every pauses every side effect", async () => {
    const events: ProviderEvent[] = [];
    const broker = new QoderPermissionBroker({ timeoutMs: 1_000 });
    const sensitive = broker.callback(context({
      events,
      policy: resolved({ access: "unrestricted-host", approval: "ask-sensitive" })
    }));
    await expect(sensitive("Edit", { file_path: "src/app.ts" }, toolOptions("routine-edit"))).resolves.toMatchObject({ behavior: "allow" });
    const sensitiveBash = sensitive("Bash", { command: "rm -rf build" }, toolOptions("sensitive-bash"));
    await waitFor(() => broker.pendingCount() === 1);
    await broker.resolveApproval("session-1:sensitive-bash", { decision: "deny" });
    await expect(sensitiveBash).resolves.toMatchObject({ behavior: "deny" });

    const every = broker.callback(context({
      events,
      policy: resolved({ access: "unrestricted-host", approval: "ask-every-side-effect" })
    }));
    const routineEdit = every("Edit", { file_path: "src/app.ts" }, toolOptions("every-edit"));
    await waitFor(() => broker.pendingCount() === 1);
    await broker.resolveApproval("session-1:every-edit", { decision: "approve" });
    await expect(routineEdit).resolves.toMatchObject({ behavior: "allow" });
  });

  test.each(["danger-only", "always"])("%s emits redacted request and maps an explicit allow decision", async (approvalPolicy) => {
    const events: ProviderEvent[] = [];
    const broker = new QoderPermissionBroker({ timeoutMs: 1_000 });
    const callback = broker.callback(context({ approvalPolicy, events }));
    const pending = callback("Edit", {
      file_path: join(process.cwd(), "src/app.ts"),
      description: "QODER_PERSONAL_ACCESS_TOKEN=fixture-secret"
    }, toolOptions("tool-allow"));

    await waitFor(() => events.length === 1);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: "qoder",
      raw: { method: "approval/requested" },
      runEvent: { kind: "approval_requested", outcome: "waiting_approval", terminal: false }
    });
    expect(JSON.stringify(events[0])).not.toContain("fixture-secret");
    expect(JSON.stringify(events[0])).not.toContain(process.cwd());

    await broker.resolveApproval("session-1:tool-allow", { decision: "approve", scope: "session" });
    await expect(pending).resolves.toMatchObject({ behavior: "allow", toolUseID: "tool-allow" });
    expect(events.at(-1)).toMatchObject({
      raw: { method: "approval/resolved" },
      status: "approve",
      runEvent: { kind: "approval_resolved", outcome: "running", terminal: false }
    });
  });

  test("deny, timeout, abort, and provider restart all resolve pending callbacks as deny", async () => {
    const broker = new QoderPermissionBroker({ timeoutMs: 20 });
    const callback = broker.callback(context({ approvalPolicy: "always" }));

    const denied = callback("Write", { path: "a.txt" }, toolOptions("deny"));
    await waitFor(() => broker.pendingCount() === 1);
    await broker.resolveApproval("session-1:deny", { decision: "deny" });
    await expect(denied).resolves.toMatchObject({ behavior: "deny", message: "Qoder tool use was denied" });

    await expect(callback("Write", { path: "b.txt" }, toolOptions("timeout"))).resolves.toMatchObject({
      behavior: "deny",
      message: "Qoder approval timed out"
    });

    const controller = new AbortController();
    const aborted = callback("Write", { path: "c.txt" }, toolOptions("abort", controller.signal));
    controller.abort();
    await expect(aborted).resolves.toMatchObject({ behavior: "deny", interrupt: true });

    const restarted = callback("Write", { path: "d.txt" }, toolOptions("restart"));
    await waitFor(() => broker.pendingCount() === 1);
    broker.rejectAll();
    await expect(restarted).resolves.toMatchObject({ behavior: "deny", interrupt: true });
    expect(broker.pendingCount()).toBe(0);
  });
});

function context(overrides: { approvalPolicy?: string; cwd?: string; events?: ProviderEvent[]; policy?: ResolvedExecutionPolicy; sandbox?: string } = {}) {
  return {
    approvalPolicy: overrides.approvalPolicy ?? "never",
    cwd: overrides.cwd ?? process.cwd(),
    invocationRef: "inv-1",
    onEvent: (event: ProviderEvent) => overrides.events?.push(event),
    policy: overrides.policy,
    sandbox: overrides.sandbox ?? "workspace-write",
    session: () => ({ provider: "qoder" as const, sessionId: "session-1" })
  };
}

function resolved(input: Omit<ExecutionPolicyRequest, "contract">): ResolvedExecutionPolicy {
  const request: ExecutionPolicyRequest = { contract: "xw.execution-policy.v1", ...input };
  return resolveExecutionPolicy(request, {
    cwd: process.cwd(),
    invocationRef: "inv-1",
    projectId: "project-1",
    providerId: "qoder",
    providerVersion: "1.0.23",
    source: "local-user",
    transport: "sdk"
  }, QODER_EXECUTION_POLICY_CAPABILITIES, qoderExecutionPolicyAdapter);
}

function toolOptions(toolUseID: string, signal = new AbortController().signal): CanUseToolOptions {
  return {
    agentID: "agent-1",
    blockedPath: join(process.cwd(), "src/app.ts"),
    decisionReason: "needs permission",
    signal,
    toolUseID
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(1);
  }
  throw new Error("fixture condition was not reached");
}
