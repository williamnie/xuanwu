import { redactedUserVisibleText } from "../util/redact.ts";

export const VERIFICATION_EVIDENCE_VERSION = 0;
export const VERIFICATION_EVIDENCE_KINDS = ["shell_test", "http_smoke", "human_verification", "independent_checker"] as const;
export const VERIFICATION_EVIDENCE_STATUSES = ["passed", "failed", "pending", "blocked"] as const;

export type VerificationEvidenceKind = typeof VERIFICATION_EVIDENCE_KINDS[number];
export type VerificationEvidenceStatus = typeof VERIFICATION_EVIDENCE_STATUSES[number];
export type VerificationEvidenceV0 = {
  version: typeof VERIFICATION_EVIDENCE_VERSION;
  kind: VerificationEvidenceKind;
  status: VerificationEvidenceStatus;
  summary: string;
  command?: string;
  url?: string;
  checker?: string;
  artifact_refs: string[];
  blocking_issues?: string[];
  created_at: string;
};
export type VerificationEvidenceInput = Partial<{
  kind: unknown;
  status: unknown;
  summary: unknown;
  command: unknown;
  url: unknown;
  checker: unknown;
  artifact_refs: unknown;
  blocking_issues: unknown;
  created_at: unknown;
  version: unknown;
}>;
export type VerificationEvidenceValidationResult = { ok: boolean; errors: string[] };
export type VerificationEvidenceOptions = { now?: Date | string };

const DEFAULT_KIND: VerificationEvidenceKind = "shell_test";
const DEFAULT_STATUS: VerificationEvidenceStatus = "pending";
const EVIDENCE_SECRET_PHRASE_PATTERN =
  /\b(token|secret|password|api[_-]?key|access[_-]?key)\b\s+(?:is\s+|was\s+)?[^\s,;]+/gi;

export function normalizeVerificationEvidence(
  input: VerificationEvidenceInput,
  options: VerificationEvidenceOptions = {}
): VerificationEvidenceV0 {
  return withOptionalFields({
    version: VERIFICATION_EVIDENCE_VERSION,
    kind: normalizeKind(input.kind),
    status: normalizeStatus(input.status),
    summary: cleanText(input.summary),
    artifact_refs: cleanStringList(input.artifact_refs),
    created_at: normalizeTimestamp(input.created_at, options.now)
  }, {
    blocking_issues: cleanStringList(input.blocking_issues),
    checker: cleanText(input.checker),
    command: cleanText(input.command),
    url: cleanText(input.url)
  });
}

export function redactVerificationEvidence(
  input: VerificationEvidenceInput,
  options: VerificationEvidenceOptions = {}
): VerificationEvidenceV0 {
  return normalizeVerificationEvidence(input, options);
}

export function serializeVerificationEvidence(
  input: VerificationEvidenceInput,
  options: VerificationEvidenceOptions = {}
): string {
  return JSON.stringify(normalizeVerificationEvidence(input, options));
}

export function validateVerificationEvidence(input: unknown): VerificationEvidenceValidationResult {
  const errors: string[] = [];
  if (!isRecord(input)) return { ok: false, errors: ["evidence must be an object"] };
  if (!isKind(input.kind)) errors.push(`kind must be one of ${VERIFICATION_EVIDENCE_KINDS.join(", ")}`);
  if (!isStatus(input.status)) errors.push(`status must be one of ${VERIFICATION_EVIDENCE_STATUSES.join(", ")}`);
  if (cleanText(input.summary) === "") errors.push("summary is required");
  if (!isStringArray(input.artifact_refs)) errors.push("artifact_refs must be an array of strings");
  if (!isOptionalStringArray(input.blocking_issues)) errors.push("blocking_issues must be an array of strings");
  if (!isIsoTimestamp(input.created_at)) errors.push("created_at must be an ISO timestamp");
  if (!optionalString(input.command)) errors.push("command must be a string");
  if (!optionalString(input.url)) errors.push("url must be a string");
  if (!optionalString(input.checker)) errors.push("checker must be a string");
  return { ok: errors.length === 0, errors };
}

function withOptionalFields(
  evidence: Omit<VerificationEvidenceV0, "blocking_issues" | "checker" | "command" | "url">,
  optional: Pick<VerificationEvidenceV0, "blocking_issues" | "checker" | "command" | "url">
): VerificationEvidenceV0 {
  const result: VerificationEvidenceV0 = { ...evidence };
  if (optional.command) result.command = optional.command;
  if (optional.url) result.url = optional.url;
  if (optional.checker) result.checker = optional.checker;
  if (optional.blocking_issues?.length) result.blocking_issues = optional.blocking_issues;
  return result;
}

function normalizeKind(value: unknown): VerificationEvidenceKind {
  return isKind(value) ? value : DEFAULT_KIND;
}

function normalizeStatus(value: unknown): VerificationEvidenceStatus {
  return isStatus(value) ? value : DEFAULT_STATUS;
}

function cleanStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(cleanText).filter(Boolean);
}

function cleanText(value: unknown): string {
  if (typeof value !== "string") return "";
  return redactSecretPhrases(redactedUserVisibleText(value));
}

function redactSecretPhrases(value: string): string {
  return value.replace(EVIDENCE_SECRET_PHRASE_PATTERN, (_match, label: string) => `${label} [redacted]`);
}

function normalizeTimestamp(value: unknown, now: Date | string | undefined): string {
  if (isIsoTimestamp(value)) return new Date(value).toISOString();
  return nowDate(now).toISOString();
}

function nowDate(now: Date | string | undefined): Date {
  const date = now instanceof Date ? now : new Date(now ?? Date.now());
  return Number.isFinite(date.getTime()) ? date : new Date();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isKind(value: unknown): value is VerificationEvidenceKind {
  return typeof value === "string" && VERIFICATION_EVIDENCE_KINDS.includes(value as VerificationEvidenceKind);
}

function isStatus(value: unknown): value is VerificationEvidenceStatus {
  return typeof value === "string" && VERIFICATION_EVIDENCE_STATUSES.includes(value as VerificationEvidenceStatus);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isOptionalStringArray(value: unknown): boolean {
  return value === undefined || isStringArray(value);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}
