import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActionEvents } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];
const previousHome = process.env.HOME;
const previousRegistry = Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

afterEach(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousRegistry === undefined) delete Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;
  else Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = previousRegistry;
  while (tempRoots.length > 0) await rm(tempRoots.pop()!, { recursive: true, force: true });
});

describe("PI MCP discovery API", () => {
  test("scans allowlisted local MCP configs without enabling or leaking secrets", async () => {
    const fixture = await openFixture();
    process.env.HOME = fixture.home;
    await writeCodexConfig(fixture.home, fixture.script);
    await writeProjectConfig(fixture.workspace, fixture.script);
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const sources = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/discovery/sources`));
      const scan = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/discovery/scan`, {
        body: JSON.stringify({ sources: ["codex", "project"], workspace_dir: fixture.workspace }),
        method: "POST"
      }));
      const results = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/discovery/results`));
      const enabled = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/capabilities`));

      expect(sources.status).toBe(200);
      expect((await json(sources)).sources).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: "codex" }),
        expect.objectContaining({ id: "project" })
      ]));
      expect(scan.status).toBe(200);
      const scanText = JSON.stringify(await scan.json());
      expect(scanText).toContain("codex-docs");
      expect(scanText).toContain("project-docs");
      expect(scanText).not.toContain("secret-token-value");
      expect(results.status).toBe(200);
      const body = await json(results);
      expect(body.servers).toEqual(expect.arrayContaining([
        expect.objectContaining({ enabled: false, source: "codex", transport_type: "stdio" }),
        expect.objectContaining({ enabled: false, source: "project", transport_type: "stdio" })
      ]));
      expect(JSON.stringify(body)).not.toContain("secret-token-value");
      expect(await json(enabled)).toMatchObject({ capabilities: [] });
    } finally {
      fixture.db.close();
    }
  });



  test("HTTP MCP server is saved with diagnostics but not exposed as callable when unsupported", async () => {
    const fixture = await openFixture();
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const created = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/servers`, {
        body: JSON.stringify({
          name: "Remote MCP",
          transport: { headers: { Authorization: "Bearer secret-token-value" }, type: "http", url: "https://mcp.example.test" }
        }),
        method: "POST"
      }));
      const serverID = (await json(created)).server.id;
      await router.handle(new Request(`${BASE_URL}/api/pi/mcp/servers/${encodeURIComponent(serverID)}`, {
        body: JSON.stringify({ enabled: true }),
        method: "PATCH"
      }));
      const introspected = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/servers/${encodeURIComponent(serverID)}/introspect`, { method: "POST" }));
      const body = await json(introspected);
      const capabilities = await json(await router.handle(new Request(`${BASE_URL}/api/pi/mcp/capabilities`)));

      expect(introspected.status).toBe(200);
      expect(body.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mcp_transport_unsupported" })]));
      expect(body.capabilities).toEqual([]);
      expect(capabilities.capabilities).toEqual([]);
      expect(JSON.stringify(body)).not.toContain("secret-token-value");
    } finally {
      fixture.db.close();
    }
  });

  test("manual stdio server can be introspected, enabled, called through read-only tools, and audited", async () => {
    const fixture = await openFixture();
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const created = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/servers`, {
        body: JSON.stringify({
          name: "Fixture MCP",
          transport: {
            args: [fixture.script],
            command: process.execPath,
            env: { API_TOKEN: "secret-token-value" },
            type: "stdio"
          }
        }),
        method: "POST"
      }));
      expect(created.status).toBe(200);
      const createdBody = await json(created);
      const serverID = createdBody.server.id;
      expect(JSON.stringify(createdBody)).toContain("[redacted]");
      expect(JSON.stringify(createdBody)).not.toContain("secret-token-value");

      const introspected = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/servers/${encodeURIComponent(serverID)}/introspect`, { method: "POST" }));
      expect(introspected.status).toBe(200);
      const introspection = await json(introspected);
      expect(introspection.capabilities).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `${serverID}:tool:echo`, enabled: false, permission: "read", read_only: true }),
        expect.objectContaining({ id: `${serverID}:resource:guide`, enabled: false, permission: "read", read_only: true }),
        expect.objectContaining({ id: `${serverID}:tool:mutate`, enabled: false, permission: "write", requires_confirmation: false, risk_level: "medium" })
      ]));
      expect(JSON.stringify(introspection)).not.toContain("secret-token-value");

      await router.handle(new Request(`${BASE_URL}/api/pi/mcp/servers/${encodeURIComponent(serverID)}`, {
        body: JSON.stringify({ enabled: true }),
        method: "PATCH"
      }));
      await router.handle(new Request(`${BASE_URL}/api/pi/mcp/capabilities/${encodeURIComponent(`${serverID}:tool:echo`)}`, {
        body: JSON.stringify({ enabled: true }),
        method: "PATCH"
      }));

      const capabilities = await json(await router.handle(new Request(`${BASE_URL}/api/pi/mcp/capabilities`)));
      expect(capabilities.capabilities.map((item: { id: string }) => item.id)).toEqual([`${serverID}:tool:echo`]);

      const providers = await json(await router.handle(new Request(`${BASE_URL}/api/pi/tool-providers`)));
      expect(providers.providers).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: `mcp-${serverID}`, kind: "mcp", status: "enabled" })
      ]));
      const tools = await json(await router.handle(new Request(`${BASE_URL}/api/pi/tools`)));
      expect(tools.tools).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: "echo", provider_id: `mcp-${serverID}`, permission: "read" })
      ]));

      const called = await router.handle(new Request(`${BASE_URL}/api/pi/tools/${encodeURIComponent(`mcp-${serverID}:echo`)}/call`, {
        body: JSON.stringify({ audit_context: { conversation_id: "conv-mcp-discovery", source: "test" }, input: { text: "hello" } }),
        method: "POST"
      }));
      expect(called.status).toBe(200);
      expect(await json(called)).toMatchObject({ result: { output: { echoed: "hello" }, status: "succeeded" } });
      const audit = listPiActionEvents(fixture.db, { conversationId: "conv-mcp-discovery" })
        .find((event) => event.event_type === "tool_call_audit");
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
        permission: "read",
        provider_id: `mcp-${serverID}`,
        result: "succeeded",
        status: "succeeded",
        tool: "echo"
      });
      expect(audit?.payload_json).not.toContain("secret-token-value");
    } finally {
      fixture.db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; home: string; script: string; workspace: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-mcp-discovery-"));
  tempRoots.push(root);
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  const script = join(root, "fixture-mcp.mjs");
  await writeFile(script, MCP_FIXTURE_SCRIPT, "utf8");
  return { db: await openDatabase({ stateDir: join(root, "state") }), home, script, workspace };
}

async function writeCodexConfig(home: string, script: string): Promise<void> {
  await mkdir(join(home, ".codex"), { recursive: true });
  await writeFile(join(home, ".codex", "config.toml"), `
[mcp_servers.codex-docs]
command = "${escapeToml(script)}"
args = []
env = { API_TOKEN = "secret-token-value" }
`, "utf8");
}

async function writeProjectConfig(workspace: string, script: string): Promise<void> {
  await writeFile(join(workspace, ".mcp.json"), JSON.stringify({
    mcpServers: {
      "project-docs": { command: process.execPath, args: [script], env: { API_TOKEN: "secret-token-value" } }
    }
  }), "utf8");
}

function escapeToml(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

const MCP_FIXTURE_SCRIPT = `
const input = await new Promise((resolve) => {
  let data = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => data += chunk);
  process.stdin.on('end', () => resolve(data));
});
for (const line of String(input).split(/\\r?\\n/).filter(Boolean)) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') send(message.id, { protocolVersion: '2024-11-05', serverInfo: { name: 'fixture-mcp', version: '1.0.0' }, capabilities: { tools: {}, resources: {} } });
  if (message.method === 'tools/list') send(message.id, { tools: [
    { name: 'echo', description: 'Read-only echo tool.', inputSchema: { type: 'object', properties: { text: { type: 'string' } } }, annotations: { readOnlyHint: true } },
    { name: 'mutate', description: 'Mutates fixture state.', inputSchema: { type: 'object' } }
  ] });
  if (message.method === 'resources/list') send(message.id, { resources: [{ name: 'guide', uri: 'fixture://guide', description: 'Fixture guide.' }] });
  if (message.method === 'tools/call') send(message.id, { content: [{ type: 'text', text: JSON.stringify({ echoed: message.params.arguments.text }) }] });
  if (message.method === 'resources/read') send(message.id, { contents: [{ uri: message.params.uri, text: 'fixture guide' }] });
}
function send(id, result) { console.log(JSON.stringify({ jsonrpc: '2.0', id, result })); }
`;
