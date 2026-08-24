import type { AssistantTool, ToolJsonSchema, ToolProvider } from "./toolProviderEnvelope.ts";

export const HTTP_READONLY_PROVIDER_ID = "http-readonly";
export const URL_FETCH_TOOL_NAME = "url_fetch";
export const HTTP_URL_FETCH_TIMEOUT_MS = 10_000;

export function listHttpToolProviders(): ToolProvider[] {
  return [{
    audit: { category: "http", redact: [], tags: ["http", "read-only"] },
    default_timeout_ms: HTTP_URL_FETCH_TIMEOUT_MS,
    description: "Read-only HTTP provider for bounded GET/HEAD URL fetches.",
    id: HTTP_READONLY_PROVIDER_ID,
    kind: "http",
    metadata: { connector: "http", read_only: true },
    name: "HTTP read-only",
    status: "enabled"
  }];
}

export function listHttpAssistantTools(): AssistantTool[] {
  return [{
    audit: { category: "http", redact: [], retention: "standard", tags: ["http", "source-context"] },
    description: "Fetch a URL with GET or HEAD and return bounded text evidence plus hash metadata.",
    input_schema: urlFetchInputSchema(),
    metadata: {
      connector: "http",
      read_only: true,
      risk_level: "low",
      xuanwu_runtime: {
        aliases: ["fetch url", "read web page", "读取网页"],
        family: "web.read",
        profiles: ["chat", "review"],
        risk_level: "low"
      }
    },
    name: URL_FETCH_TOOL_NAME,
    output_schema: urlFetchOutputSchema(),
    permission: "read",
    provider_id: HTTP_READONLY_PROVIDER_ID,
    timeout_ms: HTTP_URL_FETCH_TIMEOUT_MS
  }];
}

function urlFetchInputSchema(): ToolJsonSchema {
  return {
    additionalProperties: false,
    properties: {
      allow_content_types: { items: { type: "string" }, type: "array" },
      deny_content_types: { items: { type: "string" }, type: "array" },
      extract_text: { type: "boolean" },
      max_bytes: { maximum: 262144, minimum: 1, type: "integer" },
      max_redirects: { maximum: 10, minimum: 0, type: "integer" },
      method: { enum: ["GET", "HEAD"], type: "string" },
      timeout_ms: { maximum: 30000, minimum: 1, type: "integer" },
      url: { type: "string" }
    },
    required: ["url"],
    type: "object"
  };
}

function urlFetchOutputSchema(): ToolJsonSchema {
  return {
    additionalProperties: false,
    properties: {
      bytes_read: { type: "integer" },
      content_type: { type: "string" },
      evidence_ref: { type: "string" },
      final_url: { type: "string" },
      hash: { type: "string" },
      hash_scope: { type: "string" },
      max_bytes: { type: "integer" },
      ok: { type: "boolean" },
      redirect_count: { type: "integer" },
      redirects: { items: { type: "object" }, type: "array" },
      status: { type: "integer" },
      text: { type: "string" },
      text_extracted: { type: "boolean" },
      truncated: { type: "boolean" },
      url: { type: "string" }
    },
    type: "object"
  };
}
