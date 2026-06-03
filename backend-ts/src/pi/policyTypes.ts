export const PI_WORK_MODES = ["manual", "attended", "delegated", "autonomous"] as const;
export const PI_RISK_LEVELS = ["safe", "confirm", "high", "forbidden"] as const;
export const PI_GATE_DECISIONS = ["execute", "ask", "deny", "snooze"] as const;

export type PiWorkMode = typeof PI_WORK_MODES[number];
export type PiRiskLevel = typeof PI_RISK_LEVELS[number];
export type PiGateDecisionValue = typeof PI_GATE_DECISIONS[number];

export type PiRiskPolicy = Record<PiRiskLevel, PiGateDecisionValue>;
export type PiModePolicy = {
  mode: PiWorkMode;
  riskPolicy: PiRiskPolicy;
};
export type PiModeResolutionSource = "explicit" | "delegation" | "project_default" | "manual";
export type PiModeResolutionInput = {
  activeDelegation?: unknown;
  now?: Date | string;
  projectDefault?: unknown;
  sessionMode?: unknown;
  taskMode?: unknown;
};
export type PiModeResolution = {
  mode: PiWorkMode;
  source: PiModeResolutionSource;
};

export const DEFAULT_PI_MODE_POLICY: PiModePolicy = {
  mode: "attended",
  riskPolicy: {
    safe: "execute",
    confirm: "ask",
    high: "ask",
    forbidden: "deny"
  }
};

export function normalizePiModePolicy(value: unknown): PiModePolicy {
  const input = objectValue(value);
  const mode = isPiWorkMode(input.mode) ? input.mode : DEFAULT_PI_MODE_POLICY.mode;
  return { mode, riskPolicy: normalizeRiskPolicy(input.riskPolicy ?? input.risk_policy) };
}

export function resolvePiWorkMode(input: PiModeResolutionInput = {}): PiModeResolution {
  const explicit = firstWorkMode(input.taskMode, input.sessionMode);
  if (explicit) return { mode: explicit, source: "explicit" };
  const delegation = activeDelegationMode(input.activeDelegation, input.now);
  if (delegation) return { mode: delegation, source: "delegation" };
  const projectDefault = firstWorkMode(input.projectDefault);
  if (projectDefault) return { mode: projectDefault, source: "project_default" };
  return { mode: "manual", source: "manual" };
}

function normalizeRiskPolicy(value: unknown): PiRiskPolicy {
  const input = objectValue(value);
  return {
    safe: gateDecision(input.safe, DEFAULT_PI_MODE_POLICY.riskPolicy.safe),
    confirm: gateDecision(input.confirm, DEFAULT_PI_MODE_POLICY.riskPolicy.confirm),
    high: gateDecision(input.high, DEFAULT_PI_MODE_POLICY.riskPolicy.high),
    forbidden: input.forbidden === "deny" ? "deny" : DEFAULT_PI_MODE_POLICY.riskPolicy.forbidden
  };
}

function gateDecision(value: unknown, fallback: PiGateDecisionValue): PiGateDecisionValue {
  return isPiGateDecision(value) ? value : fallback;
}

function activeDelegationMode(value: unknown, now: Date | string | undefined): PiWorkMode | undefined {
  const input = objectValue(value);
  if (cleanString(input.status) !== "active") return undefined;
  const auth = objectValue(input.authorization ?? input.authorization_json ?? input.authorizationJson);
  if (!withinDelegationWindow(auth, now)) return undefined;
  return firstWorkMode(auth.mode, input.mode);
}

function withinDelegationWindow(auth: Record<string, unknown>, now: Date | string | undefined): boolean {
  const nowMs = timeMs(now ?? new Date()) ?? Date.now();
  const startsAt = timeMs(auth.starts_at ?? auth.startsAt);
  const expiresAt = timeMs(auth.expires_at ?? auth.expiresAt);
  if (startsAt !== undefined && nowMs < startsAt) return false;
  return expiresAt === undefined || nowMs < expiresAt;
}

function firstWorkMode(...values: unknown[]): PiWorkMode | undefined {
  for (const value of values) {
    const direct = cleanString(value);
    if (isPiWorkMode(direct)) return direct;
    const mode = objectValue(value).mode;
    if (isPiWorkMode(mode)) return mode;
  }
  return undefined;
}

function isPiWorkMode(value: unknown): value is PiWorkMode {
  return PI_WORK_MODES.includes(value as PiWorkMode);
}

function isPiGateDecision(value: unknown): value is PiGateDecisionValue {
  return PI_GATE_DECISIONS.includes(value as PiGateDecisionValue);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== "string" || value.trim() === "") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function timeMs(value: unknown): number | undefined {
  if (value instanceof Date) return value.getTime();
  const text = cleanString(value);
  if (text === "") return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
