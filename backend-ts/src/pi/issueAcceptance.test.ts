import { describe, expect, test } from "bun:test";
import { parseAcceptanceDecision } from "./issueAcceptance.ts";

describe("PI issue acceptance decision", () => {
  test("accepts only the explicit five-way JSON schema", () => {
    expect(parseAcceptanceDecision(JSON.stringify({
      confidence: "high",
      decision: "accept",
      evidence_refs: ["command:final", "git:abc"],
      rationale: "后续完整验证退出码为 0，覆盖并取代了早期失败。",
      unmet_requirements: []
    }))).toMatchObject({ decision: "accept", confidence: "high" });
    expect(parseAcceptanceDecision(JSON.stringify({ decision: "retry" }))).toBeNull();
    expect(parseAcceptanceDecision(JSON.stringify({
      confidence: 0.97,
      decision: "accept",
      evidence_refs: ["run:fixture"],
      rationale: "事实充分。",
      unmet_requirements: []
    }))).toBeNull();
    expect(parseAcceptanceDecision("not json")).toBeNull();
  });

  test("does not regex-normalize prose into a decision", () => {
    expect(parseAcceptanceDecision("看起来应该继续重试一下")).toBeNull();
  });
});
