import { describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectHerdr, herdrRequest } from "./herdrTransport.ts";
import { HerdrHooks } from "./herdrHooks.ts";

describe("herdr readiness", () => {
  const config = { command: "claude", cwd: "/tmp", env: {}, authMode: "local-cli" as const, timeoutMs: 1000 };
  const deps = {
    which: (name: string) => `/bin/${name}`,
    command: () => ({ installed: true, path: "/bin/claude" }),
    isSocket: () => true,
    run: (argv: string[]) => ({ exitCode: 0, stdout: argv.includes("--version") ? "herdr 0.9.5" : '{"result":{"type":"snapshot"}}' }),
    auth: () => ({ checked: true, logged_in: true })
  };
  test("checks missing executable, service, version, protocol, and login separately", () => {
    expect(inspectHerdr(config, deps).ready).toBe(true);
    expect(inspectHerdr(config, { ...deps, which: () => null }).reason).toContain("未检测到 herdr");
    expect(inspectHerdr(config, { ...deps, command: () => ({ installed: false }) }).reason).toContain("Claude Code CLI");
    expect(inspectHerdr(config, { ...deps, isSocket: () => false }).reason).toContain("socket");
    expect(inspectHerdr(config, { ...deps, run: () => ({ exitCode: 0, stdout: "herdr 0.8.9" }) }).reason).toContain("0.9.5");
    expect(inspectHerdr(config, { ...deps, run: (argv) => argv.includes("--version") ? deps.run(argv) : { exitCode: 1, stdout: "secret must not be exposed" } }).reason).toContain("服务无响应");
    expect(inspectHerdr(config, { ...deps, auth: () => ({ checked: true, logged_in: false }) }).reason).toContain("claude auth login");
  });
});

describe("herdr socket framing", () => {
  async function withSocket(reply: (id: string) => string | null, run: (path: string) => Promise<void>) {
    const directory = mkdtempSync(join(tmpdir(), "herdr-rpc-"));
    const path = join(directory, "api.sock");
    const clients: import("node:net").Socket[] = [];
    const server = createServer((client) => {
      clients.push(client);
      client.once("data", (data) => {
        const response = reply(JSON.parse(data.toString()).id);
        if (response) { client.write(response.slice(0, 5)); client.write(response.slice(5)); }
      });
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try { await run(path); } finally { for (const client of clients) client.destroy(); server.close(); rmSync(directory, { recursive: true, force: true }); }
  }

  test("reassembles fragmented frames and correlates response IDs", async () => {
    await withSocket((id) => JSON.stringify({ id: "other", result: {} }) + "\n" + JSON.stringify({ id, result: { type: "pong" } }) + "\n", async (path) => {
      expect(await herdrRequest(path, "ping", {})).toEqual({ type: "pong" });
    });
  });
  test("rejects errors and reports unknown timeout without retrying", async () => {
    await withSocket((id) => JSON.stringify({ id, error: { code: "not_found", message: "private" } }) + "\n", async (path) => {
      await expect(herdrRequest(path, "agent.prompt", {})).rejects.toThrow("rejected");
    });
    await withSocket(() => null, async (path) => {
      await expect(herdrRequest(path, "agent.prompt", {}, 10)).rejects.toThrow("outcome unknown");
    });
  });
});

test("hook callback authenticates, and command hook fails closed when bridge is unavailable", async () => {
  const hooks = new HerdrHooks(Bun.which("curl")!, "fixture-session", async () => ({}));
  const settings = JSON.parse(readFileSync(hooks.settings, "utf8"));
  const command = settings.hooks.PreToolUse[0].hooks[0].command;
  const conf = readFileSync(join(hooks.directory, "curl.conf"), "utf8");
  const url = conf.match(/url = "([^"]+)"/)![1];
  expect((await fetch(url, { method: "POST", body: "{}" })).status).toBe(403);
  // 执行真实的 curl hook，而不是只测试 HTTP handler；没有模型请求。
  const running = Bun.spawn(["sh", "-c", command], { stdin: new Blob([JSON.stringify({ session_id: "fixture-session", hook_event_name: "PreToolUse" })]), stdout: "pipe", stderr: "pipe" });
  expect(await running.exited).toBe(0);
  hooks.dispose();
  const stopped = Bun.spawn(["sh", "-c", command], { stdin: new Blob(["{}"]), stdout: "pipe", stderr: "pipe" });
  expect(await stopped.exited).toBe(2);
});
