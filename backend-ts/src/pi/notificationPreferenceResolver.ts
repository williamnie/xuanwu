import type { RunnerDatabase } from "../db/database.ts";
import {
  listActivePiNotificationPreferences,
  type PiNotificationPreference
} from "../db/repositories/pi.ts";

export type PiNotificationPreferenceResolveContext = {
  conversationID?: string;
  eventSequence?: number;
  projectID?: string;
  referenceTime?: string;
  runGroupID?: string;
};

export type PiNotificationPreferenceSource =
  | "admin_enforced"
  | "conversation"
  | "global"
  | "project"
  | "run_group"
  | "system_default";

export type PiNotificationPreferenceReason =
  | "admin_enforced_override"
  | "matched_conversation"
  | "matched_global"
  | "matched_project"
  | "matched_run_group"
  | "system_default";

export type ResolvedPiNotificationPreference = {
  effective: ResolvedPiNotificationPreferencePolicy;
  preference: PiNotificationPreference | null;
  preferenceID: string;
  reason: PiNotificationPreferenceReason;
  source: PiNotificationPreferenceSource;
};

export type ResolvedPiNotificationPreferencePolicy = {
  digest_policy: Record<string, unknown>;
  mode: string;
  notify_on: string[];
};

type Candidate = {
  preference: PiNotificationPreference;
  reason: PiNotificationPreferenceReason;
  source: PiNotificationPreferenceSource;
};

const SYSTEM_DEFAULT_POLICY: ResolvedPiNotificationPreferencePolicy = {
  digest_policy: {},
  mode: "normal",
  notify_on: []
};

export function resolvePiNotificationPreference(
  db: RunnerDatabase,
  context: PiNotificationPreferenceResolveContext
): ResolvedPiNotificationPreference {
  const candidates = preferenceCandidates(db, context);
  return selectCandidate(candidates) ?? systemDefaultPreference();
}

function selectCandidate(candidates: Candidate[]): ResolvedPiNotificationPreference | null {
  const enforced = candidates.find((candidate) => candidate.preference.policy_kind === "admin_enforced");
  const selected = enforced ? { ...enforced, reason: "admin_enforced_override" as const } : candidates[0];
  if (!selected) return null;
  return {
    effective: policyFromPreference(selected.preference),
    preference: selected.preference,
    preferenceID: selected.preference.id,
    reason: selected.reason,
    source: enforced ? "admin_enforced" : selected.source
  };
}

function preferenceCandidates(
  db: RunnerDatabase,
  context: PiNotificationPreferenceResolveContext
): Candidate[] {
  return [
    scopedPreference(db, context, "run_group", "matched_run_group"),
    scopedPreference(db, context, "conversation", "matched_conversation"),
    scopedPreference(db, context, "project", "matched_project"),
    scopedPreference(db, context, "global", "matched_global")
  ].filter((candidate): candidate is Candidate => candidate !== null);
}

function scopedPreference(
  db: RunnerDatabase,
  context: PiNotificationPreferenceResolveContext,
  source: Exclude<PiNotificationPreferenceSource, "admin_enforced" | "system_default">,
  reason: Exclude<PiNotificationPreferenceReason, "admin_enforced_override" | "system_default">
): Candidate | null {
  if (!hasRequiredScopeID(context, source)) return null;
  const preference = listActivePiNotificationPreferences(db, filterForScope(context, source))[0];
  return preference ? { preference, reason, source } : null;
}

function hasRequiredScopeID(
  context: PiNotificationPreferenceResolveContext,
  scope: "conversation" | "global" | "project" | "run_group"
): boolean {
  if (scope === "global") return true;
  if (scope === "project") return text(context.projectID) !== "";
  if (scope === "conversation") return text(context.conversationID) !== "";
  return text(context.runGroupID) !== "";
}

function filterForScope(
  context: PiNotificationPreferenceResolveContext,
  scope: "conversation" | "global" | "project" | "run_group"
) {
  return {
    eventSequence: comparableSequence(context.eventSequence),
    projectId: scope === "global" ? "" : context.projectID,
    referenceTime: context.referenceTime,
    scope,
    ...(scope === "conversation" ? { conversationId: context.conversationID } : {}),
    ...(scope === "run_group" ? { runGroupId: context.runGroupID } : {})
  };
}

function policyFromPreference(preference: PiNotificationPreference): ResolvedPiNotificationPreferencePolicy {
  return {
    digest_policy: parseJsonObject(preference.digest_policy_json),
    mode: preference.mode || SYSTEM_DEFAULT_POLICY.mode,
    notify_on: parseStringArray(preference.notify_on_json)
  };
}

function systemDefaultPreference(): ResolvedPiNotificationPreference {
  return {
    effective: SYSTEM_DEFAULT_POLICY,
    preference: null,
    preferenceID: "",
    reason: "system_default",
    source: "system_default"
  };
}

function parseJsonObject(value: string): Record<string, unknown> {
  const parsed = parseJson(value, {});
  return isRecord(parsed) ? parsed : {};
}

function parseStringArray(value: string): string[] {
  const parsed = parseJson(value, []);
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function comparableSequence(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
