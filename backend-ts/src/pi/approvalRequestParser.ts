import { posix as posixPath } from "node:path";
import { redactSensitiveText } from "../util/redact.ts";

export type ApprovalRequestType = "command" | "fileChange" | "permissions" | "unknown";
export type ApprovalParseStatus = "ok" | "ambiguous";

export type NormalizedApprovalPath = {
  in_cwd: boolean;
  normalized_path: string;
  raw_path: string;
};

export type NormalizedApprovalScope = {
  all_paths_within_cwd: boolean;
  cwd: string;
  path_count: number;
  paths_within_cwd: number;
};

export type NormalizedApprovalRequest = {
  approval_id: string;
  command: string;
  method: string;
  normalized_scope: NormalizedApprovalScope;
  parse_status: ApprovalParseStatus;
  paths: NormalizedApprovalPath[];
  permissions: Record<string, unknown>;
  request_type: ApprovalRequestType;
  summary: string;
  thread_id: string;
  turn_id: string;
};

export type ParseCodexApprovalRequestInput = {
  jsonRpcId?: string | number;
  method: string;
  params: unknown;
};

const PATH_TOKEN_PATTERN = /(?:^|[\s"'`=])((?:~\/|\/|\.\.?\/)[^\s"'`,;|)]+)/g;
const REDACTABLE_PATH_PATTERN = /(?:^|[\s"'`=,])((?:~\/|\/|\.\.?\/)[^\s"'`,;|)]+)/g;
const SUMMARY_MAX_LENGTH = 320;

export function parseCodexApprovalRequest(input: ParseCodexApprovalRequestInput): NormalizedApprovalRequest {
  try {
    return normalizeRequest(input, recordValue(input.params));
  } catch {
    return ambiguousRequest(input, {});
  }
}

function normalizeRequest(
  input: ParseCodexApprovalRequestInput,
  rawParams: Record<string, unknown>
): NormalizedApprovalRequest {
  const envelope = approvalEnvelope(input.method, rawParams);
  const params = envelope.params;
  const item = recordValue(params.item);
  const method = envelope.method;
  const requestType = requestTypeFor(method, params, item);
  const cwd = normalizeCwd(textField(params, item, "cwd", "workingDirectory", "workspace"));
  const command = textField(params, item, "command");
  const paths = normalizePaths([...explicitPathValues(params, item), ...commandPathValues(command)], cwd);
  const permissions = recordValue(params.permissions);
  const parseStatus = ambiguousInput(input.params, params, {
    command,
    paths,
    permissions,
    requestType
  }) ? "ambiguous" : "ok";
  return {
    approval_id: approvalID(input.jsonRpcId, params, rawParams),
    command,
    method,
    normalized_scope: scopeFor(paths, cwd),
    parse_status: parseStatus,
    paths,
    permissions,
    request_type: requestType,
    summary: approvalSummary({ command, paths, permissions, requestType }),
    thread_id: cleanText(params.threadId ?? params.conversationId),
    turn_id: cleanText(params.turnId)
  };
}

function ambiguousRequest(
  input: ParseCodexApprovalRequestInput,
  params: Record<string, unknown>
): NormalizedApprovalRequest {
  const method = cleanText(input.method);
  const requestType = requestTypeFor(method, params, {});
  return {
    approval_id: approvalID(input.jsonRpcId, params, params),
    command: "",
    method,
    normalized_scope: scopeFor([], ""),
    parse_status: "ambiguous",
    paths: [],
    permissions: {},
    request_type: requestType,
    summary: approvalSummary({ command: "", paths: [], permissions: {}, requestType }),
    thread_id: "",
    turn_id: ""
  };
}

function approvalEnvelope(method: string, rawParams: Record<string, unknown>) {
  const nestedParams = recordValue(rawParams.params);
  const nestedMethod = cleanText(rawParams.method);
  if (nestedMethod === "" || Object.keys(nestedParams).length === 0) {
    return { method: cleanText(method), params: rawParams };
  }
  return { method: nestedMethod, params: nestedParams };
}

function requestTypeFor(
  method: string,
  params: Record<string, unknown>,
  item: Record<string, unknown>
): ApprovalRequestType {
  if (method.includes("commandExecution") || cleanText(params.command ?? item.command) !== "") return "command";
  if (method.includes("fileChange") || explicitPathValues(params, item).length > 0) return "fileChange";
  if (method.includes("permissions") || Object.keys(recordValue(params.permissions)).length > 0) return "permissions";
  return "unknown";
}

function explicitPathValues(params: Record<string, unknown>, item: Record<string, unknown>): string[] {
  return [
    cleanText(params.path ?? item.path),
    ...changesPaths(params),
    ...changesPaths(item)
  ].filter(Boolean);
}

function changesPaths(raw: Record<string, unknown>): string[] {
  const changes = Array.isArray(raw.changes) ? raw.changes : [];
  return changes.map((value) => cleanText(recordValue(value).path)).filter(Boolean);
}

function commandPathValues(command: string): string[] {
  const paths: string[] = [];
  for (const match of command.matchAll(PATH_TOKEN_PATTERN)) paths.push(cleanPathToken(match[1] ?? ""));
  return paths.filter(Boolean);
}

function normalizePaths(values: string[], cwd: string): NormalizedApprovalPath[] {
  const seen = new Set<string>();
  return values.flatMap((rawPath) => {
    const raw = cleanPathToken(rawPath);
    const normalized = normalizePath(raw, cwd);
    const key = `${raw}\0${normalized}`;
    if (raw === "" || normalized === "" || seen.has(key)) return [];
    seen.add(key);
    return [{ raw_path: raw, normalized_path: normalized, in_cwd: isWithinCwd(normalized, cwd) }];
  });
}

function normalizePath(rawPath: string, cwd: string): string {
  if (rawPath.startsWith("~/")) return rawPath.replace(/\/+$/g, "");
  if (rawPath.startsWith("/")) return posixPath.normalize(rawPath);
  return cwd === "" ? posixPath.normalize(rawPath) : posixPath.resolve(cwd, rawPath);
}

function normalizeCwd(value: string): string {
  if (value === "" || !value.startsWith("/")) return "";
  return posixPath.normalize(value).replace(/\/+$/g, "") || "/";
}

function scopeFor(paths: NormalizedApprovalPath[], cwd: string): NormalizedApprovalScope {
  const inside = paths.filter((item) => item.in_cwd).length;
  return {
    all_paths_within_cwd: cwd !== "" && paths.length > 0 && inside === paths.length,
    cwd,
    path_count: paths.length,
    paths_within_cwd: inside
  };
}

function isWithinCwd(candidate: string, cwd: string): boolean {
  if (cwd === "" || candidate.startsWith("~/")) return false;
  return candidate === cwd || candidate.startsWith(`${cwd}/`);
}

function approvalSummary(input: {
  command: string;
  paths: NormalizedApprovalPath[];
  permissions: Record<string, unknown>;
  requestType: ApprovalRequestType;
}): string {
  const parts = [
    input.requestType,
    input.command === "" ? "" : `command=${input.command}`,
    input.paths.length === 0 ? "" : `paths=${input.paths.map((item) => item.raw_path).join(",")}`,
    Object.keys(input.permissions).length === 0 ? "" : `permissions=${safeJSONString(input.permissions)}`
  ].filter(Boolean);
  return truncate(redactApprovalSummary(parts.join(" ")));
}

function redactApprovalSummary(text: string): string {
  return redactSensitiveText(text).replace(REDACTABLE_PATH_PATTERN, (match, pathToken: string) => {
    return match.replace(pathToken, "[redacted-path]");
  });
}

function safeJSONString(value: Record<string, unknown>): string {
  return JSON.stringify(redactedValue(value));
}

function redactedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactedValue);
  const raw = recordValue(value);
  if (Object.keys(raw).length === 0) return value;
  return Object.fromEntries(
    Object.entries(raw).map(([key, item]) => [key, sensitiveKey(key) ? "[redacted]" : redactedValue(item)])
  );
}

function sensitiveKey(key: string): boolean {
  return /(?:token|secret|password|api[_-]?key|access[_-]?key|credential)/i.test(key);
}

function approvalID(
  jsonRpcId: string | number | undefined,
  params: Record<string, unknown>,
  envelope: Record<string, unknown>
): string {
  return firstText(
    envelope.id,
    envelope.approvalId,
    params.approvalId,
    params.itemId,
    params.callId,
    params.id,
    jsonRpcId === undefined ? "" : String(jsonRpcId)
  );
}

function ambiguousInput(
  rawParams: unknown,
  params: Record<string, unknown>,
  parsed: {
    command: string;
    paths: NormalizedApprovalPath[];
    permissions: Record<string, unknown>;
    requestType: ApprovalRequestType;
  }
): boolean {
  if (Object.keys(params).length === 0 && rawParams !== undefined) return true;
  if (parsed.requestType === "unknown") return true;
  if (parsed.requestType === "command") return parsed.command === "";
  if (parsed.requestType === "fileChange") return parsed.paths.length === 0;
  if (parsed.requestType === "permissions") return Object.keys(parsed.permissions).length === 0;
  return false;
}

function textField(params: Record<string, unknown>, item: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = cleanText(params[key] ?? item[key]);
    if (value !== "") return value;
  }
  return "";
}

function cleanPathToken(value: string): string {
  return value.trim().replace(/[\].,;:]+$/g, "").replace(/[.,;:]+$/g, "");
}

function firstText(...values: unknown[]): string {
  return values.map(cleanText).find((value) => value !== "") ?? "";
}

function cleanText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function truncate(text: string): string {
  return text.length > SUMMARY_MAX_LENGTH ? `${text.slice(0, SUMMARY_MAX_LENGTH - 1)}…` : text;
}
