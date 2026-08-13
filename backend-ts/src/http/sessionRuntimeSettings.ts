import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { RunnerDatabase } from "../db/database.ts";
import { getAgentSession } from "../db/repositories/agentSessions.ts";
import type { SessionCreateInput, SessionMessageInput } from "../providers/types.ts";
import { executionPolicyRequest, type ExecutionPolicyRequest } from "../providers/core/policyContracts.ts";

export type RuntimeSettings = {
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
  turnId = "",
  provider = ""
): Record<string, unknown> {
  const settings = runtimeSettings(input);
  return {
    ...settings,
    ...(provider.trim() ? { settings_provider: provider.trim() } : {}),
    ...(turnId ? { provider_turn_id: turnId } : {}),
    ...(input.policy ? {
      requested_execution_policy: input.policy.requested,
      resolved_execution_policy: {
        contract: input.policy.contract,
        effects: input.policy.effects,
        isolation: input.policy.isolation,
        native_summary: input.policy.nativeSummary,
        proof: input.policy.proof,
        warnings: input.policy.warnings
      }
    } : input.executionPolicy ? { requested_execution_policy: input.executionPolicy } : {})
  };
}

export function executionPolicyFromAgentSession(
  db: RunnerDatabase,
  sessionId: string,
  provider = "codex"
): ExecutionPolicyRequest | undefined {
  const raw = jsonRecord(getAgentSession(db, `${provider}:${sessionId}`)?.raw_ref);
  try { return executionPolicyRequest(raw.requested_execution_policy); } catch { return undefined; }
}

export function runtimeSettingsFromAgentSession(db: RunnerDatabase, sessionId: string, provider = "codex"): RuntimeSettings {
  const raw = jsonRecord(getAgentSession(db, `${provider}:${sessionId}`)?.raw_ref);
  return providerScopedRuntimeSettings(raw, provider);
}

/**
 * 纠正旧索引中的跨 Provider settings；adapter 提供的权威设置优先。
 * 返回 null 表示无需改写，避免每次 read 都刷新 updated_at。
 */
export function correctedRuntimeRawRef(
  rawRef: string,
  provider: string,
  detail: Record<string, unknown>
): Record<string, unknown> | null {
  const raw = jsonRecord(rawRef);
  if (Object.keys(raw).length === 0) return null;
  const next = { ...raw };
  let changed = false;
  const sourceProvider = stringValue(raw.settings_provider);
  if (sourceProvider && sourceProvider !== provider) {
    for (const key of ["model", "reasoning_effort", "service_tier"]) {
      if (key in next) {
        delete next[key];
        changed = true;
      }
    }
  }
  if (provider !== "codex" && next.model === "codex-default") {
    delete next.model;
    changed = true;
  }
  const authoritative = runtimeSettings(detail);
  for (const key of ["model", "reasoning_effort", "service_tier"] as const) {
    const value = authoritative[key];
    if (value && next[key] !== value) {
      next[key] = value;
      changed = true;
    }
  }
  if (changed && next.settings_provider !== provider) next.settings_provider = provider;
  return changed ? next : null;
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

function providerScopedRuntimeSettings(raw: Record<string, unknown>, provider: string): RuntimeSettings {
  const settings = runtimeSettings(raw);
  const sourceProvider = stringValue(raw.settings_provider);
  if (sourceProvider && sourceProvider !== provider) {
    delete settings.model;
    delete settings.reasoning_effort;
    delete settings.service_tier;
  }
  if (provider !== "codex" && settings.model === "codex-default") delete settings.model;
  return settings;
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
