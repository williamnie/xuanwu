import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxThinking } from "@earendil-works/pi-ai/compat";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  interpretAcceptanceResponse,
  interpretAcceptanceSession,
  parseAcceptanceDecision
} from "./issueAcceptance.ts";

describe("PI issue acceptance decision", () => {
  test("accepts only the explicit five-way JSON schema", () => {
    expect(parseAcceptanceDecision(JSON.stringify({
      confidence: "high",
      decision: "accept",
      evidence_refs: ["command:final", "git:abc"],
      progress: { made_progress: true, evidence_refs: ["command:final"], summary: "完成实现和验证。" },
      rationale: "后续完整验证退出码为 0，覆盖并取代了早期失败。",
      unmet_requirements: []
    }))).toMatchObject({ decision: "accept", confidence: "high" });
    expect(parseAcceptanceDecision(JSON.stringify({
      confidence: "high",
      decision: "accept",
      evidence_refs: ["run:fixture"],
      rationale: "事实充分。",
      unmet_requirements: []
    }))).toBeNull();
    expect(parseAcceptanceDecision(JSON.stringify({ decision: "retry" }))).toBeNull();
    expect(parseAcceptanceDecision(JSON.stringify({
      confidence: 0.97,
      decision: "accept",
      evidence_refs: ["run:fixture"],
      progress: { made_progress: true, evidence_refs: ["run:fixture"], summary: "当前 Run 已完成。" },
      rationale: "事实充分。",
      unmet_requirements: []
    }))).toBeNull();
    expect(parseAcceptanceDecision(JSON.stringify({
      confidence: "high",
      decision: "needs_user",
      evidence_refs: ["run:fixture"],
      human_review_kind: "risk_acceptance",
      progress: { made_progress: false, evidence_refs: ["run:fixture"], summary: "等待授权。" },
      rationale: "需要明确付费授权。",
      unmet_requirements: ["缺少预算上限"]
    }))).toMatchObject({ decision: "needs_user", human_review_kind: "risk_acceptance" });
    expect(parseAcceptanceDecision(JSON.stringify({
      confidence: "high",
      decision: "needs_user",
      evidence_refs: ["run:fixture"],
      human_review_kind: "information",
      progress: { made_progress: false, evidence_refs: ["run:fixture"], summary: "等待信息。" },
      rationale: "需要信息。",
      unmet_requirements: ["缺少信息"]
    }))).toBeNull();
    expect(parseAcceptanceDecision("not json")).toBeNull();
  });

  test("does not regex-normalize prose into a decision", () => {
    expect(parseAcceptanceDecision("看起来应该继续重试一下")).toBeNull();
  });

  test("reports Provider failures instead of misclassifying an empty response as invalid JSON", () => {
    expect(interpretAcceptanceResponse("", "Codex error: server_is_overloaded")).toEqual({
      error: "PI acceptance provider failed: Codex error: server_is_overloaded",
      raw_text: "",
      valid: false
    });
    expect(interpretAcceptanceResponse("not json")).toEqual({
      error: "PI acceptance returned invalid JSON or schema",
      raw_text: "not json",
      valid: false
    });
  });

  test("accepts a schema-valid acceptance decision returned only as model thinking", () => {
    const decision = {
      confidence: "high",
      decision: "accept",
      evidence_refs: ["run:fixture"],
      progress: { made_progress: true, evidence_refs: ["run:fixture"], summary: "已完成实现。" },
      rationale: "证据充分。",
      unmet_requirements: []
    };
    const message = fauxAssistantMessage(fauxThinking(JSON.stringify(decision)), { stopReason: "stop" });
    const session = {
      getLastAssistantText: () => undefined,
      state: { errorMessage: "", messages: [message] }
    } as Pick<AgentSession, "getLastAssistantText" | "state">;

    expect(interpretAcceptanceSession(session)).toEqual({
      decision,
      raw_text: JSON.stringify(decision),
      valid: true
    });
  });
});
