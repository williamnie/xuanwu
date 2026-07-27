#!/usr/bin/env bun

import { readFileSync, writeFileSync } from "node:fs";

const controlPath = process.env.MCP_ACTIVATION_CONTROL_FILE?.trim() ?? "";
const statePath = process.env.MCP_ACTIVATION_STATE_FILE?.trim() ?? "";

if (!controlPath || !statePath) {
  console.error("MCP activation fixture paths are not configured");
  process.exit(64);
}

if (!online()) {
  console.error("MCP activation fixture is intentionally offline");
  process.exit(69);
}

const input = await Bun.stdin.text();
for (const line of input.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
  const message = JSON.parse(line) as JsonRpcRequest;
  if (message.method === "initialize") {
    send(message.id, {
      capabilities: { resources: {}, tools: {} },
      protocolVersion: "2024-11-05",
      serverInfo: { name: "agent-05-safe-fixture", version: "1.0.0" }
    });
  }
  if (message.method === "tools/list") {
    send(message.id, {
      tools: [
        {
          annotations: { readOnlyHint: true },
          description: "Read isolated Agent-05 fixture state.",
          inputSchema: {
            additionalProperties: false,
            properties: { request_id: { type: "string" } },
            type: "object"
          },
          name: "fixture_read",
          outputSchema: {
            additionalProperties: false,
            properties: {
              fixture: { type: "string" },
              request_id: { type: "string" },
              value: { type: "string" }
            },
            required: ["fixture", "value"],
            type: "object"
          }
        },
        {
          annotations: { destructiveHint: true, openWorldHint: false },
          description: "Write isolated Agent-05 fixture state. Must remain approval-gated.",
          inputSchema: {
            additionalProperties: false,
            properties: { value: { type: "string" } },
            required: ["value"],
            type: "object"
          },
          name: "fixture_write"
        }
      ]
    });
  }
  if (message.method === "resources/list") send(message.id, { resources: [] });
  if (message.method === "tools/call") callTool(message);
}

type JsonRpcRequest = {
  id?: number | string;
  method?: string;
  params?: { arguments?: Record<string, unknown>; name?: string };
};

function online(): boolean {
  try {
    return JSON.parse(readFileSync(controlPath, "utf8")).online === true;
  } catch {
    return false;
  }
}

function callTool(message: JsonRpcRequest): void {
  const name = message.params?.name ?? "";
  const args = message.params?.arguments ?? {};
  if (name === "fixture_read") {
    const state = readState();
    send(message.id, {
      structuredContent: {
        fixture: "agent-05",
        request_id: typeof args.request_id === "string" ? args.request_id : "",
        value: state.value
      }
    });
    return;
  }
  if (name === "fixture_write") {
    const value = typeof args.value === "string" ? args.value : "";
    writeFileSync(statePath, JSON.stringify({ value }, null, 2) + "\n", "utf8");
    send(message.id, { structuredContent: { written: true } });
    return;
  }
  console.log(JSON.stringify({
    error: { code: -32601, message: `Unknown fixture tool: ${name}` },
    id: message.id,
    jsonrpc: "2.0"
  }));
}

function readState(): { value: string } {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { value?: unknown };
    return { value: typeof parsed.value === "string" ? parsed.value : "" };
  } catch {
    return { value: "" };
  }
}

function send(id: JsonRpcRequest["id"], result: unknown): void {
  console.log(JSON.stringify({ id, jsonrpc: "2.0", result }));
}
