import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import { HTTP_READONLY_PROVIDER_ID } from "../../pi/httpToolProvider.ts";
import {
  validateToolInvocation,
  type ToolInvocation
} from "../../pi/toolProviderEnvelope.ts";
import {
  EVIDENCE_SCHEMA_VERSION,
  redactEvidenceRecord,
  redactEvidenceText,
  validateEvidence,
  type EvidenceArtifactRef,
  type EvidenceID,
  type EvidenceRecord,
  type RunAttemptID,
  type RunID,
  type WorkID
} from "./contracts.ts";

export const HTTP_EVIDENCE_TOOL_NAME = "http_evidence_verify";

export type HttpEvidenceRequestSpec = {
  headers?: Readonly<Record<string, string>>;
  max_redirects?: number;
  max_response_bytes?: number;
  method?: "GET" | "HEAD";
  retry?: {
    backoff_ms?: number;
    max_attempts?: number;
    retry_on_network_error?: boolean;
    retry_on_statuses?: readonly number[];
    retry_on_timeout?: boolean;
  };
  timeout_ms?: number;
  url: string;
};

export type HttpEvidenceAssertion =
  | { accepted_statuses?: readonly number[]; kind: "health"; label?: string }
  | { expected: number | readonly number[]; kind: "status_code"; label?: string }
  | {
      expected?: string;
      kind: "header";
      label?: string;
      name: string;
      operator: "contains" | "equals" | "exists";
    }
  | { kind: "json_schema"; label?: string; schema: Readonly<Record<string, unknown>> | boolean }
  | {
      expected?: unknown;
      kind: "business";
      label?: string;
      operator: "contains" | "equals" | "exists" | "greater_or_equal" | "less_or_equal" | "not_equals" | "truthy";
      path: string;
    };

export type HttpEvidenceInvocationInput = {
  assertions: readonly HttpEvidenceAssertion[];
  request: HttpEvidenceRequestSpec;
};

export type HttpEvidenceContext = {
  attempt_id?: RunAttemptID;
  audit_event_ref: string;
  collected_at?: string;
  evidence_id: EvidenceID;
  producer: DomainActor;
  run_id?: RunID;
  source_ref: string;
  work_id: WorkID;
};

export type VerifyHttpEvidenceInput = {
  artifact_refs?: readonly EvidenceArtifactRef[];
  context: HttpEvidenceContext;
  invocation: ToolInvocation;
};

export type HttpExchangeArtifactWrite = {
  audit_event_ref: string;
  bytes: number;
  content: string;
  evidence_id: EvidenceID;
  redacted_paths: readonly string[];
  sha256: string;
  source_ref: string;
};

export interface HttpEvidenceArtifactStore {
  writeHttpExchange(input: HttpExchangeArtifactWrite): Promise<EvidenceArtifactRef> | EvidenceArtifactRef;
}

export interface HttpEvidenceVerifier {
  verify(input: VerifyHttpEvidenceInput): Promise<EvidenceRecord>;
}

export type HttpEvidenceVerifierOptions = {
  artifact_store?: HttpEvidenceArtifactStore;
  fetch?: typeof fetch;
  max_inline_body_bytes?: number;
  sleep?: (milliseconds: number) => Promise<void>;
};

type NormalizedRequest = {
  headers: Record<string, string>;
  max_redirects: number;
  max_response_bytes: number;
  method: "GET" | "HEAD";
  retry: {
    backoff_ms: number;
    max_attempts: number;
    retry_on_network_error: boolean;
    retry_on_statuses: readonly number[];
    retry_on_timeout: boolean;
  };
  timeout_ms: number;
  url: string;
};

type ResponseObservation = {
  body: Uint8Array;
  final_url: string;
  headers: Record<string, string>;
  redirect_count: number;
  status: number;
  truncated: boolean;
};

type TransportFailure = {
  code: "network_error" | "permission_denied" | "redirect_limit" | "timeout";
  message: string;
};

type VerificationOutcome = {
  attempts: number;
  duration_ms: number;
  failure?: TransportFailure;
  response?: ResponseObservation;
};

type AssertionResult = {
  id: string;
  kind: HttpEvidenceAssertion["kind"];
  message: string;
  passed: boolean;
};

type SanitizedText = { redacted_paths: string[]; text: string };

const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_INLINE_BODY_BYTES = 4 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REDIRECTS = 3;
const MAX_REDIRECTS = 10;
const MAX_RETRY_ATTEMPTS = 3;
const MAX_RETRY_BACKOFF_MS = 5_000;
const MAX_ASSERTIONS = 32;
const MAX_HEADERS = 32;
const MAX_STATUS_CODES = 32;
const MAX_HEADER_VALUE_BYTES = 8 * 1024;
const MAX_JSON_SCHEMA_BYTES = 64 * 1024;
const MAX_FACT_TEXT_BYTES = 8 * 1024;
const DEFAULT_RETRY_STATUSES = [429, 502, 503, 504] as const;
const HTTP_ARTIFACT_ROOT = "artifacts/evidence-http-exchange";
const HEADER_NAME_PATTERN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SENSITIVE_NAME_PATTERN = /(?:authorization|cookie|credential|password|secret|token|api[_-]?key|access[_-]?key)/i;

export function createHttpEvidenceInvocation(
  id: string,
  input: HttpEvidenceInvocationInput
): ToolInvocation {
  const sensitiveHeaders = Object.keys(input.request.headers ?? {}).filter(isSensitiveName);
  const sensitiveAssertions = input.assertions.flatMap((assertion, index) => {
    if (assertion.kind === "header" && isSensitiveName(assertion.name) && assertion.expected !== undefined) {
      return [`input.assertions.${index}.expected`];
    }
    if (assertion.kind === "business" && isSensitiveName(assertion.path) && assertion.expected !== undefined) {
      return [`input.assertions.${index}.expected`];
    }
    return [];
  });
  return {
    id,
    tool_name: HTTP_EVIDENCE_TOOL_NAME,
    provider_id: HTTP_READONLY_PROVIDER_ID,
    input: { assertions: [...input.assertions], request: { ...input.request } },
    permission: "read",
    timeout_ms: input.request.timeout_ms ?? DEFAULT_TIMEOUT_MS,
    audit: {
      category: "verification/http",
      redact: [
        ...sensitiveHeaders.map((name) => `input.request.headers.${name}`),
        ...sensitiveAssertions
      ],
      retention: "standard",
      tags: ["evidence", "http", "read-only"]
    }
  };
}

export function createHttpEvidenceVerifier(options: HttpEvidenceVerifierOptions = {}): HttpEvidenceVerifier {
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  const inlineLimit = boundedInteger(
    options.max_inline_body_bytes,
    DEFAULT_MAX_INLINE_BODY_BYTES,
    256,
    8 * 1024,
    "max inline HTTP body bytes"
  );

  return {
    async verify(input) {
      const invocationInput = validateInvocation(input.invocation);
      const request = normalizeRequest(invocationInput.request, input.invocation.timeout_ms);
      const assertions = validateAssertions(invocationInput.assertions);
      const outcome = await executeWithRetry(fetcher, sleep, request);
      const results = outcome.response
        ? evaluateAssertions(assertions, outcome.response)
        : [];
      const status: EvidenceRecord["status"] = outcome.failure || results.some((item) => !item.passed)
        ? "failed"
        : "passed";
      const observedAt = normalizedTimestamp(
        input.context.collected_at ?? new Date().toISOString(),
        "Evidence collected_at"
      );
      const responseText = outcome.response ? decodeBody(outcome.response.body) : "";
      const safeBody = sanitizeResponseBody(responseText);
      const artifactRefs = uniqueArtifactRefs(input.artifact_refs ?? []);
      const fullAssertionResultsJson = JSON.stringify(results);
      const assertionResultsInline = Buffer.byteLength(fullAssertionResultsJson) <= MAX_FACT_TEXT_BYTES;
      const requiresArtifact = Boolean(outcome.response && outcome.response.body.byteLength > inlineLimit) ||
        !assertionResultsInline;
      if (requiresArtifact && !options.artifact_store) {
        throw new Error("HTTP verification output exceeds the inline Evidence limit but no artifact store was provided");
      }

      let artifactRedactionCount = 0;
      if (options.artifact_store) {
        const report = exchangeReport(request, outcome, results, safeBody);
        artifactRedactionCount = report.redacted_paths.length;
        const bytes = Buffer.from(report.content);
        const sha256 = createHash("sha256").update(bytes).digest("hex");
        const artifact = await options.artifact_store.writeHttpExchange({
          audit_event_ref: input.context.audit_event_ref,
          bytes: bytes.byteLength,
          content: report.content,
          evidence_id: input.context.evidence_id,
          redacted_paths: report.redacted_paths,
          sha256,
          source_ref: input.context.source_ref
        });
        if (artifact.sha256 !== sha256) {
          throw new Error("HTTP exchange artifact checksum does not match the collected report");
        }
        artifactRefs.push(artifact);
      }

      const passedAssertions = results.filter((item) => item.passed).length;
      const response = outcome.response;
      const evidence: EvidenceRecord = {
        schema_version: EVIDENCE_SCHEMA_VERSION,
        id: input.context.evidence_id,
        work_id: input.context.work_id,
        ...(input.context.run_id ? { run_id: input.context.run_id } : {}),
        ...(input.context.attempt_id ? { attempt_id: input.context.attempt_id } : {}),
        revision: 0,
        kind: "http",
        status,
        created_at: observedAt,
        observed_at: observedAt,
        updated_at: observedAt,
        completed_at: observedAt,
        decisive_output: {
          summary: outcomeSummary(request, outcome, results),
          ...(safeBody.text ? { excerpt: boundedText(safeBody.text, inlineLimit) } : {}),
          facts: {
            artifact_redaction_count: artifactRedactionCount,
            artifact_written: Boolean(options.artifact_store),
            assertion_count: assertions.length,
            assertion_results_inline: assertionResultsInline,
            assertion_results_json: assertionResultsInline
              ? fullAssertionResultsJson
              : JSON.stringify(results.map(({ id, kind, passed }) => ({ id, kind, passed }))),
            failed_assertion_count: results.length - passedAssertions,
            final_url: response ? redactEvidenceText(response.final_url) : null,
            max_response_bytes: request.max_response_bytes,
            method: request.method,
            outcome: outcome.failure?.code ?? (status === "passed" ? "passed" : "assertion_failed"),
            passed_assertion_count: passedAssertions,
            redirect_count: response?.redirect_count ?? 0,
            request_header_names_json: JSON.stringify(Object.keys(request.headers).map((name) => name.toLowerCase()).sort()),
            request_url: redactEvidenceText(request.url),
            response_body_bytes: response?.body.byteLength ?? 0,
            response_body_sha256: response
              ? createHash("sha256").update(response.body).digest("hex")
              : null,
            response_header_names_json: JSON.stringify(Object.keys(response?.headers ?? {}).sort()),
            response_status: response?.status ?? null,
            response_truncated: response?.truncated ?? false,
            retry_attempt_count: outcome.attempts,
            timeout_ms: request.timeout_ms,
            transport_duration_ms: outcome.duration_ms
          }
        },
        artifact_refs: uniqueArtifactRefs(artifactRefs),
        provenance: {
          assertion_origin: "system_observation",
          source_kind: "http_exchange",
          source_ref: input.context.source_ref,
          audit_event_ref: input.context.audit_event_ref,
          producer: input.context.producer
        },
        redaction: {
          status: "not_required",
          policy_ref: "evidence-redaction:v1",
          redacted_paths: []
        }
      };
      const redacted = redactEvidenceRecord(evidence, "evidence-redaction:v1");
      const validation = validateEvidence(redacted);
      if (!validation.ok) throw new Error(`HTTP verifier produced invalid Evidence: ${validation.errors.join("; ")}`);
      return redacted;
    }
  };
}

export class FileSystemHttpEvidenceArtifactStore implements HttpEvidenceArtifactStore {
  constructor(private readonly stateDir: string) {
    if (stateDir.trim() === "") throw new Error("HTTP Evidence artifact state directory is required");
  }

  writeHttpExchange(input: HttpExchangeArtifactWrite): EvidenceArtifactRef {
    const bytes = Buffer.from(input.content);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== input.bytes || sha256 !== input.sha256) {
      throw new Error("HTTP exchange artifact content does not match its declared digest");
    }
    const ref = `${HTTP_ARTIFACT_ROOT}/${sha256.slice(0, 2)}/${sha256}.json`;
    const path = this.artifactPath(ref);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    return {
      kind: "report",
      ref,
      label: "HTTP Evidence bounded exchange report",
      media_type: "application/json",
      sha256
    };
  }

  private artifactPath(ref: string): string {
    if (!new RegExp(`^${HTTP_ARTIFACT_ROOT}/[a-f0-9]{2}/[a-f0-9]{64}\\.json$`).test(ref)) {
      throw new Error("invalid HTTP Evidence artifact ref");
    }
    const root = resolve(this.stateDir, HTTP_ARTIFACT_ROOT);
    const path = resolve(this.stateDir, ref);
    if (path !== root && !path.startsWith(`${root}${sep}`)) {
      throw new Error("HTTP Evidence artifact ref escapes state directory");
    }
    return path;
  }
}

async function executeWithRetry(
  fetcher: typeof fetch,
  sleep: (milliseconds: number) => Promise<void>,
  request: NormalizedRequest
): Promise<VerificationOutcome> {
  const started = performance.now();
  let latestFailure: TransportFailure | undefined;
  for (let attempt = 1; attempt <= request.retry.max_attempts; attempt += 1) {
    const result = await executeAttempt(fetcher, request, attempt < request.retry.max_attempts);
    if ("response" in result) {
      if (result.retry && attempt < request.retry.max_attempts) {
        if (request.retry.backoff_ms > 0) await sleep(request.retry.backoff_ms);
        continue;
      }
      return {
        attempts: attempt,
        duration_ms: elapsedMilliseconds(started),
        response: result.response
      };
    }
    latestFailure = result.failure;
    const retry = attempt < request.retry.max_attempts && (
      (latestFailure.code === "timeout" && request.retry.retry_on_timeout) ||
      (latestFailure.code === "network_error" && request.retry.retry_on_network_error)
    );
    if (!retry) {
      return { attempts: attempt, duration_ms: elapsedMilliseconds(started), failure: latestFailure };
    }
    if (request.retry.backoff_ms > 0) await sleep(request.retry.backoff_ms);
  }
  return {
    attempts: request.retry.max_attempts,
    duration_ms: elapsedMilliseconds(started),
    failure: latestFailure ?? { code: "network_error", message: "HTTP request failed without an observable response" }
  };
}

async function executeAttempt(
  fetcher: typeof fetch,
  request: NormalizedRequest,
  mayRetry: boolean
): Promise<{ response: ResponseObservation; retry: boolean } | { failure: TransportFailure }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeout_ms);
  let currentUrl = request.url;
  let redirects = 0;
  try {
    for (;;) {
      const response = await fetcher(currentUrl, {
        headers: request.headers,
        method: request.method,
        redirect: "manual",
        signal: controller.signal
      });
      if (isRedirectStatus(response.status) && response.headers.has("location")) {
        if (redirects >= request.max_redirects) {
          await response.body?.cancel();
          return {
            failure: {
              code: "redirect_limit",
              message: `HTTP redirect limit exceeded after ${redirects} redirects`
            }
          };
        }
        currentUrl = normalizedRedirectUrl(currentUrl, response.headers.get("location") ?? "");
        redirects += 1;
        await response.body?.cancel();
        continue;
      }
      const retry = mayRetry && request.retry.retry_on_statuses.includes(response.status);
      if (retry) {
        await response.body?.cancel();
        return {
          retry: true,
          response: {
            body: new Uint8Array(),
            final_url: currentUrl,
            headers: responseHeaders(response.headers),
            redirect_count: redirects,
            status: response.status,
            truncated: false
          }
        };
      }
      const body = await readBoundedBody(response, request.method, request.max_response_bytes);
      return {
        retry: false,
        response: {
          body: body.bytes,
          final_url: currentUrl,
          headers: responseHeaders(response.headers),
          redirect_count: redirects,
          status: response.status,
          truncated: body.truncated
        }
      };
    }
  } catch (error) {
    if (isAbortError(error)) {
      return {
        failure: {
          code: "timeout",
          message: `HTTP request timed out after ${request.timeout_ms} ms`
        }
      };
    }
    if (isHttpPermissionError(error)) {
      return { failure: { code: "permission_denied", message: error.message } };
    }
    return {
      failure: {
        code: "network_error",
        message: `HTTP request failed before a response was available: ${safeErrorMessage(error)}`
      }
    };
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedBody(
  response: Response,
  method: "GET" | "HEAD",
  limit: number
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (method === "HEAD" || !response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return { bytes: concatBytes(chunks, total), truncated: false };
    const remaining = limit - total;
    if (chunk.value.byteLength > remaining) {
      if (remaining > 0) chunks.push(chunk.value.slice(0, remaining));
      await reader.cancel();
      return { bytes: concatBytes(chunks, limit), truncated: true };
    }
    chunks.push(chunk.value);
    total += chunk.value.byteLength;
  }
}

function evaluateAssertions(
  assertions: readonly HttpEvidenceAssertion[],
  response: ResponseObservation
): AssertionResult[] {
  let parsedJson: { error?: string; value?: unknown } | undefined;
  const json = () => {
    if (!parsedJson) {
      if (response.truncated) parsedJson = { error: "response body was truncated before JSON assertions could run" };
      else {
        try {
          parsedJson = { value: JSON.parse(decodeBody(response.body)) };
        } catch {
          parsedJson = { error: "response body is not valid JSON" };
        }
      }
    }
    return parsedJson;
  };

  return assertions.map((assertion, index) => {
    const id = cleanLabel(assertion.label) || `${assertion.kind}[${index}]`;
    if (assertion.kind === "health") {
      const statuses = assertion.accepted_statuses ?? [];
      const passed = statuses.length > 0
        ? statuses.includes(response.status)
        : response.status >= 200 && response.status < 300;
      return {
        id,
        kind: assertion.kind,
        passed,
        message: passed
          ? `health endpoint returned accepted status ${response.status}`
          : statuses.length > 0
            ? `health endpoint expected status in [${statuses.join(", ")}], received ${response.status}`
            : `health endpoint expected HTTP 2xx, received ${response.status}`
      };
    }
    if (assertion.kind === "status_code") {
      const expected = Array.isArray(assertion.expected) ? assertion.expected : [assertion.expected];
      const passed = expected.includes(response.status);
      return {
        id,
        kind: assertion.kind,
        passed,
        message: passed
          ? `status code ${response.status} matched`
          : `status code expected [${expected.join(", ")}], received ${response.status}`
      };
    }
    if (assertion.kind === "header") {
      const value = response.headers[assertion.name.toLowerCase()];
      const exists = value !== undefined;
      const passed = assertion.operator === "exists"
        ? exists
        : assertion.operator === "equals"
          ? exists && value === assertion.expected
          : exists && value.includes(assertion.expected ?? "");
      const action = assertion.operator === "exists" ? "be present" : `${assertion.operator} the configured value`;
      return {
        id,
        kind: assertion.kind,
        passed,
        message: passed
          ? `header ${assertion.name.toLowerCase()} satisfied ${assertion.operator}`
          : `header ${assertion.name.toLowerCase()} expected to ${action}; ${exists ? "value did not match" : "header was missing"}`
      };
    }
    if (assertion.kind === "json_schema") {
      const body = json();
      if (body.error) return { id, kind: assertion.kind, message: body.error, passed: false };
      const errors = validateJsonSchema(assertion.schema, body.value);
      return {
        id,
        kind: assertion.kind,
        passed: errors.length === 0,
        message: errors.length === 0 ? "JSON schema matched" : `JSON schema mismatch: ${errors[0]}`
      };
    }
    const body = json();
    if (body.error) return { id, kind: assertion.kind, message: body.error, passed: false };
    const resolved = resolveJsonPath(body.value, assertion.path);
    const passed = businessAssertionPassed(assertion, resolved);
    return {
      id,
      kind: assertion.kind,
      passed,
      message: passed
        ? `business assertion ${assertion.path} satisfied ${assertion.operator}`
        : `business assertion ${assertion.path} expected ${assertion.operator}; ${resolved.found ? "resolved value did not match" : "path was missing"}`
    };
  });
}

function businessAssertionPassed(
  assertion: Extract<HttpEvidenceAssertion, { kind: "business" }>,
  resolved: { found: boolean; value?: unknown }
): boolean {
  if (assertion.operator === "exists") return resolved.found;
  if (!resolved.found) return false;
  if (assertion.operator === "truthy") return Boolean(resolved.value);
  if (assertion.operator === "equals") return deepEqual(resolved.value, assertion.expected);
  if (assertion.operator === "not_equals") return !deepEqual(resolved.value, assertion.expected);
  if (assertion.operator === "contains") {
    if (typeof resolved.value === "string" && typeof assertion.expected === "string") {
      return resolved.value.includes(assertion.expected);
    }
    return Array.isArray(resolved.value) && resolved.value.some((item) => deepEqual(item, assertion.expected));
  }
  if (typeof resolved.value !== "number" || typeof assertion.expected !== "number") return false;
  return assertion.operator === "greater_or_equal"
    ? resolved.value >= assertion.expected
    : resolved.value <= assertion.expected;
}

function validateJsonSchema(
  schema: Readonly<Record<string, unknown>> | boolean,
  value: unknown,
  path = "$",
  root: Readonly<Record<string, unknown>> | boolean = schema,
  depth = 0
): string[] {
  if (depth > 64) return [`${path}: schema nesting exceeds 64 levels`];
  if (schema === true) return [];
  if (schema === false) return [`${path}: false schema rejects the value`];
  if (!isRecord(schema)) return [`${path}: schema must be an object or boolean`];
  if (typeof schema.$ref === "string") {
    const target = localSchemaReference(root, schema.$ref);
    return target === undefined
      ? [`${path}: unsupported or unresolved schema reference ${schema.$ref}`]
      : validateJsonSchema(target, value, path, root, depth + 1);
  }
  const errors: string[] = [];
  const types = typeof schema.type === "string"
    ? [schema.type]
    : Array.isArray(schema.type) ? schema.type.filter((item): item is string => typeof item === "string") : [];
  if (types.length > 0 && !types.some((type) => jsonTypeMatches(type, value))) {
    return [`${path}: expected type ${types.join("|")}`];
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => deepEqual(item, value))) {
    errors.push(`${path}: value is not in enum`);
  }
  if ("const" in schema && !deepEqual(schema.const, value)) errors.push(`${path}: value does not match const`);
  errors.push(...schemaCompositions(schema, value, path, root, depth));

  if (typeof value === "string") {
    if (isNonNegativeInteger(schema.minLength) && value.length < schema.minLength) errors.push(`${path}: string is shorter than minLength`);
    if (isNonNegativeInteger(schema.maxLength) && value.length > schema.maxLength) errors.push(`${path}: string is longer than maxLength`);
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: string does not match pattern`);
      } catch {
        errors.push(`${path}: schema pattern is invalid`);
      }
    }
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${path}: number is below minimum`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${path}: number is above maximum`);
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) errors.push(`${path}: number is not above exclusiveMinimum`);
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) errors.push(`${path}: number is not below exclusiveMaximum`);
  }
  if (Array.isArray(value)) {
    if (isNonNegativeInteger(schema.minItems) && value.length < schema.minItems) errors.push(`${path}: array has fewer than minItems`);
    if (isNonNegativeInteger(schema.maxItems) && value.length > schema.maxItems) errors.push(`${path}: array has more than maxItems`);
    if (schema.uniqueItems === true && value.some((item, index) => value.slice(0, index).some((other) => deepEqual(item, other)))) {
      errors.push(`${path}: array items are not unique`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        errors.push(...validateJsonSchema(schema.items as Readonly<Record<string, unknown>> | boolean, item, `${path}[${index}]`, root, depth + 1));
      });
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === "string")
      : [];
    for (const key of required) if (!Object.hasOwn(value, key)) errors.push(`${path}.${key}: required property is missing`);
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) {
        errors.push(...validateJsonSchema(child as Readonly<Record<string, unknown>> | boolean, value[key], `${path}.${key}`, root, depth + 1));
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) if (!Object.hasOwn(properties, key)) errors.push(`${path}.${key}: additional property is not allowed`);
    } else if (isRecord(schema.additionalProperties) || typeof schema.additionalProperties === "boolean") {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          errors.push(...validateJsonSchema(schema.additionalProperties as Readonly<Record<string, unknown>> | boolean, value[key], `${path}.${key}`, root, depth + 1));
        }
      }
    }
  }
  return errors.slice(0, 32);
}

function schemaCompositions(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
  path: string,
  root: Readonly<Record<string, unknown>> | boolean,
  depth: number
): string[] {
  const errors: string[] = [];
  if (Array.isArray(schema.allOf)) {
    schema.allOf.forEach((item, index) => errors.push(...validateJsonSchema(
      item as Readonly<Record<string, unknown>> | boolean,
      value,
      `${path}.allOf[${index}]`,
      root,
      depth + 1
    )));
  }
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some((item) => validateJsonSchema(
    item as Readonly<Record<string, unknown>> | boolean,
    value,
    path,
    root,
    depth + 1
  ).length === 0)) errors.push(`${path}: no anyOf schema matched`);
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((item) => validateJsonSchema(
      item as Readonly<Record<string, unknown>> | boolean,
      value,
      path,
      root,
      depth + 1
    ).length === 0).length;
    if (matches !== 1) errors.push(`${path}: expected exactly one oneOf match, received ${matches}`);
  }
  if ((isRecord(schema.not) || typeof schema.not === "boolean") && validateJsonSchema(
    schema.not as Readonly<Record<string, unknown>> | boolean,
    value,
    path,
    root,
    depth + 1
  ).length === 0) errors.push(`${path}: not schema matched`);
  return errors;
}

function validateInvocation(invocation: ToolInvocation): HttpEvidenceInvocationInput {
  const issues = validateToolInvocation(invocation);
  if (issues.length > 0) {
    throw new Error(`invalid HTTP Evidence tool invocation: ${issues.map((item) => `${item.path} ${item.message}`).join("; ")}`);
  }
  if (invocation.provider_id !== HTTP_READONLY_PROVIDER_ID || invocation.tool_name !== HTTP_EVIDENCE_TOOL_NAME) {
    throw new Error(`HTTP Evidence verifier only accepts ${HTTP_READONLY_PROVIDER_ID}:${HTTP_EVIDENCE_TOOL_NAME}`);
  }
  if (invocation.permission !== "read") throw new Error("HTTP Evidence verifier requires the read tool permission envelope");
  const request = recordValue(invocation.input.request);
  const assertions = invocation.input.assertions;
  if (!Array.isArray(assertions)) throw new Error("HTTP Evidence invocation assertions must be an array");
  return { assertions: assertions as HttpEvidenceAssertion[], request: request as HttpEvidenceRequestSpec };
}

function normalizeRequest(spec: HttpEvidenceRequestSpec, envelopeTimeout: number | undefined): NormalizedRequest {
  const url = normalizedHttpUrl(spec.url);
  const method = (spec.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    throw new Error("HTTP Evidence verifier only permits GET and HEAD in the read permission envelope");
  }
  const timeout = boundedInteger(spec.timeout_ms ?? envelopeTimeout, DEFAULT_TIMEOUT_MS, 1, MAX_TIMEOUT_MS, "HTTP timeout_ms");
  if (spec.timeout_ms !== undefined && envelopeTimeout !== undefined && spec.timeout_ms !== envelopeTimeout) {
    throw new Error("HTTP request timeout_ms must match the tool invocation timeout_ms");
  }
  const headers = normalizedRequestHeaders(spec.headers ?? {});
  const retry = spec.retry ?? {};
  const retryStatuses = retry.retry_on_statuses ?? DEFAULT_RETRY_STATUSES;
  if (!Array.isArray(retryStatuses) || retryStatuses.length > MAX_STATUS_CODES || retryStatuses.some((status) => !validStatusCode(status))) {
    throw new Error("HTTP retry_on_statuses must contain valid HTTP status codes");
  }
  return {
    headers,
    max_redirects: boundedInteger(spec.max_redirects, DEFAULT_MAX_REDIRECTS, 0, MAX_REDIRECTS, "HTTP max_redirects"),
    max_response_bytes: boundedInteger(
      spec.max_response_bytes,
      DEFAULT_MAX_RESPONSE_BYTES,
      1,
      MAX_RESPONSE_BYTES,
      "HTTP max_response_bytes"
    ),
    method,
    retry: {
      backoff_ms: boundedInteger(retry.backoff_ms, 0, 0, MAX_RETRY_BACKOFF_MS, "HTTP retry backoff_ms"),
      max_attempts: boundedInteger(retry.max_attempts, 1, 1, MAX_RETRY_ATTEMPTS, "HTTP retry max_attempts"),
      retry_on_network_error: retry.retry_on_network_error !== false,
      retry_on_statuses: [...new Set(retryStatuses)].sort((left, right) => left - right),
      retry_on_timeout: retry.retry_on_timeout !== false
    },
    timeout_ms: timeout,
    url
  };
}

function validateAssertions(assertions: readonly HttpEvidenceAssertion[]): readonly HttpEvidenceAssertion[] {
  if (assertions.length === 0 || assertions.length > MAX_ASSERTIONS) {
    throw new Error(`HTTP Evidence requires between 1 and ${MAX_ASSERTIONS} assertions`);
  }
  assertions.forEach((assertion, index) => {
    if (!isRecord(assertion)) throw new Error(`HTTP assertion ${index} must be an object`);
    if (cleanLabel(assertion.label) !== (assertion.label ?? "")) throw new Error(`HTTP assertion ${index} label is invalid`);
    if (assertion.kind === "health") {
      if (assertion.accepted_statuses !== undefined && (
        !Array.isArray(assertion.accepted_statuses) || assertion.accepted_statuses.length === 0 ||
        assertion.accepted_statuses.length > MAX_STATUS_CODES ||
        assertion.accepted_statuses.some((status) => !validStatusCode(status))
      )) throw new Error(`HTTP health assertion ${index} has invalid accepted_statuses`);
      return;
    }
    if (assertion.kind === "status_code") {
      const expected = Array.isArray(assertion.expected) ? assertion.expected : [assertion.expected];
      if (expected.length === 0 || expected.length > MAX_STATUS_CODES || expected.some((status) => !validStatusCode(status))) {
        throw new Error(`HTTP status assertion ${index} has invalid expected codes`);
      }
      return;
    }
    if (assertion.kind === "header") {
      if (!HEADER_NAME_PATTERN.test(assertion.name) || assertion.name.length > 128) {
        throw new Error(`HTTP header assertion ${index} has an invalid header name`);
      }
      if (!["contains", "equals", "exists"].includes(assertion.operator)) {
        throw new Error(`HTTP header assertion ${index} has an invalid operator`);
      }
      if (assertion.operator !== "exists" && (typeof assertion.expected !== "string" || assertion.expected === "")) {
        throw new Error(`HTTP header assertion ${index} requires a non-empty expected value`);
      }
      return;
    }
    if (assertion.kind === "json_schema") {
      if (!(typeof assertion.schema === "boolean" || isRecord(assertion.schema))) {
        throw new Error(`HTTP JSON schema assertion ${index} requires an object or boolean schema`);
      }
      if (Buffer.byteLength(JSON.stringify(assertion.schema)) > MAX_JSON_SCHEMA_BYTES) {
        throw new Error(`HTTP JSON schema assertion ${index} exceeds ${MAX_JSON_SCHEMA_BYTES} bytes`);
      }
      return;
    }
    if (assertion.kind === "business") {
      parseJsonPath(assertion.path);
      if (!["contains", "equals", "exists", "greater_or_equal", "less_or_equal", "not_equals", "truthy"].includes(assertion.operator)) {
        throw new Error(`HTTP business assertion ${index} has an invalid operator`);
      }
      if (!["exists", "truthy"].includes(assertion.operator) && !("expected" in assertion)) {
        throw new Error(`HTTP business assertion ${index} requires expected`);
      }
      if (["greater_or_equal", "less_or_equal"].includes(assertion.operator) && typeof assertion.expected !== "number") {
        throw new Error(`HTTP business assertion ${index} requires a numeric expected value`);
      }
      return;
    }
    throw new Error(`HTTP assertion ${index} has an unsupported kind`);
  });
  return assertions;
}

function exchangeReport(
  request: NormalizedRequest,
  outcome: VerificationOutcome,
  results: readonly AssertionResult[],
  body: SanitizedText
): { content: string; redacted_paths: string[] } {
  const requestHeaders = sanitizedHeaders(request.headers, "/request/headers");
  const responseHeaders = sanitizedHeaders(outcome.response?.headers ?? {}, "/response/headers");
  const redactedPaths = [...requestHeaders.redacted_paths, ...responseHeaders.redacted_paths];
  if (body.redacted_paths.length > 0) redactedPaths.push(...body.redacted_paths.map((path) => `/response/body${path}`));
  const safeFailure = outcome.failure ? redactEvidenceText(outcome.failure.message) : null;
  if (outcome.failure && safeFailure !== outcome.failure.message) redactedPaths.push("/transport_failure/message");
  const safeRequestUrl = redactEvidenceText(request.url);
  if (safeRequestUrl !== request.url) redactedPaths.push("/request/url");
  const safeFinalUrl = outcome.response ? redactEvidenceText(outcome.response.final_url) : null;
  if (outcome.response && safeFinalUrl !== outcome.response.final_url) redactedPaths.push("/response/final_url");
  const safeResults = results.map((result, index) => {
    const id = redactEvidenceText(result.id);
    const message = redactEvidenceText(result.message);
    if (id !== result.id) redactedPaths.push(`/assertions/${index}/id`);
    if (message !== result.message) redactedPaths.push(`/assertions/${index}/message`);
    return { ...result, id, message };
  });
  const report = {
    schema_version: 1,
    request: {
      headers: requestHeaders.headers,
      max_redirects: request.max_redirects,
      max_response_bytes: request.max_response_bytes,
      method: request.method,
      timeout_ms: request.timeout_ms,
      url: safeRequestUrl
    },
    response: outcome.response ? {
      body: body.text,
      body_bytes: outcome.response.body.byteLength,
      body_sha256: createHash("sha256").update(outcome.response.body).digest("hex"),
      final_url: safeFinalUrl,
      headers: responseHeaders.headers,
      redirect_count: outcome.response.redirect_count,
      status: outcome.response.status,
      truncated: outcome.response.truncated
    } : null,
    assertions: safeResults,
    transport_failure: outcome.failure ? { code: outcome.failure.code, message: safeFailure } : null,
    attempt_count: outcome.attempts,
    duration_ms: outcome.duration_ms,
    redaction: {
      policy_ref: "evidence-http-redaction:v1",
      redacted_paths: [...new Set(redactedPaths)].sort()
    }
  };
  return { content: `${JSON.stringify(report)}\n`, redacted_paths: report.redaction.redacted_paths };
}

function outcomeSummary(
  request: NormalizedRequest,
  outcome: VerificationOutcome,
  results: readonly AssertionResult[]
): string {
  if (outcome.failure) {
    return redactEvidenceText(`HTTP verification failed after ${outcome.attempts} attempt(s): ${outcome.failure.message}`);
  }
  const response = outcome.response!;
  const failed = results.find((item) => !item.passed);
  if (failed) {
    return redactEvidenceText(
      `HTTP verification failed: ${failed.id}: ${failed.message}; ${request.method} returned ${response.status} after ${outcome.attempts} attempt(s)`
    );
  }
  return `HTTP verification passed: ${request.method} returned ${response.status}; ${results.length}/${results.length} assertions passed after ${outcome.attempts} attempt(s)`;
}

function sanitizeResponseBody(value: string): SanitizedText {
  if (value === "") return { redacted_paths: [], text: "" };
  try {
    const parsed = JSON.parse(value);
    const redactedPaths: string[] = [];
    const safe = sanitizeJsonValue(parsed, "", redactedPaths);
    return { redacted_paths: redactedPaths, text: JSON.stringify(safe) };
  } catch {
    const text = redactEvidenceText(value);
    return { redacted_paths: text === value ? [] : [""], text };
  }
}

function sanitizeJsonValue(value: unknown, path: string, redactedPaths: string[]): unknown {
  if (typeof value === "string") {
    const safe = redactEvidenceText(value);
    if (safe !== value) redactedPaths.push(path || "/");
    return safe;
  }
  if (Array.isArray(value)) return value.map((item, index) => sanitizeJsonValue(item, `${path}/${index}`, redactedPaths));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    const childPath = `${path}/${escapePointer(key)}`;
    if (isSensitiveName(key)) {
      redactedPaths.push(childPath);
      return [key, "[redacted]"];
    }
    return [key, sanitizeJsonValue(child, childPath, redactedPaths)];
  }));
}

function sanitizedHeaders(
  headers: Readonly<Record<string, string>>,
  path: string
): { headers: Record<string, string>; redacted_paths: string[] } {
  const redactedPaths: string[] = [];
  const output: Record<string, string> = {};
  for (const [name, rawValue] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (isSensitiveName(key)) {
      output[key] = "[redacted]";
      redactedPaths.push(`${path}/${escapePointer(key)}`);
      continue;
    }
    const value = redactEvidenceText(rawValue);
    output[key] = boundedText(value, 1024);
    if (value !== rawValue) redactedPaths.push(`${path}/${escapePointer(key)}`);
  }
  return { headers: output, redacted_paths: redactedPaths };
}

function normalizedRequestHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const entries = Object.entries(headers);
  if (entries.length > MAX_HEADERS) throw new Error(`HTTP request headers exceed the ${MAX_HEADERS} header limit`);
  const output: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (!HEADER_NAME_PATTERN.test(name) || name.length > 128) throw new Error(`invalid HTTP request header name: ${name}`);
    if (typeof value !== "string" || /[\r\n]/.test(value) || Buffer.byteLength(value) > MAX_HEADER_VALUE_BYTES) {
      throw new Error(`invalid or oversized HTTP request header value: ${name}`);
    }
    output[name.toLowerCase()] = value;
  }
  return output;
}

function responseHeaders(headers: Headers): Record<string, string> {
  const output: Record<string, string> = {};
  let count = 0;
  for (const [name, value] of headers.entries()) {
    if (count >= MAX_HEADERS) break;
    output[name.toLowerCase()] = boundedText(value, MAX_HEADER_VALUE_BYTES);
    count += 1;
  }
  return output;
}

function resolveJsonPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  const segments = parseJsonPath(path);
  let current = root;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current) || segment >= current.length) return { found: false };
      current = current[segment];
    } else {
      if (!isRecord(current) || !Object.hasOwn(current, segment)) return { found: false };
      current = current[segment];
    }
  }
  return { found: true, value: current };
}

function parseJsonPath(path: string): Array<string | number> {
  if (typeof path !== "string" || path.length > 512) throw new Error("HTTP business assertion path must be a string of at most 512 characters");
  if (path === "$") return [];
  if (!path.startsWith("$")) throw new Error("HTTP business assertion path must start with $");
  const segments: Array<string | number> = [];
  let offset = 1;
  while (offset < path.length) {
    if (path[offset] === ".") {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(offset + 1));
      if (!match) throw new Error(`unsupported HTTP business assertion path: ${path}`);
      segments.push(match[0]);
      offset += match[0].length + 1;
      continue;
    }
    if (path[offset] === "[") {
      const match = /^\[([0-9]+)\]/.exec(path.slice(offset));
      if (!match) throw new Error(`unsupported HTTP business assertion path: ${path}`);
      segments.push(Number(match[1]));
      offset += match[0].length;
      continue;
    }
    throw new Error(`unsupported HTTP business assertion path: ${path}`);
  }
  return segments;
}

function localSchemaReference(
  root: Readonly<Record<string, unknown>> | boolean,
  reference: string
): Readonly<Record<string, unknown>> | boolean | undefined {
  if (!reference.startsWith("#/") || !isRecord(root)) return undefined;
  let current: unknown = root;
  for (const raw of reference.slice(2).split("/")) {
    const key = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return typeof current === "boolean" || isRecord(current) ? current : undefined;
}

function jsonTypeMatches(type: string, value: unknown): boolean {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function normalizedHttpUrl(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) throw new Error("HTTP Evidence request URL is required and must be bounded");
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported scheme");
    if (url.username !== "" || url.password !== "") throw new Error("URL userinfo is denied");
    return url.toString();
  } catch {
    throw new Error("HTTP Evidence request requires a valid http or https URL without userinfo");
  }
}

function normalizedRedirectUrl(current: string, location: string): string {
  const currentUrl = new URL(current);
  const next = new URL(location, current);
  if (next.protocol !== "http:" && next.protocol !== "https:") throw httpPermissionError("HTTP redirect uses a denied URL scheme");
  if (next.username !== "" || next.password !== "") throw httpPermissionError("HTTP redirect URL userinfo is denied");
  if (next.origin !== currentUrl.origin) throw httpPermissionError("cross-origin HTTP redirect is denied by the read permission envelope");
  return next.toString();
}

function boundedInteger(value: unknown, fallback: number, minimum: number, maximum: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function normalizedTimestamp(value: string, label: string): string {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`${label} must be an ISO timestamp`);
  return value;
}

function validStatusCode(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 100 && Number(value) <= 599;
}

function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function httpPermissionError(message: string): Error {
  const error = new Error(message);
  error.name = "HttpPermissionError";
  return error;
}

function isHttpPermissionError(error: unknown): error is Error {
  return error instanceof Error && error.name === "HttpPermissionError";
}

function safeErrorMessage(error: unknown): string {
  return redactEvidenceText(error instanceof Error ? error.message : "unknown network error");
}

function elapsedMilliseconds(started: number): number {
  return Math.max(0, Math.round(performance.now() - started));
}

function decodeBody(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function boundedText(value: string, limit: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= limit) return value;
  const marker = "\n...[truncated]";
  return new TextDecoder().decode(bytes.subarray(0, Math.max(0, limit - Buffer.byteLength(marker)))) + marker;
}

function uniqueArtifactRefs(values: readonly EvidenceArtifactRef[]): EvidenceArtifactRef[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    if (seen.has(value.ref)) return false;
    seen.add(value.ref);
    return true;
  }).map((value) => ({ ...value }));
}

function cleanLabel(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") return "";
  const text = value.trim();
  return text.length <= 128 ? text : "";
}

function isSensitiveName(value: string): boolean {
  return SENSITIVE_NAME_PATTERN.test(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((item, index) => deepEqual(item, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
      key === rightKeys[index] && deepEqual(left[key], right[key]));
  }
  return false;
}

function escapePointer(value: string): string {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
