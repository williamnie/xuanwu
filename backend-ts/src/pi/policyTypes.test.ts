import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PI_MODE_POLICY,
  PI_GATE_DECISIONS,
  PI_RISK_LEVELS,
  PI_WORK_MODES,
  normalizePiModePolicy,
  resolvePiWorkMode
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

  test("resolves explicit session or task mode before delegation and project default", () => {
    const activeDelegation = {
      authorization_json: JSON.stringify({ expires_at: "2026-06-03T10:00:00.000Z", mode: "delegated" }),
      status: "active"
    };
    const base = {
      activeDelegation,
      now: "2026-06-03T09:00:00.000Z",
      projectDefault: { mode: "attended" }
    };

    expect(resolvePiWorkMode({ ...base, sessionMode: "manual" })).toEqual({
      mode: "manual",
      source: "explicit"
    });
    expect(resolvePiWorkMode({ ...base, sessionMode: "manual", taskMode: "autonomous" })).toEqual({
      mode: "autonomous",
      source: "explicit"
    });
  });

  test("resolves active unexpired delegation before project default", () => {
    expect(resolvePiWorkMode({
      activeDelegation: {
        authorization_json: JSON.stringify({ expires_at: "2026-06-03T10:00:00.000Z", mode: "delegated" }),
        status: "active"
      },
      now: "2026-06-03T09:00:00.000Z",
      projectDefault: { mode: "attended" }
    })).toEqual({
      mode: "delegated",
      source: "delegation"
    });
  });

  test("ignores expired delegation and falls back to project default", () => {
    expect(resolvePiWorkMode({
      activeDelegation: {
        authorization_json: JSON.stringify({ expires_at: "2026-06-03T08:00:00.000Z", mode: "delegated" }),
        status: "active"
      },
      now: "2026-06-03T09:00:00.000Z",
      projectDefault: { mode: "attended" }
    })).toEqual({
      mode: "attended",
      source: "project_default"
    });
  });

  test("defaults resolution to manual while policy normalization stays attended", () => {
    expect(resolvePiWorkMode()).toEqual({ mode: "manual", source: "manual" });
    expect(resolvePiWorkMode({ projectDefault: { mode: "auto" } })).toEqual({
      mode: "manual",
      source: "manual"
    });
    expect(normalizePiModePolicy(undefined).mode).toBe("attended");
  });
});
