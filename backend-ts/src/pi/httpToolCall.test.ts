import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActionEvents } from "../db/repositories/pi.ts";
import { invokeReadOnlyAssistantTool } from "./readOnlyToolInvocation.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("HTTP read-only url_fetch provider", () => {
  test("fetches HTTP 200, non-2xx, and redirects through url_fetch", async () => {
    const db = await openFixture();
    const server = startHttpFixture();
    try {
      const ok = await callUrlFetch(db, "conv-http", { url: fixtureUrl(server, "/ok") });
      const missing = await callUrlFetch(db, "conv-http", { url: fixtureUrl(server, "/missing") });
      const redirected = await callUrlFetch(db, "conv-http", { max_redirects: 2, url: fixtureUrl(server, "/redirect") });
      const contentDenied = await callUrlFetch(db, "conv-http-denied-type", {
        allow_content_types: ["application/json"],
        url: fixtureUrl(server, "/ok")
      });

      expect(ok).toMatchObject({
        output: {
          content_type: "text/html; charset=utf-8",
          evidence_ref: expect.stringMatching(/^url_fetch:sha256:[a-f0-9]{64}$/),
          hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          ok: true,
          status: 200,
          text: expect.stringContaining("Fixture Title"),
          truncated: false,
          url: fixtureUrl(server, "/ok")
        },
        status: "succeeded"
      });
      expect(JSON.stringify(ok.output)).not.toContain("<script>");
      expect(missing).toMatchObject({
        output: { ok: false, status: 404, text: expect.stringContaining("not found") },
        status: "succeeded"
      });
      expect(redirected).toMatchObject({
        output: {
          final_url: fixtureUrl(server, "/ok"),
          redirect_count: 1,
          redirects: [expect.objectContaining({ status: 302 })],
          status: 200
        },
        status: "succeeded"
      });
      expect(contentDenied).toMatchObject({ error: { code: "content_type_denied" }, status: "denied" });
      expect(auditPayloads(db, "conv-http")).toEqual(expect.arrayContaining([
        expect.objectContaining({ provider_id: "http-readonly", status: "succeeded", tool: "url_fetch" })
      ]));
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("bounds oversize HTTP bodies to excerpt, hash, and metadata", async () => {
    const db = await openFixture();
    const server = startHttpFixture();
    try {
      const result = await callUrlFetch(db, "conv-http-large", { max_bytes: 64, url: fixtureUrl(server, "/large") });

      expect(result).toMatchObject({
        output: {
          bytes_read: 64,
          hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          max_bytes: 64,
          status: 200,
          text: expect.any(String),
          truncated: true
        },
        status: "succeeded"
      });
      expect(String(recordValue(result.output).text).length).toBeLessThanOrEqual(64);
      expect(JSON.stringify(result.output)).not.toContain("L".repeat(512));
      expect(JSON.stringify(auditPayloads(db, "conv-http-large"))).not.toContain("L".repeat(512));
    } finally {
      server.stop(true);
      db.close();
    }
  });

  test("times out slow HTTP fetches and denies non-read methods", async () => {
    const db = await openFixture();
    const server = startHttpFixture();
    try {
      const timeout = await callUrlFetch(db, "conv-http-timeout", { timeout_ms: 10, url: fixtureUrl(server, "/slow") });
      const denied = await callUrlFetch(db, "conv-http-denied", { method: "POST", url: fixtureUrl(server, "/ok") });

      expect(timeout).toMatchObject({ error: { code: "http_timeout" }, status: "timeout" });
      expect(denied).toMatchObject({ error: { code: "method_not_allowed" }, status: "denied" });
      expect(auditPayloads(db, "conv-http-timeout")[0]).toMatchObject({
        provider_id: "http-readonly",
        status: "timeout",
        tool: "url_fetch"
      });
    } finally {
      server.stop(true);
      db.close();
    }
  });
});

async function callUrlFetch(db: RunnerDatabase, conversationID: string, input: Record<string, unknown>) {
  return await invokeReadOnlyAssistantTool({
    auditContext: { conversationID, source: "test" },
    db,
    input,
    providerID: "http-readonly",
    toolName: "url_fetch"
  });
}

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-http-tools-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}

function auditPayloads(db: RunnerDatabase, conversationId: string): Array<Record<string, any>> {
  return listPiActionEvents(db, { conversationId })
    .filter((event) => event.event_type === "tool_call_audit")
    .map((event) => JSON.parse(event.payload_json) as Record<string, any>);
}

function startHttpFixture(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/ok") return htmlResponse("<title>Fixture Title</title><script>secret()</script><p>Hello URL</p>");
      if (path === "/missing") return new Response("not found", { headers: { "content-type": "text/plain; charset=utf-8" }, status: 404 });
      if (path === "/redirect") return new Response(null, { headers: { location: "/ok" }, status: 302 });
      if (path === "/large") return new Response("L".repeat(2048), { headers: { "content-type": "text/plain; charset=utf-8" } });
      if (path === "/slow") {
        await Bun.sleep(60);
        return new Response("late", { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      return new Response("unexpected", { status: 500 });
    }
  });
}

function fixtureUrl(server: ReturnType<typeof Bun.serve>, path: string): string {
  return new URL(path, server.url).toString();
}

function htmlResponse(body: string): Response {
  return new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
