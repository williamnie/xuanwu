import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { ClaudeHerdrProvider } from "./herdrProvider.ts";
import { resolveExecutionPolicy } from "../core/policyResolution.ts";
import { CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter } from "./executionPolicy.ts";
import { asProviderId, type ProviderEvent } from "../types.ts";
import { buildConfig } from "../../config/env.ts";
import { herdrSocket, inspectHerdr, shellQuote, type HerdrRpc } from "./herdrTransport.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

function fixture(timeoutMs = 2000) {
  let session = "", settings = "", url = "", token = "", state = "idle";
  let hook: (event: string, data?: Record<string, unknown>) => Promise<any>;
  const calls: Array<{ method: string; params: Record<string, any> }> = [];
  const events: ProviderEvent[] = [];
  const rpc: HerdrRpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "workspace.create") return { root_pane: { pane_id: "w1:p1" } };
    if (method === "pane.send_input") {
      const command = String(params.text);
      session = command.match(/'--(?:session-id|resume)' '([^']+)'/)![1];
      settings = command.match(/'--settings' '([^']+)'/)![1];
      const config = readFileSync(join(dirname(settings), "curl.conf"), "utf8");
      url = config.match(/url = "([^"]+)"/)![1];
      token = config.match(/Authorization: Bearer ([^"]+)/)![1];
      await hook("SessionStart");
      return { type: "ok" };
    }
    if (method === "agent.get") return { agent: { agent_status: state, interactive_ready: true, agent_session: { value: session } } };
    if (method === "agent.list") return { agents: [] };
    if (method === "agent.prompt") { state = "working"; await hook("UserPromptSubmit"); }
    return { type: "ok" };
  };
  hook = async (event, data = {}) => {
    const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ session_id: session, hook_event_name: event, ...data }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  const provider = new ClaudeHerdrProvider({ command: "claude", cwd: process.cwd(), env: {}, mode: "herdr", authMode: "local-cli", timeoutMs }, {
    rpc, probe: () => ({ ready: true, version: "0.9.5", claude: "/usr/bin/claude", curl: Bun.which("curl")!, socket: "/fixture" }), pollMs: 5,
    eventSink: (event) => events.push(event)
  });
  cleanups.push(async () => { session = original || session; await provider.stop(); });
  let original = "";
  const policy = resolveExecutionPolicy({ contract: "xw.execution-policy.v1", access: "unrestricted-host", approval: "ask-every-side-effect" }, {
    cwd: process.cwd(), invocationRef: "fixture", projectId: "fixture", providerId: asProviderId("claude"), transport: "herdr", providerVersion: "fixture", source: "local-user"
  }, CLAUDE_EXECUTION_POLICY_CAPABILITIES, claudeExecutionPolicyAdapter);
  const input = { cwd: process.cwd(), prompt: "test native terminal", policy };
  return { provider, input, calls, events, hook,
    settings: () => settings,
    replaceOwner: () => { original = session; session = crypto.randomUUID(); },
    idle: () => { state = "idle"; },
    finish: async () => { await hook("Stop", { last_assistant_message: "completed reply" }); state = "idle"; }
  };
}

async function waitFor(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

describe("Claude herdr native terminal", () => {
  test("launches native CLI, retains one pane across turns and waits for Stop plus idle", async () => {
    const f = fixture();
    const created = await f.provider.createSession(f.input);
    const launch = String(f.calls.find((c) => c.method === "pane.send_input")!.params.text);
    expect(launch).not.toContain("stream-json");
    expect(launch).not.toContain("'-p'");
    expect(launch).not.toContain("bypass");
    expect(f.provider.runtimeStatus().active_sessions).toBe(1);
    f.idle();
    await Bun.sleep(30);
    expect(f.events.some((e) => e.runEvent?.terminal)).toBe(false);
    await f.finish();
    await waitFor(() => f.events.some((e) => e.runEvent?.outcome === "succeeded"));
    await f.provider.sendSessionMessage({ ...f.input, sessionId: created.thread_id, prompt: "follow up" });
    expect(f.calls.filter((c) => c.method === "workspace.create")).toHaveLength(1);
    await f.finish();
    await waitFor(() => f.events.filter((e) => e.runEvent?.outcome === "succeeded").length === 2);
  });

  test("busy submission/steer rejected without writing; concurrent requests reserve before awaiting", async () => {
    const f = fixture();
    const session = await f.provider.createSession(f.input);
    await expect(f.provider.sendSessionMessage({ ...f.input, sessionId: session.thread_id })).rejects.toThrow("busy");
    await expect(f.provider.sendSessionMessage({ ...f.input, sessionId: session.thread_id, mode: "steer" })).rejects.toThrow("尚未验证");
    expect(f.calls.filter((c) => c.method === "agent.prompt")).toHaveLength(1);
    await f.finish();
    await waitFor(() => f.events.some((e) => e.runEvent?.terminal));
    const results = await Promise.allSettled([1, 2].map(() => f.provider.sendSessionMessage({ ...f.input, sessionId: session.thread_id })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  });

  test("PreToolUse blocks until host approval and denied approvals reach Claude", async () => {
    const f = fixture();
    await f.provider.createSession(f.input);
    const decision = f.hook("PreToolUse", { tool_name: "Bash", tool_input: { command: "touch file" }, tool_use_id: "tool-1" });
    await waitFor(() => f.events.some((e) => e.runEvent?.kind === "approval_requested"));
    const event = f.events.find((e) => e.runEvent?.kind === "approval_requested")!;
    await f.provider.resolveApproval((event.payload as { id: string }).id, { decision: "deny" });
    expect((await decision).body.hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test("wrong session and subagent Stop cannot complete the main turn", async () => {
    const f = fixture();
    await f.provider.createSession(f.input);
    expect((await f.hook("Stop", { session_id: "foreign" })).status).toBe(409);
    await f.hook("Stop", { agent_id: "subagent" });
    f.idle();
    await Bun.sleep(30);
    expect(f.events.some((e) => e.runEvent?.terminal)).toBe(false);
  });

  test("interrupt closes only the owned pane and removes temporary hooks", async () => {
    const f = fixture();
    const session = await f.provider.createSession(f.input);
    const settings = f.settings();
    expect(existsSync(settings)).toBe(true);
    await f.provider.interrupt({ session: { provider: "claude", sessionId: session.thread_id } });
    expect(f.calls.some((c) => c.method === "agent.send_keys")).toBe(true);
    expect(f.calls.filter((c) => c.method === "pane.close")).toHaveLength(1);
    expect(existsSync(settings)).toBe(false);
    expect(f.events.some((e) => e.runEvent?.outcome === "interrupted")).toBe(true);
  });

  test("replacement pane occupant is never interrupted", async () => {
    const f = fixture();
    const session = await f.provider.createSession(f.input);
    f.replaceOwner();
    await expect(f.provider.interrupt({ session: { provider: "claude", sessionId: session.thread_id } })).rejects.toThrow("owner changed");
    expect(f.calls.some((c) => c.method === "agent.send_keys" || c.method === "pane.close")).toBe(false);
  });

  test("timeout reports failure, not success, and cleans up the pane", async () => {
    const f = fixture(60);
    await f.provider.createSession(f.input);
    await waitFor(() => f.events.some((e) => e.runEvent?.outcome === "failed"));
    await waitFor(() => f.provider.runtimeStatus().active_sessions === 0);
  });

  test("read-only denies writes and API control characters never reach terminal", async () => {
    const f = fixture();
    await expect(f.provider.createSession({ ...f.input, prompt: "hello\u001b[2J" })).rejects.toThrow("control characters");
    expect(f.calls).toHaveLength(0);
    await f.provider.createSession({ ...f.input, policy: { ...f.input.policy, requested: { ...f.input.policy.requested, access: "read-only" } } });
    const result = await f.hook("PreToolUse", { agent_id: "subagent", tool_name: "Write", tool_input: { file_path: "README.md" }, tool_use_id: "write-1" });
    expect(result.body.hookSpecificOutput.permissionDecision).toBe("deny");
  });
});

describe("herdr configuration and dependency detection", () => {
  test("explicit opt-in preserves SDK default; unsupported auth rejected", () => {
    expect(buildConfig({ claudeMode: "herdr", claudeAuthMode: "local-cli" }).providers.claude?.mode).toBe("herdr");
    expect(() => buildConfig({ claudeMode: "herdr", claudeAuthMode: "platform-profile" })).toThrow("local-cli");
    expect(buildConfig({}).providers.claude?.mode).toBe("sdk");
  });
  test("missing/unsupported dependencies give user installation instructions", () => {
    const result = inspectHerdr({ command: "/missing/claude", cwd: process.cwd(), env: {}, mode: "herdr", authMode: "environment", timeoutMs: 1000 });
    expect(result.ready).toBe(false);
    expect(result.reason).toContain("自行安装");
    expect(result.reason).toContain("https://herdr.dev/docs/install/");
  });
  test("socket selection and shell escaping do not execute prompt content", () => {
    expect(herdrSocket({ HOME: "/home/a", HERDR_SESSION: "tasks" })).toBe("/home/a/.config/herdr/sessions/tasks/herdr.sock");
    expect(herdrSocket({ HERDR_SOCKET_PATH: "/private/herdr.sock" })).toBe("/private/herdr.sock");
    expect(() => herdrSocket({ HERDR_SESSION: "../../tmp" })).toThrow();
    expect(shellQuote("it's $(touch no) `no`")).toBe("'it'\\''s $(touch no) `no`'");
  });
});
