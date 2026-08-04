import type { AssistantTool, ToolJsonSchema, ToolProvider } from "./toolProviderEnvelope.ts";

export const BROWSER_READONLY_PROVIDER_ID = "browser-readonly";
export const BROWSER_READ_PAGE_CONTEXT_TOOL_NAME = "read_page_context";
export const BROWSER_SNAPSHOT_ENV = "XUANWU_BROWSER_SNAPSHOT_JSON";
export const BROWSER_READ_TIMEOUT_MS = 5_000;

export function listBrowserToolProviders(): ToolProvider[] {
  return [{
    audit: { category: "browser", redact: ["storage", "cookies"], tags: ["browser", "read-only"] },
    default_timeout_ms: BROWSER_READ_TIMEOUT_MS,
    description: "Read-only browser context provider for user-authorized page text, DOM summary, screenshot metadata, and storage metadata.",
    id: BROWSER_READONLY_PROVIDER_ID,
    kind: "browser",
    metadata: {
      capabilities: ["page_text", "dom_summary", "screenshot_metadata", "storage_metadata"],
      connector: "browser",
      read_only: true,
      snapshot_env: BROWSER_SNAPSHOT_ENV
    },
    name: "Browser read-only",
    status: "enabled"
  }];
}

export function listBrowserAssistantTools(): AssistantTool[] {
  return [{
    audit: {
      category: "browser",
      redact: ["input.url", "output.page.storage_metadata", "output.events.raw_json"],
      retention: "standard",
      tags: ["browser", "source-context", "read-only"]
    },
    description: "Read an authorized browser page as bounded source evidence: text, DOM summary, screenshot metadata/optional image ref, and storage metadata only.",
    input_schema: browserReadInputSchema(),
    metadata: {
      connector: "browser",
      read_only: true,
      source_contract: "raw_events"
    },
    name: BROWSER_READ_PAGE_CONTEXT_TOOL_NAME,
    output_schema: browserReadOutputSchema(),
    permission: "read",
    provider_id: BROWSER_READONLY_PROVIDER_ID,
    timeout_ms: BROWSER_READ_TIMEOUT_MS
  }];
}

function browserReadInputSchema(): ToolJsonSchema {
  return {
    additionalProperties: false,
    properties: {
      allow_truncated: { type: "boolean" },
      include_dom_summary: { type: "boolean" },
      include_image_ref: { type: "boolean" },
      include_screenshot: { type: "boolean" },
      include_text: { type: "boolean" },
      max_dom_items: { maximum: 200, minimum: 1, type: "integer" },
      max_text_chars: { maximum: 50000, minimum: 1, type: "integer" },
      page_id: { type: "string" },
      url: { type: "string" }
    },
    type: "object"
  };
}

function browserReadOutputSchema(): ToolJsonSchema {
  return {
    additionalProperties: false,
    properties: {
      events: { items: { type: "object" }, type: "array" },
      page: { type: "object" },
      processed_watermark: { type: "string" },
      provider: { type: "string" },
      redaction: { type: "object" },
      source: { type: "string" }
    },
    type: "object"
  };
}
