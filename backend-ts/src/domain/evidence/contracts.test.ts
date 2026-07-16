import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { normalizeVerificationEvidence } from "../../pi/verificationEvidence.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { makeRunAttemptID } from "../run/contracts.ts";
import {
  EVIDENCE_KINDS,
  EVIDENCE_SCHEMA,
  EVIDENCE_STATE_TRANSITIONS,
  canSatisfyEvidenceGate,
  evaluateEvidenceTransition,
  isKnownEvidenceKind,
  redactEvidenceRecord,
  validateEvidence,
  type EvidenceKind,
  type EvidenceRecord,
  type EvidenceSourceKind,
  type EvidenceTransitionCommand
} from "./contracts.ts";
import { projectVerificationEvidenceV0 } from "./legacyAdapter.ts";

const NOW = "2026-07-16T09:30:00.000Z";
const LATER = "2026-07-16T09:31:00.000Z";
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const ADR_PATH = "docs/architecture/xuanwu/0027-evidence-domain-contract.md";

const SOURCE_BY_KIND: Record<typeof EVIDENCE_KINDS[number], EvidenceSourceKind> = {
  shell: "command_execution",
  test: "test_runner",
  lint: "linter",
  build: "build_system",
  git: "git_repository",
  http: "http_exchange",
  browser: "browser_session",
  human: "human_attestation"
};

describe("Evidence domain contract", () => {
  test("publishes a runnable schema for every required Evidence kind and reuses the P00.04 state machine", () => {
    expect(EVIDENCE_KINDS).toEqual(["shell", "test", "lint", "build", "git", "http", "browser", "human"]);
    expect(EVIDENCE_STATE_TRANSITIONS).toEqual({
      pending: ["passed", "failed", "blocked"],
      passed: [],
      failed: [],
      blocked: []
    });

    for (const kind of EVIDENCE_KINDS) {
      const evidence = record(kind, "passed", SOURCE_BY_KIND[kind], kind === "human" ? "human_attestation" : "tool_result");
      expect(Value.Check(EVIDENCE_SCHEMA, evidence), kind).toBe(true);
      expect(validateEvidence(evidence), kind).toEqual({ errors: [], known_kind: true, ok: true });
      expect(canSatisfyEvidenceGate(evidence), kind).toBe(true);
    }
  });

  test("accepts well-formed unknown kinds for forward reads but fails closed at completion gates", () => {
    const future = record("security_scan", "passed", "command_execution", "system_observation");

    expect(Value.Check(EVIDENCE_SCHEMA, future)).toBe(true);
    expect(validateEvidence(future)).toEqual({ errors: [], known_kind: false, ok: true });
    expect(isKnownEvidenceKind(future.kind)).toBe(false);
    expect(canSatisfyEvidenceGate(future)).toBe(false);

    future.kind = "Future Kind";
    expect(validateEvidence(future).ok).toBe(false);
  });

  test("enforces terminal timestamps, Run/Attempt ownership, and schema closure", () => {
    const pending = record("test", "pending", "test_runner", "tool_result");
    expect(validateEvidence(pending).ok).toBe(true);

    pending.completed_at = LATER;
    expect(validateEvidence(pending).errors).toContain("pending Evidence cannot have completed_at");

    const terminal = record("test", "passed", "test_runner", "tool_result");
    delete terminal.completed_at;
    expect(validateEvidence(terminal).errors).toContain("terminal Evidence requires completed_at");

    const reversed = record("test", "passed", "test_runner", "tool_result");
    reversed.completed_at = "2026-07-16T09:29:00.000Z";
    expect(validateEvidence(reversed).errors).toContain("completed_at cannot precede observed_at");

    const linked = record("test", "passed", "test_runner", "tool_result");
    linked.attempt_id = makeRunAttemptID(makeDomainID("run", "issue_runs", "other-run"), 1);
    expect(validateEvidence(linked).errors).toContain("attempt_id must belong to run_id");

    expect(Value.Check(EVIDENCE_SCHEMA, { ...record("test"), raw_secret: "not allowed" })).toBe(false);
  });

  test("requires auditable deterministic status transitions and keeps terminal Evidence immutable", () => {
    const pending = record("test", "pending", "test_runner", "tool_result");
    const command = transition(pending, "passed");
    expect(evaluateEvidenceTransition(pending, command)).toEqual({ allowed: true, violations: [] });

    command.audit.gate.decision = "ask";
    expect(evaluateEvidenceTransition(pending, command).violations).toContain("transition gate requires approval");
    command.audit.gate.decision = "allow";
    command.audit.gate.authority = "llm" as EvidenceTransitionCommand["audit"]["gate"]["authority"];
    expect(evaluateEvidenceTransition(pending, command).violations).toContain("transition gate authority is not trusted");

    const passed = record("test", "passed", "test_runner", "tool_result");
    expect(evaluateEvidenceTransition(passed, transition(passed, "failed")).violations)
      .toContain("illegal Evidence transition passed -> failed");
  });

  test("redacts nested secret values, forbids sensitive fact keys, and never promotes an Agent claim", () => {
    const raw = record("shell", "passed", "command_execution", "tool_result");
    raw.decisive_output.summary = "token super-secret; command passed";
    raw.decisive_output.facts.command = "CODEX_RUNNER_AUTH_TOKEN=secret bun test";
    raw.artifact_refs = [{ kind: "url", ref: "https://example.test/report?access_token=secret-value" }];
    expect(validateEvidence(raw).errors).toEqual(expect.arrayContaining([
      "unredacted sensitive value at /decisive_output/summary",
      "unredacted sensitive value at /decisive_output/facts/command",
      "unredacted sensitive value at /artifact_refs/0/ref"
    ]));

    const redacted = redactEvidenceRecord(raw, "evidence-redaction:v1");
    expect(redacted.redaction.status).toBe("applied");
    expect(redacted.redaction.redacted_paths).toEqual(expect.arrayContaining([
      "/decisive_output/summary",
      "/decisive_output/facts/command",
      "/artifact_refs/0/ref"
    ]));
    expect(JSON.stringify(redacted)).not.toContain("super-secret");
    expect(JSON.stringify(redacted)).not.toContain("secret-value");
    expect(validateEvidence(redacted).ok).toBe(true);

    const forbiddenField = record("shell", "passed", "command_execution", "tool_result");
    forbiddenField.decisive_output.facts.api_key = "[redacted]";
    expect(validateEvidence(forbiddenField).errors).toContain("sensitive decisive_output fact key is forbidden: api_key");

    const fakeRedaction = record("shell", "passed", "command_execution", "tool_result");
    fakeRedaction.redaction = { status: "applied", policy_ref: "evidence-redaction:v1", redacted_paths: ["/decisive_output/summary"] };
    expect(validateEvidence(fakeRedaction).errors)
      .toContain("redacted path does not reference a redacted string: /decisive_output/summary");

    const claim = record("test", "passed", "agent_statement", "agent_claim");
    expect(validateEvidence(claim).ok).toBe(true);
    expect(canSatisfyEvidenceGate(claim)).toBe(false);
  });

  test("projects VerificationEvidenceV0 without turning legacy claims into system proof", () => {
    const legacy = normalizeVerificationEvidence({
      version: 0,
      kind: "shell_test",
      status: "passed",
      summary: "bun test passed",
      command: "bun test src/pi/verificationEvidence.test.ts",
      artifact_refs: ["log:verification", "log:verification"]
    }, { now: NOW });
    const projected = projectVerificationEvidenceV0(legacy, {
      audit_event_ref: "issue_events:663:verification",
      evidence_id: makeDomainID("evidence", "issue_events", "663:verification"),
      producer: { id: "legacy-adapter", kind: "system" },
      projected_at: LATER,
      run_id: makeDomainID("run", "issue_runs", "663:1"),
      source_ref: "verificationEvidenceV0:663",
      work_id: makeDomainID("work", "issues", 663)
    });

    expect(projected).toMatchObject({
      kind: "shell",
      status: "passed",
      provenance: { assertion_origin: "legacy_import", source_kind: "legacy_verification" },
      decisive_output: { facts: { command: "bun test src/pi/verificationEvidence.test.ts", legacy_schema_version: 0 } }
    });
    expect(projected.artifact_refs).toEqual([{ kind: "log", ref: "log:verification" }]);
    expect(validateEvidence(projected).ok).toBe(true);
    expect(canSatisfyEvidenceGate(projected)).toBe(false);

    const checker = projectVerificationEvidenceV0(normalizeVerificationEvidence({
      version: 0,
      kind: "independent_checker",
      status: "failed",
      summary: "checker failed",
      checker: "codex-verifier",
      artifact_refs: []
    }, { now: NOW }), {
      audit_event_ref: "issue_events:663:checker",
      evidence_id: makeDomainID("evidence", "issue_events", "663:checker"),
      producer: { id: "legacy-adapter", kind: "system" },
      projected_at: LATER,
      source_ref: "verificationEvidenceV0:663:checker",
      work_id: makeDomainID("work", "issues", 663)
    });
    expect(checker.kind).toBe("legacy.independent_checker");
    expect(validateEvidence(checker)).toMatchObject({ known_kind: false, ok: true });
  });

  test("documents authority, compatibility windows, rollback, and deletion gates", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const heading of [
      "Evidence 结构",
      "状态与 timestamps",
      "decisive output 与 artifact refs",
      "provenance",
      "redaction",
      "未知 kind 前向兼容"
    ]) expect(adr).toContain(heading);
    expect(adr).toContain("事实 source of truth 仍是产生该事实的 authority");
    expect(adr).toContain("双写窗口为 0");
    expect(adr).toContain("W1 与 W2 合计最多两个正式 release window");
    expect(adr).toContain("P11.03/P11.06");
    expect(adr).toContain("LLM/Agent claim 不能满足完成门禁");
  });
});

function record(
  kind: EvidenceKind,
  status: EvidenceRecord["status"] = "passed",
  sourceKind: EvidenceSourceKind = "test_runner",
  origin: EvidenceRecord["provenance"]["assertion_origin"] = "tool_result"
): EvidenceRecord {
  const runID = makeDomainID("run", "issue_runs", "663:1");
  return {
    schema_version: 1,
    id: makeDomainID("evidence", "issue_events", `663:${kind}`),
    work_id: makeDomainID("work", "issues", 663),
    run_id: runID,
    attempt_id: makeRunAttemptID(runID, 1),
    revision: 0,
    kind,
    status,
    created_at: NOW,
    observed_at: NOW,
    updated_at: LATER,
    ...(status === "pending" ? {} : { completed_at: LATER }),
    decisive_output: {
      summary: `${kind} ${status}`,
      facts: { checked: true }
    },
    artifact_refs: [],
    provenance: {
      assertion_origin: origin,
      source_kind: sourceKind,
      source_ref: `${sourceKind}:663`,
      audit_event_ref: `issue_events:663:${kind}`,
      producer: { id: origin === "human_attestation" ? "reviewer" : "runner", kind: origin === "human_attestation" ? "user" : "runner" }
    },
    redaction: {
      status: "not_required",
      policy_ref: "evidence-redaction:v1",
      redacted_paths: []
    }
  };
}

function transition(
  evidence: EvidenceRecord,
  to: Exclude<EvidenceRecord["status"], "pending">
): EvidenceTransitionCommand {
  return {
    audit: {
      actor: { id: "runner", kind: "runner" },
      correlation_id: "issue-663-evidence",
      event_id: "issue_events:663:evidence-transition",
      gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "evidence-status:v1" },
      occurred_at: LATER,
      reason: "collector completed"
    },
    completed_at: LATER,
    evidence_id: evidence.id,
    expected_revision: evidence.revision,
    to
  };
}
