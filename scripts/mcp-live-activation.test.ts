import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Agent-05 safe MCP fixture", () => {
  test("serves real schemas/read values, exposes write separately, and fails while offline", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-05-mcp-"));
    roots.push(root);
    const control = join(root, "control.json");
    const state = join(root, "state.json");
    await writeFile(control, JSON.stringify({ online: true }), "utf8");
    await writeFile(state, JSON.stringify({ value: "baseline" }), "utf8");
    const env = {
      ...process.env,
      MCP_ACTIVATION_CONTROL_FILE: control,
      MCP_ACTIVATION_STATE_FILE: state
    };

    const introspection = spawnSync(process.execPath, [resolve("scripts/mcp-live-activation-server.ts")], {
      env,
      input: [
        rpc(1, "initialize"),
        rpc(2, "tools/list"),
        rpc(3, "resources/list")
      ].join("\n") + "\n"
    });
    const messages = lines(introspection.stdout?.toString() ?? "");
    const tools = messages.find((item) => item.id === 2)?.result.tools;

    expect(introspection.status).toBe(0);
    expect(tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ annotations: { readOnlyHint: true }, name: "fixture_read" }),
      expect.objectContaining({ name: "fixture_write" })
    ]));

    const read = spawnSync(process.execPath, [resolve("scripts/mcp-live-activation-server.ts")], {
      env,
      input: [rpc(1, "initialize"), rpc(2, "tools/call", {
        arguments: { request_id: "unit" },
        name: "fixture_read"
      })].join("\n") + "\n"
    });
    expect(lines(read.stdout?.toString() ?? "").find((item) => item.id === 2)?.result.structuredContent)
      .toEqual({ fixture: "agent-05", request_id: "unit", value: "baseline" });

    await writeFile(control, JSON.stringify({ online: false }), "utf8");
    const offline = spawnSync(process.execPath, [resolve("scripts/mcp-live-activation-server.ts")], {
      env,
      input: rpc(1, "initialize") + "\n"
    });
    expect(offline.status).toBe(69);
    expect(offline.stderr?.toString()).toContain("intentionally offline");
  });
});

function rpc(id: number, method: string, params: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, jsonrpc: "2.0", method, params });
}

function lines(output: string): any[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
