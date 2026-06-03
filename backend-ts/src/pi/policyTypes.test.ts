import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PI_MODE_POLICY,
  PI_GATE_DECISIONS,
  PI_RISK_LEVELS,
  PI_WORK_MODES,
  normalizePiModePolicy
} from "./policyTypes.ts";

describe("PI mode and risk policy types", () => {
  test("covers supported work modes, risk levels, and gate decisions", () => {
    expect(PI_WORK_MODES).toEqual(["manual", "attended", "delegated", "autonomous"]);
    expect(PI_RISK_LEVELS).toEqual(["safe", "confirm", "high", "forbidden"]);
    expect(PI_GATE_DECISIONS).toEqual(["execute", "ask", "deny", "snooze"]);
  });

  test("uses attended mode and conservative risk decisions by default", () => {
    expect(normalizePiModePolicy(undefined)).toEqual(DEFAULT_PI_MODE_POLICY);
    expect(DEFAULT_PI_MODE_POLICY).toEqual({
      mode: "attended",
      riskPolicy: {
        safe: "execute",
        confirm: "ask",
        high: "ask",
        forbidden: "deny"
      }
    });
  });

  test("falls back for invalid mode, risk level, and gate decision values", () => {
    expect(normalizePiModePolicy({
      mode: "auto",
      riskPolicy: {
        safe: "execute",
        confirm: "approve",
        high: "deny",
        forbidden: "execute",
        unknown: "ask"
      }
    })).toEqual({
      mode: "attended",
      riskPolicy: {
        safe: "execute",
        confirm: "ask",
        high: "deny",
        forbidden: "deny"
      }
    });
  });
});
