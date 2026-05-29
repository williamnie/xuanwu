import { describe, expect, test } from "bun:test";
import { classifyPiActionRisk } from "./actionEngine.ts";

describe("PI action engine risk classifier", () => {
  test("classifies safe, confirm-required, and high-risk actions", () => {
    expect(classifyPiActionRisk("issue.comment")).toEqual({
      gate: "safe",
      requiresConfirmation: false,
      riskLevel: "low"
    });
    expect(classifyPiActionRisk("issue.enqueue")).toEqual({
      gate: "confirm",
      requiresConfirmation: true,
      riskLevel: "medium"
    });
    expect(classifyPiActionRisk("session.steer")).toEqual({
      gate: "high",
      requiresConfirmation: true,
      riskLevel: "high"
    });
  });
});
