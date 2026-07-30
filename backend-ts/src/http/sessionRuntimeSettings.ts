import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import type { SessionCreateInput, SessionMessageInput } from "../providers/types.ts";

type RuntimeSettings = {
  approval_policy?: string;
  model?: string;
  reasoning_effort?: string;
  sandbox?: string;
  service_tier?: string;
};

export async function withSessionRuntimeSettings(
  db: RunnerDatabase,
  sessionId: string,
  detail: Record<string, unknown>,
  provider = "codex"
): Promise<Record<string, unknown>> {
  const settings = {
    ...runtimeSettingsFromAgentSession(db, sessionId, provider),
    ...(provider === "codex" ? await runtimeSettingsFromRolloutPath(stringValue(detail.path)) : {}),
    ...runtimeSettings(detail)
  };
  if (!hasRuntimeSettings(settings)) return detail;
  return { ...detail, ...settings, runtime_settings: settings };
}

export function runtimeRawRef(
  input: SessionCreateInput | SessionMessageInput,
  turnId = ""
): Record<string, string> {
  const settings = runtimeSettings(input);
  return turnId ? { ...settings, provider_turn_id: turnId } : settings;
}

export function runtimeSettingsFromAgentSession(db: RunnerDatabase, sessionId: string, provider = "codex"): RuntimeSettings {
  const raw = jsonRecord(getAgentSession(db, `${provider}:${sessionId}`)?.raw_ref);
  return runtimeSettings(raw);
}

async function runtimeSettingsFromRolloutPath(path: string): Promise<RuntimeSettings> {
  if (path === "") return {};
  const settings: RuntimeSettings = {};
  try {
    const reader = createInterface({
      crlfDelay: Infinity,
      input: createReadStream(path, { encoding: "utf8" })
    });
    for await (const line of reader) mergeTurnContextSettings(settings, line);
  } catch {
    return {};
  }
  return settings;
}

function mergeTurnContextSettings(settings: RuntimeSettings, line: string): void {
  if (!line.includes('"turn_context"')) return;
  const record = jsonRecord(line);
  if (record.type !== "turn_context") return;
  const context = jsonRecord(record.payload);
  Object.assign(settings, runtimeSettings({ ...context, ...collaborationSettings(context) }));
}

function runtimeSettings(input: Record<string, unknown>): RuntimeSettings {
  return compactRuntimeSettings({
    model: stringValue(input.model),
    reasoning_effort: firstNonEmpty(
      stringValue(input.reasoning_effort),
      stringValue(input.reasoningEffort),
      stringValue(input.effort)
    ),
    service_tier: firstNonEmpty(stringValue(input.service_tier), stringValue(input.serviceTier)),
    approval_policy: firstNonEmpty(stringValue(input.approval_policy), stringValue(input.approvalPolicy)),
    sandbox: firstNonEmpty(stringValue(input.sandbox), sandboxFromPolicy(input.sandbox_policy ?? input.sandboxPolicy))
  });
}

function collaborationSettings(context: Record<string, unknown>): Record<string, unknown> {
  return jsonRecord(jsonRecord(context.collaboration_mode).settings);
}

function sandboxFromPolicy(value: unknown): string {
  const raw = typeof value === "string" ? value : stringValue(jsonRecord(value).type);
  switch (raw) {
    case "dangerFullAccess": return "danger-full-access";
    case "workspaceWrite": return "workspace-write";
    case "readOnly": return "read-only";
    default: return raw;
  }
}

function compactRuntimeSettings(settings: RuntimeSettings): RuntimeSettings {
  return Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== "")) as RuntimeSettings;
}

function hasRuntimeSettings(settings: RuntimeSettings): boolean {
  return Object.keys(settings).length > 0;
}

function jsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return jsonRecord(parsed);
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "")?.trim() ?? "";
}
