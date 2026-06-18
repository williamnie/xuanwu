import type { RunnerDatabase } from "../db/database.ts";
import {
  createPiNotificationPreference,
  type PiNotificationPreference
} from "../db/repositories/pi.ts";

export class PiNotificationPreferenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiNotificationPreferenceValidationError";
  }
}

export type PiNotificationPreferenceCandidate = Record<string, unknown>;
export type PiNotificationPreferenceWriteResult = {
  confirmation_text: string;
  preference: PiNotificationPreference;
};

type NormalizedPreferenceCandidate = {
  confirmationText: string; conversationID: string; digestPolicy: unknown;
  effectiveAfterTime: string; expiresAt: string; id: string; mode: string;
  notifyOn: string[]; policyKind: string; projectID: string; runGroupID: string;
  scope: string; sourceEventID: string; sourceEventSequenceID: number;
  sourceMessageID: string;
};

type ExpiryResult = { expiresAt: string; ttlLabel: string };

const DEFAULT_TEMPORARY_TTL_MINUTES = 480;
const MAX_TEMPORARY_TTL_MINUTES = 7 * 24 * 60;
const MODES = new Set(["quiet", "digest", "normal", "verbose"]);
const POLICY_KINDS = new Set(["user_preference", "admin_default", "admin_enforced", "system_default"]);
const SCOPES = new Set(["run_group", "conversation", "project", "global"]);

export function writePiNotificationPreference(
  db: RunnerDatabase,
  candidate: PiNotificationPreferenceCandidate
): PiNotificationPreferenceWriteResult {
  const normalized = normalizeCandidate(candidate);
  const preference = createPiNotificationPreference(db, {
    confirmation_text: normalized.confirmationText,
    conversation_id: normalized.conversationID,
    digest_policy_json: normalized.digestPolicy,
    effective_after_time: normalized.effectiveAfterTime,
    expires_at: normalized.expiresAt,
    id: normalized.id,
    mode: normalized.mode,
    notify_on_json: normalized.notifyOn,
    policy_kind: normalized.policyKind,
    project_id: normalized.projectID,
    run_group_id: normalized.runGroupID,
    scope: normalized.scope,
    source_event_id: normalized.sourceEventID,
    source_event_sequence_id: normalized.sourceEventSequenceID,
    source_message_id: normalized.sourceMessageID
  });
  return { confirmation_text: preference.confirmation_text, preference };
}

function normalizeCandidate(input: PiNotificationPreferenceCandidate): NormalizedPreferenceCandidate {
  const mode = enumValue(input.mode, MODES, "mode");
  const scope = enumValue(input.scope, SCOPES, "scope");
  const expiry = normalizeExpiry(input, mode);
  const base = {
    conversationID: clean(input.conversation_id ?? input.conversationID),
    digestPolicy: digestPolicy(input.digest_policy ?? input.digestPolicy ?? input.digest_policy_json),
    effectiveAfterTime: canonicalTime(input.effective_after_time) || now(input.now),
    expiresAt: expiry.expiresAt,
    id: clean(input.id) || crypto.randomUUID(),
    mode,
    notifyOn: normalizeNotifyOn(input.notify_on ?? input.notifyOn ?? input.notify_on_json, mode),
    policyKind: clean(input.policy_kind) || "user_preference",
    projectID: clean(input.project_id ?? input.projectID),
    runGroupID: clean(input.run_group_id ?? input.runGroupID),
    scope,
    sourceEventID: clean(input.source_event_id ?? input.sourceEventID),
    sourceEventSequenceID: integer(input.source_event_sequence_id ?? input.sourceEventSequenceID),
    sourceMessageID: clean(input.source_message_id ?? input.sourceMessageID)
  };
  validatePolicyKind(base.policyKind);
  validateScopeIDs(base);
  return { ...base, confirmationText: confirmationText(base, expiry) };
}

function normalizeExpiry(input: PiNotificationPreferenceCandidate, mode: string): ExpiryResult {
  const expiresAt = canonicalTime(input.expires_at ?? input.expiresAt);
  const ttl = optionalInteger(input.ttl_minutes ?? input.ttlMinutes);
  const temporary = booleanValue(input.temporary) || clean(input.duration) === "temporary";
  if (expiresAt !== "") return validateExpiry(expiresAt, input.now, "expires_at");
  if (ttl !== undefined) return ttlExpiry(ttl, input.now, false);
  if (temporary && ["quiet", "digest"].includes(mode)) {
    return ttlExpiry(DEFAULT_TEMPORARY_TTL_MINUTES, input.now, true);
  }
  return { expiresAt: "", ttlLabel: "permanent" };
}

function validateExpiry(expiresAt: string, nowValue: unknown, ttlLabel: string): ExpiryResult {
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs)) fail("expires_at must be RFC3339");
  if (expiryMs <= Date.parse(now(nowValue))) fail("expires_at must be in the future");
  return { expiresAt, ttlLabel };
}

function ttlExpiry(minutes: number, nowValue: unknown, defaulted: boolean): ExpiryResult {
  if (!Number.isInteger(minutes) || minutes <= 0) fail("ttl_minutes must be a positive integer");
  if (minutes > MAX_TEMPORARY_TTL_MINUTES) fail("ttl_minutes must be short and <=10080");
  const expiresAt = new Date(Date.parse(now(nowValue)) + minutes * 60_000).toISOString().replace(".000Z", "Z");
  return { expiresAt, ttlLabel: `${ttlLabel(minutes)}${defaulted ? "(default)" : ""}` };
}

function confirmationText(input: Omit<NormalizedPreferenceCandidate, "confirmationText">, expiry: ExpiryResult): string {
  const ids = scopeIDText(input);
  const notifyOn = input.notifyOn.length > 0 ? input.notifyOn.join(",") : "default";
  const expiresAt = input.expiresAt || "none";
  const coverage = "覆盖关系=run_group > conversation > project > global；admin_enforced project policy overrides lower scopes";
  return `已保存通知偏好：scope=${input.scope}${ids}；mode=${input.mode}；notify_on=${notifyOn}；expires_at=${expiresAt}；ttl=${expiry.ttlLabel}；${coverage}。`;
}

function scopeIDText(input: Omit<NormalizedPreferenceCandidate, "confirmationText">): string {
  const ids = [
    ["project", input.projectID],
    ["conversation", input.conversationID],
    ["run_group", input.runGroupID]
  ].filter(([, value]) => value !== "").map(([key, value]) => `${key}=${value}`);
  return ids.length > 0 ? `(${ids.join(",")})` : "";
}

function normalizeNotifyOn(value: unknown, mode: string): string[] {
  const items = stringList(value);
  const normalized = items.length > 0 ? items : defaultNotifyOn(mode);
  const unique = [...new Set(normalized.map((item) => token(item)).filter(Boolean))];
  if (unique.length > 20) fail("notify_on must contain <=20 items");
  return unique;
}

function defaultNotifyOn(mode: string): string[] {
  if (mode === "quiet" || mode === "digest") {
    return ["urgent", "pi_unavailable", "needs_user", "budget_exhausted", "unsafe_or_external"];
  }
  return [];
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  const text = clean(value);
  if (text === "") return [];
  if (text.startsWith("[")) return parseJsonArray(text);
  return text.split(",").map(clean).filter(Boolean);
}

function parseJsonArray(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.map(clean).filter(Boolean) : [];
  } catch {
    fail("notify_on_json must be a JSON string array");
  }
}

function digestPolicy(value: unknown): unknown {
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return {};
    try {
      return digestPolicyObject(JSON.parse(text) as unknown);
    } catch {
      fail("digest_policy must be valid JSON");
    }
  }
  return digestPolicyObject(value ?? {});
}

function digestPolicyObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  fail("digest_policy must be an object");
}

function enumValue(value: unknown, allowed: Set<string>, label: string): string {
  const text = clean(value);
  if (!allowed.has(text)) fail(`${label} must be one of ${[...allowed].join(",")}`);
  return text;
}

function validateScopeIDs(input: Pick<NormalizedPreferenceCandidate, "conversationID" | "projectID" | "runGroupID" | "scope">): void {
  if (input.scope === "run_group" && input.runGroupID === "") fail("run_group_id is required for run_group scope");
  if (input.scope === "conversation" && input.conversationID === "") fail("conversation_id is required for conversation scope");
  if (input.scope === "project" && input.projectID === "") fail("project_id is required for project scope");
}

function validatePolicyKind(value: string): void {
  if (!POLICY_KINDS.has(value)) fail(`policy_kind must be one of ${[...POLICY_KINDS].join(",")}`);
}

function canonicalTime(value: unknown): string {
  const text = clean(value);
  if (text === "") return "";
  if (!rfc3339Time(text)) fail("time value must be RFC3339");
  const ms = Date.parse(text);
  if (!Number.isFinite(ms)) fail("time value must be RFC3339");
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function rfc3339Time(text: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(text);
}

function now(value: unknown): string {
  return canonicalTime(value) || new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function ttlLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function token(value: string): string {
  const text = value.trim().toLowerCase();
  if (!/^[a-z0-9_:-]{1,64}$/.test(text)) fail("notify_on items must be safe tokens");
  return text;
}

function integer(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(clean(value));
  return Number.isInteger(number) ? number : Number.NaN;
}

function booleanValue(value: unknown): boolean {
  return value === true || clean(value).toLowerCase() === "true";
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function fail(message: string): never {
  throw new PiNotificationPreferenceValidationError(message);
}
