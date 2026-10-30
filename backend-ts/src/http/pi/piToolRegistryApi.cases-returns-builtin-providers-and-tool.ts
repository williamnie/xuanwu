import { expect, test } from "bun:test";
import { buildConfig } from "../../config/env.ts";
import { listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piToolRegistryApi.testFixture.ts";

export function registerReturnsBuiltinProvidersAndToolCases(testScope: TestFixture) {
  const { BASE_URL, openFixture, cliConnectorFixtureDir, docsMcpServer, failedMcpServer } = testScope;
  test("returns builtin providers and tool metadata when stored registry is empty", async () => {
      const db = await openFixture();
      try {
        const router = createDefaultRouter({ database: db });
        const providers = await router.handle(new Request(`${BASE_URL}/api/pi/tool-providers`));
        const tools = await router.handle(new Request(`${BASE_URL}/api/pi/tools`));
        const detail = await router.handle(new Request(`${BASE_URL}/api/pi/tools/runner-builtin%3Aissue_read`));
        const post = await router.handle(new Request(`${BASE_URL}/api/pi/tools/runner-builtin%3Aissue_read`, { method: "POST" }));
  
        expect(providers.status).toBe(200);
        await expect(providers.json()).resolves.toMatchObject({
          providers: expect.arrayContaining([
            expect.objectContaining({ id: "browser-readonly", kind: "browser" }),
            expect.objectContaining({ id: "http-readonly", kind: "http" }),
            expect.objectContaining({ id: "runner-builtin", kind: "builtin" })
          ])
        });
  
        expect(tools.status).toBe(200);
        const toolBody = await tools.json() as Record<string, any>;
        expect(toolBody.tools).toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: "read_page_context",
            permission: "read",
            provider: expect.objectContaining({ id: "browser-readonly", kind: "browser" }),
            provider_id: "browser-readonly"
          }),
          expect.objectContaining({
            name: "url_fetch",
            permission: "read",
            provider: expect.objectContaining({ id: "http-readonly", kind: "http" }),
            provider_id: "http-readonly"
          }),
          expect.objectContaining({
            description: expect.any(String),
            input_schema: expect.objectContaining({ type: "object" }),
            name: "issue_read",
            permission: "read",
            permission_summary: expect.objectContaining({ level: "read" }),
            provider: expect.objectContaining({ id: "runner-builtin" }),
            provider_id: "runner-builtin"
          }),
          expect.objectContaining({
            input_schema: expect.objectContaining({
              properties: expect.objectContaining({ idempotency_key: expect.objectContaining({ type: "string" }) }),
              required: expect.arrayContaining(["action", "expected_revision", "idempotency_key", "reason", "work_id"])
            }),
            metadata: expect.objectContaining({ risk_level: "high" }),
            name: "work_control",
            output_schema: expect.objectContaining({
              required: ["authority", "observed_at", "output_budget"]
            }),
            permission: "dangerous",
            permission_summary: expect.objectContaining({ level: "dangerous", requires_confirmation: true }),
            provider_id: "runner-builtin"
          })
        ]));
  
        expect(detail.status).toBe(200);
        await expect(detail.json()).resolves.toMatchObject({
          tool: expect.objectContaining({ name: "issue_read", provider_id: "runner-builtin" })
        });
        expect(post.status).toBe(405);
      } finally {
        db.close();
      }
    });
  
  test("loads fixture CLI connector tools into the registry API", async () => {
      const db = await openFixture();
      const dir = await cliConnectorFixtureDir();
      try {
        const config = buildConfig({ cliConnectorDirs: [dir] });
        const router = createDefaultRouter({ config, database: db });
        const response = await router.handle(new Request(`${BASE_URL}/api/pi/tools`));
  
        expect(response.status).toBe(200);
        const body = await response.json() as Record<string, any>;
        expect(body.tools).toEqual(expect.arrayContaining([
          expect.objectContaining({
            name: "echo",
            permission: "read",
            provider: expect.objectContaining({ id: "fixture-cli", kind: "cli" }),
            provider_id: "fixture-cli"
          })
        ]));
      } finally {
        db.close();
      }
    });
  
  test("loads MCP server tools into the unified registry without blocking on failed servers", async () => {
      const db = await openFixture();
      Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [docsMcpServer(), failedMcpServer()] });
      try {
        const router = createDefaultRouter({ database: db });
        const providers = await router.handle(new Request(`${BASE_URL}/api/pi/tool-providers`));
        const tools = await router.handle(new Request(`${BASE_URL}/api/pi/tools`));
        const detail = await router.handle(new Request(`${BASE_URL}/api/pi/tools/mcp-docs%3Asearch`));
  
        expect(providers.status).toBe(200);
        await expect(providers.json()).resolves.toMatchObject({
          providers: expect.arrayContaining([
            expect.objectContaining({ id: "mcp-docs", kind: "mcp", status: "enabled" }),
            expect.objectContaining({ id: "mcp-missing-docs", kind: "mcp", status: "disabled" })
          ])
        });
  
        expect(tools.status).toBe(200);
        const body = await tools.json() as Record<string, any>;
        expect(body.tools).toEqual(expect.arrayContaining([
          expect.objectContaining({
            input_schema: expect.objectContaining({
              properties: expect.objectContaining({ query: expect.objectContaining({ type: "string" }) }),
              type: "object"
            }),
            metadata: expect.objectContaining({ capability_id: "docs:tool:search", connector: "mcp" }),
            name: "search",
            permission: "read",
            provider: expect.objectContaining({ id: "mcp-docs", kind: "mcp", status: "enabled" }),
            provider_id: "mcp-docs"
          })
        ]));
  
        expect(detail.status).toBe(200);
        await expect(detail.json()).resolves.toMatchObject({
          tool: expect.objectContaining({
            name: "search",
            provider_id: "mcp-docs",
            provider: expect.objectContaining({ kind: "mcp" })
          })
        });
      } finally {
        db.close();
      }
    });
  
  test("calls CLI connector tools and records standard audit", async () => {
      const db = await openFixture();
      const dir = await cliConnectorFixtureDir();
      try {
        const config = buildConfig({ cliConnectorDirs: [dir] });
        const router = createDefaultRouter({ config, database: db });
        const response = await router.handle(new Request(`${BASE_URL}/api/pi/tools/fixture-cli%3Aecho/call`, {
          body: JSON.stringify({
            audit_context: { conversation_id: "conv-cli", source: "test" },
            input: { payload: "hello" },
            permission: "read"
          }),
          method: "POST"
        }));
  
        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toMatchObject({
          result: { output: { payload: "hello" }, status: "succeeded" }
        });
        const audit = listPiActionEvents(db, { conversationId: "conv-cli" })
          .find((event) => event.event_type === "tool_call_audit");
        expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
          provider_id: "fixture-cli",
          source: "test",
          status: "succeeded",
          tool: "echo"
        });
      } finally {
        db.close();
      }
    });
  
  test("denies CLI connector write tools even with elevated permission request and audits denial", async () => {
      const db = await openFixture();
      const dir = await cliConnectorFixtureDir();
      try {
        const config = buildConfig({ cliConnectorDirs: [dir] });
        const router = createDefaultRouter({ config, database: db });
        const response = await router.handle(new Request(`${BASE_URL}/api/pi/tools/fixture-cli%3Amutate/call`, {
          body: JSON.stringify({
            audit_context: { conversation_id: "conv-cli-denied", source: "test" },
            input: { payload: "do-write" },
            permission: "write"
          }),
          method: "POST"
        }));
  
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toMatchObject({
          result: { error: { code: "permission_denied" }, status: "denied" }
        });
        expect(listPiActions(db, { status: "pending" })).toEqual([]);
        const audit = listPiActionEvents(db, { conversationId: "conv-cli-denied" })
          .find((event) => event.event_type === "tool_call_audit");
        expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
          provider_id: "fixture-cli",
          status: "denied",
          tool: "mutate"
        });
      } finally {
        db.close();
      }
    });
}
