import type { PiActionMode, PiAuthorizationScope, PiGatePolicy } from "./actionGate.ts";
import type { heartbeatContext } from "./heartbeatOrchestratorSupport.ts";
import type { HeartbeatInput } from "./heartbeatTypes.ts";

type HeartbeatContext = ReturnType<typeof heartbeatContext>;

export function heartbeatAuthorizationPolicy(input: HeartbeatInput, ctx: HeartbeatContext): PiGatePolicy {
  const delegation = input.delegation;
  const auth = objectValue(delegation?.authorization_json);
  return cleanPolicy({
    ...auth,
    allowed_actions: listValue(auth.allowed_actions ?? auth.allowedActions, delegation?.allowed_actions_json),
    allowed_mcp_capabilities: listValue(
      auth.allowed_mcp_capabilities ?? auth.allowedMcpCapabilities,
      delegation?.allowed_mcp_capabilities_json
    ),
    allowed_skill_intents: listValue(
      auth.allowed_skill_intents ?? auth.allowedSkillIntents,
      delegation?.allowed_skill_intents_json
    ),
    forbidden_actions: listValue(auth.forbidden_actions ?? auth.forbiddenActions, delegation?.forbidden_actions_json),
    mode: workMode(auth.mode, delegation ? "delegated" : "attended"),
    now: ctx.nowText,
    scope: scopeValue(auth.scope ?? auth.scopes, delegation?.scope_json),
    starts_at: cleanString(auth.starts_at ?? auth.startsAt) || cleanString(delegation?.starts_at),
    expires_at: cleanString(auth.expires_at ?? auth.expiresAt) || cleanString(delegation?.expires_at)
  });
}

export function heartbeatAuthorizationSummary(policy: PiGatePolicy): Record<string, unknown> {
  return {
    allowed_actions: policy.allowed_actions ?? [],
    allowed_mcp_capabilities: policy.allowed_mcp_capabilities ?? policy.allowedMcpCapabilities ?? [],
    allowed_skill_intents: policy.allowed_skill_intents ?? policy.allowedSkillIntents ?? [],
    forbidden_actions: policy.forbidden_actions ?? [],
    mode: policy.mode ?? "attended",
    scope_present: policy.scope !== undefined || policy.scopes !== undefined,
    window: { expires_at: cleanString(policy.expires_at), starts_at: cleanString(policy.starts_at) }
  };
}

function cleanPolicy(policy: PiGatePolicy): PiGatePolicy {
  return Object.fromEntries(Object.entries(policy).filter(([, value]) => (
    Array.isArray(value) ? value.length > 0 : value !== undefined && value !== ""
  ))) as PiGatePolicy;
}

function listValue(primary: unknown, fallback: unknown): string[] {
  const list = stringList(primary);
  return list.length > 0 ? list : stringList(fallback);
}

function scopeValue(primary: unknown, fallback: unknown): PiAuthorizationScope | PiAuthorizationScope[] | undefined {
  const value = structuredValue(primary);
  return (value === undefined ? structuredValue(fallback) : value) as PiAuthorizationScope | PiAuthorizationScope[] | undefined;
}

function workMode(value: unknown, fallback: PiActionMode): PiActionMode {
  const mode = cleanString(value);
  if (mode === "manual" || mode === "attended" || mode === "delegated" || mode === "autonomous") return mode;
  return fallback;
}

function structuredValue(value: unknown): unknown {
  if (value && typeof value === "object") return value;
  const text = cleanString(value);
  if (text === "") return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function objectValue(value: unknown): Record<string, unknown> {
  const parsed = structuredValue(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean);
  const text = cleanString(value);
  if (text === "") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.map(cleanString).filter(Boolean);
  } catch {}
  return text.split(/\n|,/).map(cleanString).filter(Boolean);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
