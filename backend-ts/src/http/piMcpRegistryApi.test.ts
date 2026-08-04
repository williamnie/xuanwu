import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const previousRegistry = Bun.env.XUANWU_MCP_REGISTRY_JSON;
const tempRoots: string[] = [];

afterEach(async () => {
  if (previousRegistry === undefined) delete Bun.env.XUANWU_MCP_REGISTRY_JSON;
  else Bun.env.XUANWU_MCP_REGISTRY_JSON = previousRegistry;
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI MCP registry API", () => {
  test("lists MCP capabilities with server diagnostics and risk levels", async () => {
    const fixture = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer(), offlineServer()] });
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const response = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/capabilities`));

      expect(response.status).toBe(200);
      const body = await response.json() as Record<string, any>;
      expect(body.capabilities.map((item: { id: string }) => item.id)).toEqual(expect.arrayContaining([
        "docs:resource:runbook",
        "docs:tool:search",
        "secrets:resource:vault"
      ]));
      expect(body.servers).toEqual(expect.arrayContaining([
        expect.objectContaining({
          diagnostics: expect.arrayContaining([expect.objectContaining({ code: "server_unavailable" })]),
          id: "secrets",
          readiness: "auth_missing",
          risk_level: "high",
          status: "unavailable"
        })
      ]));
      expect(body.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "server_unavailable", server_id: "secrets" }),
        expect.objectContaining({ code: "server_not_ready", readiness: "auth_missing" })
      ]));
      expect(JSON.stringify(body)).not.toContain("vault secret value");
    } finally {
      fixture.db.close();
    }
  });

  test("reads one MCP capability and exposes no execution route", async () => {
    const fixture = await openFixture();
    Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsServer()] });
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const detail = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/capabilities/docs%3Atool%3Asearch`));
      const missing = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/capabilities/not-found`));
      const post = await router.handle(new Request(`${BASE_URL}/api/pi/mcp/capabilities/docs%3Atool%3Asearch`, { method: "POST" }));

      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        capability: {
          id: "docs:tool:search",
          permission: "read",
          risk_level: "low",
          server_id: "docs"
        }
      });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "MCP capability 不存在: not-found" });
      expect(post.status).toBe(405);
      expect(await post.json()).toEqual({ message: "method not allowed" });
    } finally {
      fixture.db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-mcp-api-"));
  tempRoots.push(root);
  await mkdir(join(root, "project"), { recursive: true });
  return { db: await openDatabase({ stateDir: join(root, "state") }), root };
}

function docsServer() {
  return {
    id: "docs",
    readiness: "ready",
    resources: [
      { content: "deploy safely", description: "Deployment runbook", name: "runbook" }
    ],
    risk_level: "low",
    status: "enabled",
    tools: [
      { description: "Search documentation", name: "search", permission: "read", risk_level: "low" }
    ]
  };
}

function offlineServer() {
  return {
    id: "secrets",
    readiness: "auth_missing",
    resources: [
      { content: "vault secret value", description: "Vault record", name: "vault", permission: "admin" }
    ],
    status: "unavailable"
  };
}
