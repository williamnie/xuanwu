import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { listPiActionEvents } from "../db/repositories/pi.ts";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { buildContextBundleFromEvents } from "./contextBundleBuilder.ts";
import { syncCliRawEvents } from "./cliRawEventSync.ts";
import { invokeReadOnlyAssistantTool } from "./readOnlyToolInvocation.ts";
import { BROWSER_READ_PAGE_CONTEXT_TOOL_NAME, BROWSER_READONLY_PROVIDER_ID, BROWSER_SNAPSHOT_ENV, listBrowserAssistantTools } from "./browserToolProvider.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Browser read-only provider", () => {
  test("reads an authorized fixture page into context bundle evidence", async () => {
    const db = await openFixture();
    try {
      const result = await callBrowser(db, "conv-browser", fixtureEnv(), { include_image_ref: true, max_text_chars: 2000 });
      expect(result).toMatchObject({
        output: {
          page: {
            dom_summary: expect.arrayContaining([expect.stringContaining("Fixture Page")]),
            evidence_ref: expect.stringMatching(/^browser_page:sha256:[a-f0-9]{64}$/),
            screenshot: expect.objectContaining({ image_ref: "fixture://browser.png", width: 1280 }),
            storage_metadata: expect.objectContaining({ local_storage: { count: 2, keys: ["theme", "[redacted-key]"] } }),
            text: expect.stringContaining("Fixture Page")
          },
          provider: BROWSER_READONLY_PROVIDER_ID,
          source: "browser"
        },
        status: "succeeded"
      });
      const outputText = JSON.stringify(result.output);
      expect(outputText).not.toContain("super-secret");
      expect(outputText).not.toContain("token=abc123");

      const sync = syncCliRawEvents(db, result.output, { defaultProvider: BROWSER_READONLY_PROVIDER_ID, defaultSource: "browser" });
      const bundleInput = buildContextBundleFromEvents(sync.events, {
        anchorEventId: sync.events[0].id,
        createdBy: "user",
        source: "browser",
        trigger: "manual"
      });
      const bundle = createContextBundle(db, bundleInput);

      expect(bundle.source).toBe("browser");
      expect(bundle.evidence_refs).toEqual(expect.arrayContaining([`external_event:${sync.events[0].id}#attachment:0`]));
      expect(bundle.context[0]).toMatchObject({ source_ref: "browser:page-1", summary: expect.stringContaining("Fixture Page") });
      expect(auditPayloads(db, "conv-browser")[0]).toMatchObject({ provider_id: BROWSER_READONLY_PROVIDER_ID, status: "succeeded", tool: BROWSER_READ_PAGE_CONTEXT_TOOL_NAME });
    } finally {
      db.close();
    }
  });

  test("returns explicit read-only diagnostics for unavailable, unauthorized, cross-origin, and oversized pages", async () => {
    const db = await openFixture();
    try {
      await expect(callBrowser(db, "conv-missing", {}, {})).resolves.toMatchObject({ error: { code: "browser_unavailable" }, status: "failed" });
      await expect(callBrowser(db, "conv-auth", fixtureEnv({ authorized: false }), {})).resolves.toMatchObject({ error: { code: "browser_unauthorized" }, status: "denied" });
      await expect(callBrowser(db, "conv-cross", fixtureEnv(), { url: "https://evil.test/page" })).resolves.toMatchObject({ error: { code: "browser_cross_origin_denied" }, status: "denied" });
      await expect(callBrowser(db, "conv-large", fixtureEnv({ text: "L".repeat(210000) }), {})).resolves.toMatchObject({ error: { code: "browser_page_too_large" }, status: "denied" });
    } finally {
      db.close();
    }
  });

  test("exposes only read-only browser capabilities", () => {
    const tools = listBrowserAssistantTools();
    expect(tools.every((tool) => tool.permission === "read")).toBe(true);
    expect(tools.map((tool) => tool.name).join("\n")).not.toMatch(/click|type|form_submit|write/i);
  });
});

async function callBrowser(db: RunnerDatabase, conversationID: string, env: Record<string, string | undefined>, input: Record<string, unknown>) {
  return await invokeReadOnlyAssistantTool({
    auditContext: { conversationID, source: "test" },
    db,
    env,
    input,
    providerID: BROWSER_READONLY_PROVIDER_ID,
    toolName: BROWSER_READ_PAGE_CONTEXT_TOOL_NAME
  });
}

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-browser-tools-"));
  tempRoots.push(root);
  return await openDatabase({ stateDir: join(root, "state") });
}

function fixtureEnv(overrides: Record<string, unknown> = {}): Record<string, string> {
  return { [BROWSER_SNAPSHOT_ENV]: JSON.stringify(browserSnapshot(overrides)) };
}

function browserSnapshot(overrides: Record<string, unknown>): Record<string, unknown> {
  const text = String(overrides.text ?? "Fixture Page token=abc123 says hello from authorized browser context.");
  return {
    active_page_id: "page-1",
    authorized: overrides.authorized ?? true,
    pages: [{
      id: "page-1",
      url: "https://example.test/app?api_key=super-secret",
      title: "Fixture Page",
      text,
      dom_summary: [{ role: "heading", selector: "h1", text: "Fixture Page" }, { role: "button", text: "Read only" }],
      screenshot: { captured_at: "2026-07-09T00:00:00Z", height: 720, image_ref: "fixture://browser.png", mime_type: "image/png", width: 1280 },
      storage: { localStorage: { theme: "dark", auth_token: "super-secret" }, sessionStorage: {}, cookies: [{ name: "sid", value: "super-secret" }] }
    }]
  };
}

function auditPayloads(db: RunnerDatabase, conversationId: string): Array<Record<string, any>> {
  return listPiActionEvents(db, { conversationId })
    .filter((event) => event.event_type === "tool_call_audit")
    .map((event) => JSON.parse(event.payload_json) as Record<string, any>);
}
