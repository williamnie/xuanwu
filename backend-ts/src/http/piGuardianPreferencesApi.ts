import type { RunnerDatabase } from "../db/database.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import {
  disablePiNotificationPreference,
  getPiNotificationPreference,
  listPiNotificationPreferences,
  type PiNotificationPreference
} from "../db/repositories/pi.ts";
import {
  PiNotificationPreferenceValidationError,
  writePiNotificationPreference
} from "../pi/notificationPreferenceService.ts";
import { HttpError, json, parseJsonBody } from "./errors.ts";
import type { Router } from "./router.ts";

type PiGuardianPreferenceContext = { database: RunnerDatabase };

export function registerPiGuardianPreferenceRoutes(
  router: Router,
  context: PiGuardianPreferenceContext
): void {
  router.get("/api/pi/guardian/preferences", (request) => json(preferencesResponse(context.database, request)));
  router.post("/api/pi/guardian/preferences", async (request) => json(
    await createPreferenceResponse(context.database, request)
  ));
  router.post("/api/pi/guardian/preferences/:id/disable", (request) => json(
    disablePreferenceResponse(context.database, request)
  ));
}

function preferencesResponse(db: RunnerDatabase, request: Request): Array<Record<string, unknown>> {
  const params = new URL(request.url).searchParams;
  return listPiNotificationPreferences(db, {
    conversationId: clean(params.get("conversation_id") ?? params.get("conversationId")),
    projectId: clean(params.get("project_id") ?? params.get("projectId")),
    runGroupId: clean(params.get("run_group_id") ?? params.get("runGroupId")),
    scope: clean(params.get("scope")),
    status: clean(params.get("status"))
  }).map(preferenceSummary);
}

async function createPreferenceResponse(db: RunnerDatabase, request: Request): Promise<Record<string, unknown>> {
  const body = await parseJsonBody(request);
  try {
    const result = writePiNotificationPreference(db, record(body));
    return {
      confirmation_text: safeText(result.confirmation_text),
      preference: preferenceSummary(result.preference)
    };
  } catch (error) {
    if (error instanceof PiNotificationPreferenceValidationError) throw new HttpError(400, error.message);
    throw error;
  }
}

function disablePreferenceResponse(db: RunnerDatabase, request: Request): Record<string, unknown> {
  const id = preferenceID(request);
  if (!getPiNotificationPreference(db, id)) throw new HttpError(404, "偏好不存在");
  return { preference: preferenceSummary(disablePiNotificationPreference(db, id)) };
}

function preferenceSummary(preference: PiNotificationPreference): Record<string, unknown> {
  return {
    admin_enforced: preference.policy_kind === "admin_enforced",
    confirmation_text: safeText(preference.confirmation_text),
    conversation_id: preference.conversation_id,
    created_at: preference.created_at,
    digest_policy: safePolicyObject(preference.digest_policy_json),
    effective_after: {
      sequence: preference.effective_after_sequence,
      time: preference.effective_after_time
    },
    effective_after_sequence: preference.effective_after_sequence,
    effective_after_time: preference.effective_after_time,
    expires_at: preference.expires_at,
    id: preference.id,
    mode: preference.mode,
    notify_on: parseList(preference.notify_on_json),
    policy_kind: preference.policy_kind,
    project_id: preference.project_id,
    run_group_id: preference.run_group_id,
    scope: preference.scope,
    source_event_id: preference.source_event_id,
    source_event_sequence_id: preference.source_event_sequence_id,
    source_message_id: preference.source_message_id,
    status: preference.status,
    updated_at: preference.updated_at,
    version: preference.version
  };
}

function safePolicyObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return stripRawPayload(record(parsed));
  } catch {
    return {};
  }
}

function stripRawPayload(value: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (rawPayloadKey(key)) continue;
    result[key] = item;
  }
  return result;
}

function rawPayloadKey(key: string): boolean {
  return ["raw", "raw_payload", "provider_payload", "raw_provider_payload"].includes(key.trim().toLowerCase());
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function safeText(value: string): string {
  return redactAuditText(value);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function preferenceID(request: Request): string {
  const parts = new URL(request.url).pathname.split("/").filter(Boolean);
  const value = parts[parts.indexOf("preferences") + 1]?.trim() ?? "";
  if (value === "") throw new HttpError(400, "preference id 不能为空");
  return decodeURIComponent(value);
}
