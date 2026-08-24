import { describe, expect, test } from "bun:test";
import {
  assistantToolKey,
  isToolPermission,
  isToolProviderKind,
  validateAssistantTool,
  validateToolInvocation,
  validateToolProvider,
  validateToolResult,
  type AssistantTool,
  type ToolProvider
} from "./toolProviderEnvelope.ts";

describe("Tool Provider envelope", () => {
  test("accepts supported provider kinds and permissions", () => {
    expect(isToolProviderKind("builtin")).toBe(true);
    expect(isToolProviderKind("cli")).toBe(true);
    expect(isToolProviderKind("mcp")).toBe(true);
    expect(isToolProviderKind("http")).toBe(true);
    expect(isToolProviderKind("browser")).toBe(true);
    expect(isToolProviderKind("feishu")).toBe(false);
    expect(isToolPermission("read")).toBe(true);
    expect(isToolPermission("write")).toBe(true);
    expect(isToolPermission("dangerous")).toBe(true);
    expect(isToolPermission("admin")).toBe(false);
  });

  test("validates a reusable provider and assistant tool envelope", () => {
    const provider = {
      audit: { redact: ["headers.authorization"] },
      default_timeout_ms: 5000,
      id: "runner-builtin",
      kind: "builtin",
      name: "Runner builtin"
    } satisfies ToolProvider;
    const tool = {
      audit: { redact: ["input.api_key"], tags: ["runner"] },
      description: "Read a bounded issue summary.",
      input_schema: { additionalProperties: false, properties: { id: { type: "integer" } }, type: "object" },
      name: "issue_read",
      output_schema: { type: "object" },
      permission: "read",
      provider_id: provider.id,
      metadata: {
        xuanwu_runtime: {
          aliases: ["read issue"],
          family: "issue",
          profiles: ["chat", "review"],
          risk_level: "low"
        }
      },
      timeout_ms: 3000
    } satisfies AssistantTool;

    expect(validateToolProvider(provider)).toEqual([]);
    expect(validateAssistantTool(tool)).toEqual([]);
    expect(assistantToolKey(tool)).toBe("runner-builtin:issue_read");
  });

  test("rejects malformed runtime surface metadata before it can hide tools", () => {
    expect(validateAssistantTool({
      audit: { redact: [] },
      description: "Broken metadata fixture.",
      input_schema: { type: "object" },
      metadata: {
        xuanwu_runtime: {
          aliases: [""],
          family: "",
          profiles: ["chat", "missing-profile"],
          risk_level: "critical"
        }
      },
      name: "broken_tool",
      permission: "read",
      provider_id: "runner-builtin"
    })).toEqual([
      { path: "metadata.xuanwu_runtime.family", message: "must be a non-empty string" },
      { path: "metadata.xuanwu_runtime.aliases", message: "aliases must be an array of non-empty strings" },
      { path: "metadata.xuanwu_runtime.profiles", message: "profiles must contain only supported runtime profiles" },
      { path: "metadata.xuanwu_runtime.risk_level", message: "risk_level must be low, medium, or high" }
    ]);
  });

  test("reports basic envelope validation errors", () => {
    expect(validateToolProvider({ id: "", kind: "smtp", name: "Mail", default_timeout_ms: 0 })).toEqual([
      { path: "id", message: "must be a non-empty string" },
      { path: "kind", message: "kind must be a supported provider kind" },
      { path: "default_timeout_ms", message: "must be a positive integer" }
    ]);
    expect(validateAssistantTool({
      audit: { redact: ["ok", 1] },
      description: "",
      input_schema: null,
      name: "send",
      permission: "admin",
      provider_id: "http-mail",
      timeout_ms: -1
    })).toEqual([
      { path: "description", message: "must be a non-empty string" },
      { path: "input_schema", message: "input_schema must be an object" },
      { path: "permission", message: "permission must be read, write, or dangerous" },
      { path: "timeout_ms", message: "must be a positive integer" },
      { path: "audit.redact", message: "redact must be a string array" }
    ]);
  });

  test("validates invocation envelope basics", () => {
    expect(validateToolInvocation({
      id: "call-1",
      input: { id: 1 },
      permission: "read",
      provider_id: "runner-builtin",
      tool_name: "issue_read"
    })).toEqual([]);
    expect(validateToolInvocation({ id: "", input: [], permission: "admin", provider_id: "", tool_name: "" })).toEqual([
      { path: "id", message: "must be a non-empty string" },
      { path: "tool_name", message: "must be a non-empty string" },
      { path: "provider_id", message: "must be a non-empty string" },
      { path: "input", message: "input must be an object" },
      { path: "permission", message: "permission must be read, write, or dangerous" }
    ]);
  });

  test("validates tool result status and error envelope", () => {
    expect(validateToolResult({
      duration_ms: 12,
      invocation_id: "call-1",
      status: "succeeded"
    })).toEqual([]);
    expect(validateToolResult({
      duration_ms: -1,
      error: { code: 404 },
      invocation_id: "",
      status: "partial"
    })).toEqual([
      { path: "invocation_id", message: "must be a non-empty string" },
      { path: "status", message: "status must be a supported result status" },
      { path: "duration_ms", message: "must be a non-negative integer" },
      { path: "error.message", message: "must be a non-empty string" },
      { path: "error.code", message: "code must be a string" }
    ]);
  });
});
