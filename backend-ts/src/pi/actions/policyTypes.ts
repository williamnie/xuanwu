export const PI_WORK_MODES = ["manual", "attended", "delegated", "autonomous"] as const;
export const PI_GATE_DECISIONS = ["execute", "ask", "deny", "snooze"] as const;

export type PiWorkMode = typeof PI_WORK_MODES[number];
export type PiGateDecisionValue = typeof PI_GATE_DECISIONS[number];
