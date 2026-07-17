import { existsSync, readFileSync } from "node:fs";

import type { SkillRegistryDiagnostic } from "./registry.ts";

export type SkillRuntimeKind = "intake" | "domain";
export type SkillRuntimeSandbox = "capability";
export type SkillInputObject = "context_bundle" | "inbox_item";
export type SkillOutputObject = "inbox_items" | "ignored_groups" | "action_proposals";
export type SkillToolPermission = "read" | "write" | "dangerous";
export type SkillPrimaryIntent =
  | "bug_report"
  | "status_question"
  | "reply_needed"
  | "decision_needed"
  | "summarize_request"
  | "create_task"
  | "monitor_thread"
  | "customer_feedback"
  | "support_request"
  | "other";

export type SkillRegistryTool = {
  aliases?: string[];
  name: string;
  permission?: SkillToolPermission;
  provider_id?: string;
};

export type SkillRuntimeExecution = {
  adapter: "builtin";
  handler: string;
  sandbox: SkillRuntimeSandbox;
  timeout_ms: number;
};

export type SkillRuntimeMetadata = {
  execution?: SkillRuntimeExecution;
  input_object?: SkillInputObject;
  input_schema?: Record<string, unknown>;
  intent_tags: string[];
  kind?: SkillRuntimeKind;
  output_objects: SkillOutputObject[];
  output_schema?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  primary_intents: SkillPrimaryIntent[];
  required_tools: string[];
  runtime_manifest_path?: string;
};

type RuntimeManifestInput = {
  availableTools?: SkillRegistryTool[];
  manifestPath: string;
  publicPath: (path: string) => string;
};

type ValidationIssue = { message: string; path: string };

const MANIFEST_VERSION = "pi-skill.v0";
const EXECUTION_ADAPTER = "builtin";
const KINDS: SkillRuntimeKind[] = ["intake", "domain"];
const SANDBOXES: SkillRuntimeSandbox[] = ["capability"];
const INPUT_OBJECTS: SkillInputObject[] = ["context_bundle", "inbox_item"];
const OUTPUT_OBJECTS: SkillOutputObject[] = ["inbox_items", "ignored_groups", "action_proposals"];
const TOOL_PERMISSIONS: SkillToolPermission[] = ["read", "write", "dangerous"];
const PRIMARY_INTENTS: SkillPrimaryIntent[] = [
  "bug_report", "status_question", "reply_needed", "decision_needed", "summarize_request",
  "create_task", "monitor_thread", "customer_feedback", "support_request", "other"
];

export function readSkillRuntimeManifest(
  input: RuntimeManifestInput,
  diagnostics: SkillRegistryDiagnostic[]
): SkillRuntimeMetadata {
  if (!existsSync(input.manifestPath)) return emptyRuntime();
  const sourcePath = input.publicPath(input.manifestPath);
  const parsed = readManifestJSON(input.manifestPath, sourcePath, diagnostics);
  if (parsed === undefined) return emptyRuntime();
  const issues = validateSkillManifest(parsed);
  if (issues.length > 0) {
    diagnostics.push(diagnostic("manifest_invalid", sourcePath, issuesMessage(issues)));
    return emptyRuntime();
  }
  const manifest = normalizedManifest(parsed as Record<string, unknown>, sourcePath);
  diagnoseTools(manifest, input.availableTools, sourcePath, diagnostics);
  return manifest;
}

export function emptyRuntime(): SkillRuntimeMetadata {
  return { intent_tags: [], output_objects: [], primary_intents: [], required_tools: [] };
}

function readManifestJSON(
  path: string,
  sourcePath: string,
  diagnostics: SkillRegistryDiagnostic[]
): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    diagnostics.push(diagnostic("manifest_invalid", sourcePath, safeMessage(error)));
    return undefined;
  }
}

function validateSkillManifest(value: unknown): ValidationIssue[] {
  if (!isRecord(value)) return [{ path: "manifest", message: "must be an object" }];
  const issues: ValidationIssue[] = [];
  literal(issues, value.manifest_version, MANIFEST_VERSION, "manifest_version");
  enumValue(issues, value.kind, KINDS, "kind");
  enumValue(issues, value.input_object, INPUT_OBJECTS, "input_object");
  enumArray(issues, value.output_objects, OUTPUT_OBJECTS, "output_objects");
  stringArray(issues, value.required_tools, "required_tools");
  enumArray(issues, value.primary_intents ?? [], PRIMARY_INTENTS, "primary_intents");
  stringArray(issues, value.intent_tags ?? [], "intent_tags");
  recordValue(issues, value.input_schema, "input_schema");
  recordValue(issues, value.output_schema, "output_schema");
  recordValue(issues, value.permissions, "permissions");
  permissionValue(issues, recordOrEmpty(value.permissions).max_tool_permission);
  executionValue(issues, value.execution);
  stageContract(issues, value);
  return issues;
}

function stageContract(issues: ValidationIssue[], value: Record<string, unknown>): void {
  const kind = value.kind;
  const input = value.input_object;
  const outputs = Array.isArray(value.output_objects) ? value.output_objects : [];
  if (kind === "intake" && input !== "context_bundle") {
    issues.push({ path: "input_object", message: "intake skill input_object must be context_bundle" });
  }
  if (kind === "domain" && input !== "inbox_item") {
    issues.push({ path: "input_object", message: "domain skill input_object must be inbox_item" });
  }
  if (kind === "intake" && (!outputs.includes("inbox_items") || !outputs.includes("ignored_groups"))) {
    issues.push({ path: "output_objects", message: "intake skill must output inbox_items and ignored_groups" });
  }
  if (kind === "domain" && !outputs.includes("action_proposals")) {
    issues.push({ path: "output_objects", message: "domain skill must output action_proposals" });
  }
}

function normalizedManifest(value: Record<string, unknown>, sourcePath: string): SkillRuntimeMetadata {
  return {
    ...(value.execution === undefined
      ? {}
      : { execution: normalizedExecution(value.execution as Record<string, unknown>) }),
    input_object: value.input_object as SkillInputObject,
    input_schema: value.input_schema as Record<string, unknown>,
    intent_tags: uniqueStrings(value.intent_tags),
    kind: value.kind as SkillRuntimeKind,
    output_objects: uniqueEnums(value.output_objects, OUTPUT_OBJECTS),
    output_schema: value.output_schema as Record<string, unknown>,
    permissions: value.permissions as Record<string, unknown>,
    primary_intents: uniqueEnums(value.primary_intents, PRIMARY_INTENTS),
    required_tools: uniqueStrings(value.required_tools),
    runtime_manifest_path: sourcePath
  };
}

function normalizedExecution(value: Record<string, unknown>): SkillRuntimeExecution {
  return {
    adapter: EXECUTION_ADAPTER,
    handler: cleanString(value.handler),
    sandbox: value.sandbox as SkillRuntimeSandbox,
    timeout_ms: Number(value.timeout_ms)
  };
}

function diagnoseTools(
  manifest: SkillRuntimeMetadata,
  availableTools: SkillRegistryTool[] | undefined,
  sourcePath: string,
  diagnostics: SkillRegistryDiagnostic[]
): void {
  if (!availableTools) return;
  for (const name of manifest.required_tools) {
    const tool = availableTools.find((candidate) => toolMatches(candidate, name));
    if (!tool) diagnostics.push(diagnostic("missing_tool", sourcePath, `required tool missing: ${name}`));
    else diagnosePermission(manifest, tool, sourcePath, diagnostics);
  }
}

function diagnosePermission(
  manifest: SkillRuntimeMetadata,
  tool: SkillRegistryTool,
  sourcePath: string,
  diagnostics: SkillRegistryDiagnostic[]
): void {
  const max = manifest.permissions?.max_tool_permission;
  if (!isToolPermission(max) || !tool.permission) return;
  if (permissionRank(tool.permission) > permissionRank(max)) {
    diagnostics.push(diagnostic("permission_conflict", sourcePath, `tool ${tool.name} requires ${tool.permission}, max is ${max}`));
  }
}

function toolMatches(tool: SkillRegistryTool, name: string): boolean {
  return tool.name === name || `${tool.provider_id ?? ""}:${tool.name}` === name || (tool.aliases ?? []).includes(name);
}

function literal(issues: ValidationIssue[], value: unknown, expected: string, path: string): void {
  if (value !== expected) issues.push({ path, message: `must be ${expected}` });
}

function enumValue<T extends string>(issues: ValidationIssue[], value: unknown, allowed: T[], path: string): void {
  if (typeof value !== "string" || !(allowed as string[]).includes(value)) {
    issues.push({ path, message: `must be one of ${allowed.join(", ")}` });
  }
}

function enumArray<T extends string>(issues: ValidationIssue[], value: unknown, allowed: T[], path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !(allowed as string[]).includes(item))) {
    issues.push({ path, message: `must be an array of ${allowed.join(", ")}` });
  }
}

function stringArray(issues: ValidationIssue[], value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    issues.push({ path, message: "must be a non-empty string array" });
  }
}

function recordValue(issues: ValidationIssue[], value: unknown, path: string): void {
  if (!isRecord(value)) issues.push({ path, message: "must be an object" });
}

function permissionValue(issues: ValidationIssue[], value: unknown): void {
  if (value !== undefined && !isToolPermission(value)) {
    issues.push({ path: "permissions.max_tool_permission", message: "must be read, write, or dangerous" });
  }
}

function executionValue(issues: ValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    issues.push({ path: "execution", message: "must be an object" });
    return;
  }
  literal(issues, value.adapter, EXECUTION_ADAPTER, "execution.adapter");
  nonEmptyString(issues, value.handler, "execution.handler");
  enumValue(issues, value.sandbox, SANDBOXES, "execution.sandbox");
  boundedTimeout(issues, value.timeout_ms, "execution.timeout_ms");
  for (const key of Object.keys(value)) {
    if (!["adapter", "handler", "sandbox", "timeout_ms"].includes(key)) {
      issues.push({ path: `execution.${key}`, message: "is not supported" });
    }
  }
}

function nonEmptyString(issues: ValidationIssue[], value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim() === "") issues.push({ path, message: "must be a non-empty string" });
}

function boundedTimeout(issues: ValidationIssue[], value: unknown, path: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 30_000) {
    issues.push({ path, message: "must be an integer between 1 and 30000" });
  }
}

function uniqueEnums<T extends string>(value: unknown, allowed: T[]): T[] {
  return uniqueStrings(value).filter((item): item is T => (allowed as string[]).includes(item));
}

function uniqueStrings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))];
}

function recordOrEmpty(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isToolPermission(value: unknown): value is SkillToolPermission {
  return typeof value === "string" && (TOOL_PERMISSIONS as string[]).includes(value);
}

function permissionRank(permission: SkillToolPermission): number {
  return TOOL_PERMISSIONS.indexOf(permission);
}

function issuesMessage(issues: ValidationIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

function diagnostic(
  code: SkillRegistryDiagnostic["code"],
  source_path: string,
  message: string
): SkillRegistryDiagnostic {
  return { code, message, severity: "warning", source_path };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
