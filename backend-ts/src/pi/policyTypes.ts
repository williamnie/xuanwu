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
