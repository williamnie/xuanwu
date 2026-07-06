import { isToolPermission, type ToolJsonSchema, type ToolPermission } from "./toolProviderEnvelope.ts";

export type CliCommandTemplate = { executable: string; args?: string[] };
export type CliConnectorAuth = { type: "none" | "env" | "oauth" | "custom"; env?: string[]; description?: string };
export type CliConnectorEnvVar = { name: string; required?: boolean; secret?: boolean; description?: string };
export type CliExitCodeContract = {
  success: number[];
  retryable?: number[];
  auth_required?: number[];
  usage_error?: number[];
};
export type CliStderrSummary = { summary: "first_line" | "last_line" | "tail" | "none"; max_bytes?: number };
export type CliConnectorTimeout = { default_ms?: number; max_ms?: number };
export type CliConnectorHealth = {
  command: CliCommandTemplate; timeout_ms?: number; stdout: { mode: "json" }; exit_codes: CliExitCodeContract;
};
export type CliConnectorCommand = {
  name: string; description: string; permission: ToolPermission; command: CliCommandTemplate;
  input_schema: ToolJsonSchema; output_schema: ToolJsonSchema; stdout: { mode: "json" };
  exit_codes: CliExitCodeContract; stderr?: CliStderrSummary;
  cursor?: { input_field?: string; output_field?: string }; idempotency?: { input_field: string };
  timeout_ms?: number;
};
export type CliConnectorManifest = {
  manifest_version: "pi-cli-connector.v0"; id: string; name: string; kind: "cli";
  description?: string; auth?: CliConnectorAuth; env?: CliConnectorEnvVar[];
  timeout?: CliConnectorTimeout; health: CliConnectorHealth; commands: CliConnectorCommand[];
};
export type CliManifestValidationIssue = { path: string; message: string };
export type CliConnectorManifestParseResult =
  { ok: true; manifest: CliConnectorManifest } | { ok: false; issues: CliManifestValidationIssue[] };

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_RE = /^[A-Z_][A-Z0-9_]*$/;
const TEMPLATE_RE = /{{\s*input\.([A-Za-z0-9_]+)\s*}}/g;
const AUTH_TYPES = new Set(["none", "env", "oauth", "custom"]);
const STDERR_MODES = new Set(["first_line", "last_line", "tail", "none"]);
const EXIT_CODE_KEYS = ["success", "retryable", "auth_required", "usage_error"];

export function parseCliConnectorManifestJson(text: string): CliConnectorManifestParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, issues: [{ path: "$", message: jsonError(error) }] };
  }
  const issues = validateCliConnectorManifest(parsed);
  return issues.length === 0
    ? { ok: true, manifest: parsed as CliConnectorManifest }
    : { ok: false, issues };
}

export function validateCliConnectorManifest(value: unknown): CliManifestValidationIssue[] {
  if (!isRecord(value)) return [{ path: "manifest", message: "must be an object" }];
  const issues: CliManifestValidationIssue[] = [];
  requireLiteral(issues, value.manifest_version, "pi-cli-connector.v0", "manifest_version");
  requireID(issues, value.id, "id");
  requireString(issues, value.name, "name");
  requireLiteral(issues, value.kind, "cli", "kind");
  optionalString(issues, value.description, "description");
  validateAuth(issues, value.auth);
  validateEnv(issues, value.env);
  validateTimeout(issues, value.timeout);
  validateHealth(issues, value.health, maxTimeout(value.timeout));
  validateCommands(issues, value.commands, maxTimeout(value.timeout));
  return issues;
}

function validateCommands(issues: CliManifestValidationIssue[], value: unknown, maxMs?: number): void {
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path: "commands", message: "must be a non-empty array" });
    return;
  }
  value.forEach((command, index) => validateCommand(issues, command, `commands[${index}]`, maxMs));
}

function validateCommand(issues: CliManifestValidationIssue[], value: unknown, path: string, maxMs?: number): void {
  if (!isRecord(value)) return addIssue(issues, path, "must be an object");
  requireID(issues, value.name, `${path}.name`);
  requireString(issues, value.description, `${path}.description`);
  if (!isToolPermission(value.permission)) {
    issues.push({ path: `${path}.permission`, message: "must be read, write, or dangerous" });
  }
  validateSchema(issues, value.input_schema, `${path}.input_schema`);
  validateSchema(issues, value.output_schema, `${path}.output_schema`);
  const inputFields = schemaProperties(value.input_schema);
  const outputFields = schemaProperties(value.output_schema);
  validateTemplate(issues, value.command, `${path}.command`, inputFields);
  validateStdout(issues, value.stdout, `${path}.stdout`);
  validateExitCodes(issues, value.exit_codes, `${path}.exit_codes`);
  validateStderr(issues, value.stderr, `${path}.stderr`);
  validateCursor(issues, value.cursor, `${path}.cursor`, inputFields, outputFields);
  validateIdempotency(issues, value.idempotency, `${path}.idempotency`, inputFields);
  validateTimeoutValue(issues, value.timeout_ms, `${path}.timeout_ms`, maxMs);
}

function validateTemplate(
  issues: CliManifestValidationIssue[],
  value: unknown,
  path: string,
  inputFields: Set<string>
): void {
  if (!isRecord(value)) return addIssue(issues, path, "must be an object");
  if (typeof value.executable !== "string" || !safeExecutable(value.executable)) {
    issues.push({ path: `${path}.executable`, message: "must be a safe executable name or path without shell syntax" });
  }
  if (value.args === undefined) return;
  if (!Array.isArray(value.args)) return addIssue(issues, `${path}.args`, "must be a string array");
  value.args.forEach((arg, index) => validateArgTemplate(issues, arg, `${path}.args[${index}]`, inputFields));
}

function validateArgTemplate(
  issues: CliManifestValidationIssue[],
  value: unknown,
  path: string,
  inputFields: Set<string>
): void {
  if (typeof value !== "string") return addIssue(issues, path, "must be a string");
  const fields = [...value.matchAll(TEMPLATE_RE)].map((match) => match[1]);
  if (value.includes("{{") && fields.length === 0) issues.push({ path, message: "template must use {{input.field}}" });
  for (const field of fields) {
    if (!inputFields.has(field)) issues.push({ path, message: `template references unknown input field: ${field}` });
  }
}

function validateAuth(issues: CliManifestValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) return addIssue(issues, "auth", "must be an object");
  if (typeof value.type !== "string" || !AUTH_TYPES.has(value.type)) {
    issues.push({ path: "auth.type", message: "must be none, env, oauth, or custom" });
  }
  if (value.env !== undefined) validateStringArray(issues, value.env, "auth.env", ENV_RE);
  optionalString(issues, value.description, "auth.description");
}

function validateEnv(issues: CliManifestValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return addIssue(issues, "env", "must be an array");
  value.forEach((item, index) => {
    const path = `env[${index}]`;
    if (!isRecord(item)) return addIssue(issues, path, "must be an object");
    if (typeof item.name !== "string" || !ENV_RE.test(item.name)) {
      issues.push({ path: `${path}.name`, message: "must be an uppercase environment variable name" });
    }
    optionalBoolean(issues, item.required, `${path}.required`);
    optionalBoolean(issues, item.secret, `${path}.secret`);
    optionalString(issues, item.description, `${path}.description`);
    if ("value" in item || "default" in item) issues.push({ path, message: "must not contain secret values" });
  });
}

function validateTimeout(issues: CliManifestValidationIssue[], value: unknown): void {
  if (value === undefined) return;
  if (!isRecord(value)) return addIssue(issues, "timeout", "must be an object");
  validateTimeoutValue(issues, value.default_ms, "timeout.default_ms");
  validateTimeoutValue(issues, value.max_ms, "timeout.max_ms");
  if (isPositiveInteger(value.default_ms) && isPositiveInteger(value.max_ms) && value.default_ms > value.max_ms) {
    issues.push({ path: "timeout.default_ms", message: "must be less than or equal to timeout.max_ms" });
  }
}

function validateHealth(issues: CliManifestValidationIssue[], value: unknown, maxMs?: number): void {
  if (value === undefined) return addIssue(issues, "health", "must be an object");
  if (!isRecord(value)) return addIssue(issues, "health", "must be an object");
  validateTemplate(issues, value.command, "health.command", new Set());
  validateStdout(issues, value.stdout, "health.stdout");
  validateExitCodes(issues, value.exit_codes, "health.exit_codes");
  validateTimeoutValue(issues, value.timeout_ms, "health.timeout_ms", maxMs);
}

function validateStdout(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  if (!isRecord(value)) return addIssue(issues, path, "must be an object");
  if (value.mode !== "json") issues.push({ path: `${path}.mode`, message: "must be json" });
}

function validateExitCodes(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  if (!isRecord(value)) return addIssue(issues, path, "must be an object");
  for (const key of EXIT_CODE_KEYS) {
    if (key in value) validateIntegerArray(issues, value[key], `${path}.${key}`);
  }
  if (!Array.isArray(value.success) || !value.success.includes(0)) {
    issues.push({ path: `${path}.success`, message: "must include 0" });
  }
}

function validateStderr(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) return addIssue(issues, path, "must be an object");
  if (typeof value.summary !== "string" || !STDERR_MODES.has(value.summary)) {
    issues.push({ path: `${path}.summary`, message: "must be first_line, last_line, tail, or none" });
  }
  validateTimeoutValue(issues, value.max_bytes, `${path}.max_bytes`);
}

function validateCursor(
  issues: CliManifestValidationIssue[], value: unknown, path: string,
  inputFields: Set<string>, outputFields: Set<string>
): void {
  if (value === undefined) return;
  if (!isRecord(value)) return addIssue(issues, path, "must be an object");
  optionalFieldRef(issues, value.input_field, `${path}.input_field`, inputFields);
  optionalFieldRef(issues, value.output_field, `${path}.output_field`, outputFields);
}

function validateIdempotency(issues: CliManifestValidationIssue[], value: unknown, path: string, fields: Set<string>): void {
  if (value === undefined) return;
  if (!isRecord(value)) return addIssue(issues, path, "must be an object");
  if (typeof value.input_field !== "string") return addIssue(issues, `${path}.input_field`, "must be a string");
  if (!fields.has(value.input_field)) issues.push({ path: `${path}.input_field`, message: "must reference input_schema.properties" });
}

function validateSchema(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  if (!isRecord(value)) return addIssue(issues, path, "must be an object");
  if (value.type !== undefined && value.type !== "object") issues.push({ path: `${path}.type`, message: "must be object" });
  if (value.properties !== undefined && !isRecord(value.properties)) {
    issues.push({ path: `${path}.properties`, message: "must be an object" });
  }
}

function validateStringArray(
  issues: CliManifestValidationIssue[], value: unknown, path: string, pattern?: RegExp
): void {
  if (!Array.isArray(value)) return addIssue(issues, path, "must be a string array");
  value.forEach((item, index) => {
    if (typeof item !== "string" || (pattern && !pattern.test(item))) {
      issues.push({ path: `${path}[${index}]`, message: "must be a valid string" });
    }
  });
}

function validateIntegerArray(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  if (!Array.isArray(value) || value.some((item) => !Number.isInteger(item) || item < 0)) {
    issues.push({ path, message: "must be a non-negative integer array" });
  }
}

function validateTimeoutValue(issues: CliManifestValidationIssue[], value: unknown, path: string, maxMs?: number): void {
  if (value === undefined) return;
  if (!isPositiveInteger(value)) return addIssue(issues, path, "must be a positive integer");
  if (maxMs !== undefined && value > maxMs) issues.push({ path, message: "must not exceed timeout.max_ms" });
}

function optionalFieldRef(issues: CliManifestValidationIssue[], value: unknown, path: string, fields: Set<string>): void {
  if (value === undefined) return;
  if (typeof value !== "string") return addIssue(issues, path, "must be a string");
  if (!fields.has(value)) issues.push({ path, message: "must reference schema properties" });
}

function addIssue(issues: CliManifestValidationIssue[], path: string, message: string): void { issues.push({ path, message }); }

function requireLiteral(issues: CliManifestValidationIssue[], value: unknown, expected: string, path: string): void {
  if (value !== expected) issues.push({ path, message: `must be ${expected}` });
}

function requireID(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  requireString(issues, value, path);
  if (typeof value === "string" && value.trim() !== "" && !ID_RE.test(value)) {
    issues.push({ path, message: "must use lowercase letters, digits, dot, underscore, or dash" });
  }
}

function requireString(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim() === "") {
    issues.push({ path, message: "must be a non-empty string" });
  }
}

function optionalString(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "string") addIssue(issues, path, "must be a string");
}

function optionalBoolean(issues: CliManifestValidationIssue[], value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "boolean") issues.push({ path, message: "must be a boolean" });
}

function schemaProperties(schema: unknown): Set<string> {
  if (!isRecord(schema) || !isRecord(schema.properties)) return new Set();
  return new Set(Object.keys(schema.properties));
}

function maxTimeout(value: unknown): number | undefined {
  if (!isRecord(value) || !isPositiveInteger(value.max_ms)) return undefined;
  return value.max_ms;
}

function safeExecutable(value: string): boolean {
  return value.trim() !== "" && !/[\s|&;<>()$`]/.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonError(error: unknown): string {
  return error instanceof Error ? error.message : "invalid JSON";
}
