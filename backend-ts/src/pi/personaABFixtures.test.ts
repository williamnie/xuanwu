import { describe, expect, test } from "bun:test";
import { PI_PERSONA_AB_CASES } from "./personaABFixtures.ts";

const CONTROL_TERMS = /\b(?:Work|Run|Evidence|Handoff)\b|\b(?:project|issue|run)_id\b/g;

describe("PI Persona fixed A/B contract set", () => {
  test("keeps at least twenty fixed cases across the required ten categories", () => {
    expect(PI_PERSONA_AB_CASES).toHaveLength(20);
    const categories = new Set(PI_PERSONA_AB_CASES.map((item) => item.category));
    for (const category of ["greeting", "capability", "explanation", "status", "authorized_action", "tool_failure", "self_correction", "ambiguous_project", "short_reply", "english", "audit"]) {
      expect(categories.has(category)).toBe(true);
    }
  });

  test("preserves normalized tool calls, critical arguments, mutation intent, and gate outcomes", () => {
    for (const item of PI_PERSONA_AB_CASES) {
      const baselineCalls = normalizedCalls(item.baseline.toolCalls);
      const candidateCalls = normalizedCalls(item.candidate.toolCalls);
      expect(candidateCalls, item.id).toEqual(baselineCalls);
      expect(candidateCalls.map((call) => call.name), item.id).toEqual([...item.contract.expectedToolNames].sort());
      expect(item.candidate.mutationIntent, item.id).toBe(item.contract.expectedMutationIntent);
      expect(item.candidate.gateOutcome, item.id).toBe(item.contract.expectedGateOutcome);
      expect(item.baseline.mutationIntent, item.id).toBe(item.candidate.mutationIntent);
      expect(item.baseline.gateOutcome, item.id).toBe(item.candidate.gateOutcome);
    }
  });

  test("meets facts, claims, language, terminology, and internal JSON schema gates", () => {
    for (const item of PI_PERSONA_AB_CASES) {
      const output = item.candidate.output;
      for (const fact of item.contract.requiredFacts) expect(output, item.id).toContain(fact);
      for (const claim of item.contract.forbiddenClaims) expect(output, item.id).not.toContain(claim);
      if (item.contract.expectedLanguage === "en-US") expect(output, item.id).not.toMatch(/[\u3400-\u9fff]/);
      else expect(output, item.id).toMatch(/[\u3400-\u9fff]/);
      if (item.contract.terminologyPolicy === "natural") expect(output.match(CONTROL_TERMS) ?? [], item.id).toHaveLength(0);
      else {
        expect(output, item.id).toContain("Run run-42-3");
        expect(output, item.id).toContain("Evidence ev-991");
      }
      if (item.contract.outputSchema !== "natural_language") assertInternalSchema(item.contract.outputSchema, output);
    }
  });

  test("reduces unnecessary control-plane terminology without changing internal JSON", () => {
    const natural = PI_PERSONA_AB_CASES.filter((item) => item.contract.terminologyPolicy === "natural" && item.contract.outputSchema === "natural_language");
    const baselineTerms = natural.reduce((count, item) => count + (item.baseline.output.match(CONTROL_TERMS)?.length ?? 0), 0);
    const candidateTerms = natural.reduce((count, item) => count + (item.candidate.output.match(CONTROL_TERMS)?.length ?? 0), 0);
    expect(baselineTerms).toBeGreaterThan(10);
    expect(candidateTerms).toBe(0);
    for (const item of PI_PERSONA_AB_CASES.filter((entry) => entry.contract.outputSchema !== "natural_language")) {
      expect(item.candidate.output).toBe(item.baseline.output);
    }
  });
});

function normalizedCalls(calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
  return calls.map((call) => ({ name: call.name, arguments: stable(call.arguments) })).sort((a, b) => a.name.localeCompare(b.name));
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stable(item)]));
}

function assertInternalSchema(schema: string, output: string): void {
  const value = JSON.parse(output) as Record<string, unknown>;
  expect(Object.keys(value).length).toBeGreaterThan(0);
  if (schema === "acceptance_json") {
    expect(["accept", "continue_same_session", "code_review", "independent_acceptance", "needs_user"]).toContain(String(value.decision));
    expect(Array.isArray(value.evidence_refs)).toBe(true);
    expect(Array.isArray(value.unmet_requirements)).toBe(true);
  } else if (schema === "recovery_json") {
    expect(["wait", "resume_session", "steer_running_turn", "retry_issue", "repair_issue_state", "needs_user", "blocked", "noop"]).toContain(String(value.decision));
    expect(["low", "medium", "high"]).toContain(String(value.risk_level));
  } else {
    expect(["send", "suppress"]).toContain(String(value.decision));
    expect(typeof value.message).toBe("string");
    expect(typeof value.rationale).toBe("string");
  }
}
