import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CORE_OWNERSHIP_PARENT,
  DOMAIN_EVENT_NAMES,
  STATUS_VALUES_BY_KIND,
  STATE_TRANSITIONS,
  assertAcyclicOwnership,
  canTransition,
  makeDomainID,
  parseDomainID,
  validateDomainEvent,
  validateDomainSnapshot,
  type CoreDomainSnapshot,
  type DomainEvent
} from "./coreDomainContracts.ts";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const ADR_PATH = "docs/architecture/xuanwu/0004-core-domain-objects.md";

describe("Xuanwu core domain contracts", () => {
  test("builds stable kind-scoped IDs from authoritative legacy records", () => {
    const workID = makeDomainID("work", "issues", 634);
    const runID = makeDomainID("run", "issue_runs", "issue:634/attempt:1");

    expect(workID).toBe("xw:work:issues:634");
    expect(runID).toBe("xw:run:issue_runs:issue%3A634%2Fattempt%3A1");
    expect(parseDomainID(runID)).toEqual({
      authority: "issue_runs",
      kind: "run",
      local_id: "issue:634/attempt:1"
    });
    expect(() => makeDomainID("work", "issues", "")).toThrow("work local id is required");
  });

  test("locks state transitions without allowing terminal state rewrites", () => {
    expect(canTransition("work", "triage", "todo")).toBe(true);
    expect(canTransition("work", "done", "in_progress")).toBe(false);
    expect(canTransition("run", "recovering", "running")).toBe(true);
    expect(canTransition("evidence", "passed", "failed")).toBe(false);
    expect(canTransition("automation", "paused", "active")).toBe(true);

    for (const [kind, transitions] of Object.entries(STATE_TRANSITIONS)) {
      const known = new Set<string>(STATUS_VALUES_BY_KIND[kind as keyof typeof STATUS_VALUES_BY_KIND]);
      for (const [from, targets] of Object.entries(transitions)) {
        expect(known.has(from)).toBe(true);
        for (const target of targets) expect(known.has(target)).toBe(true);
      }
    }
  });

  test("has no circular ownership and rejects an injected ownership cycle", () => {
    expect(() => assertAcyclicOwnership()).not.toThrow();
    expect(() => assertAcyclicOwnership({
      ...CORE_OWNERSHIP_PARENT,
      work: "run",
      run: "work"
    })).toThrow("circular ownership detected");
  });

  test("accepts a Work to Run to Evidence to Handoff graph", () => {
    expect(validateDomainSnapshot(validSnapshot())).toEqual([]);
  });

  test("rejects cross-Work evidence and done without verified handoff", () => {
    const snapshot = validSnapshot();
    const otherWorkID = makeDomainID("work", "issues", 635);
    snapshot.works.push({
      ...snapshot.works[0],
      id: otherWorkID,
      status: "in_progress"
    });
    snapshot.evidence[0].work_id = otherWorkID;

    expect(validateDomainSnapshot(snapshot)).toEqual(expect.arrayContaining([
      expect.stringContaining("have different work owners"),
      expect.stringContaining("references evidence owned by another work"),
      expect.stringContaining("cannot be done without passed evidence")
    ]));
  });

  test("requires audited event identity, reason, correlation, and gated side effects", () => {
    const event: DomainEvent = {
      actor: { id: "runner", kind: "runner" },
      correlation_id: "corr-634",
      effect: {
        classification: "external_write",
        gate_decision: "allow",
        operation: "git.push",
        outcome: "succeeded",
        target: "origin/main"
      },
      event_id: "event-1",
      name: "handoff.delivery_completed.v1",
      occurred_at: "2026-07-15T00:00:00.000Z",
      payload: {},
      reason: "user requested delivery",
      subject: { id: makeDomainID("handoff", "derived", "634@abc123"), kind: "handoff" }
    };

    expect(validateDomainEvent(event)).toEqual([]);
    expect(validateDomainEvent({ ...event, actor: { ...event.actor, id: "" }, reason: "" })).toEqual([
      "actor.id is required",
      "reason is required"
    ]);
    expect(validateDomainEvent({ ...event, effect: undefined })).toContain(
      "handoff delivery events require an external_write or destructive effect"
    );
    expect(validateDomainEvent({
      ...event,
      effect: undefined,
      name: "work.status_changed.v1",
      subject: { id: makeDomainID("work", "issues", 634), kind: "work" }
    })).toContain("status change events require a state_change effect");
    expect(new Set(DOMAIN_EVENT_NAMES).size).toBe(DOMAIN_EVENT_NAMES.length);
    expect(DOMAIN_EVENT_NAMES.every((name) => /^(work|run|evidence|handoff|attention|automation)\.[a-z_]+\.v1$/.test(name)))
      .toBe(true);
  });

  test("keeps the canonical ADR, relationship diagram, legacy mapping, and migration gates", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const heading of ["Work", "Run", "Evidence", "Handoff", "Attention", "Automation"]) {
      expect(adr).toContain(`**${heading}**`);
    }
    expect(adr).toContain("```mermaid");
    expect(adr).toContain("## 8. 现有 Issue、Session、Guardian、PI 映射");
    expect(adr).toContain("**source of truth：**");
    expect(adr).toContain("**双写：无。双读：无。**");
    expect(adr).toContain("回滚开关");
    expect(adr).toContain("删除门禁");
  });
});

function validSnapshot(): CoreDomainSnapshot {
  const now = "2026-07-15T00:00:00.000Z";
  const workID = makeDomainID("work", "issues", 634);
  const runID = makeDomainID("run", "issue_runs", "issue-634-attempt-1");
  const evidenceID = makeDomainID("evidence", "issue_events", 9001);
  const handoffID = makeDomainID("handoff", "derived", "634@abc123");
  return {
    attentions: [{
      created_at: now,
      evidence_ids: [],
      id: makeDomainID("attention", "pi_guardian_alerts", "runtime-down"),
      next_action: "inspect local runtime",
      owner: { kind: "project", project_id: "codex-issue-runner" },
      reason_code: "runtime_unavailable",
      related_refs: ["pi_guardian_alerts:runtime-down"],
      required_actor: "user",
      status: "open",
      subject_refs: [],
      summary: "runtime needs user attention",
      updated_at: now
    }],
    automations: [{
      created_at: now,
      id: makeDomainID("automation", "pi_automations", 12),
      idempotency_namespace: "automation:12",
      mode: "propose",
      name: "repository heartbeat",
      owner: { kind: "project", project_id: "codex-issue-runner" },
      permission_policy_ref: "project-policy:codex-issue-runner",
      status: "active",
      trigger: { config: { every: "15m" }, type: "schedule" },
      updated_at: now
    }],
    evidence: [{
      artifact_refs: ["git:abc123", "command:bun-test"],
      created_at: now,
      id: evidenceID,
      kind: "test",
      producer: "deterministic-verifier",
      revision: "abc123",
      run_id: runID,
      status: "passed",
      summary: "focused tests passed",
      updated_at: now,
      work_id: workID
    }],
    handoffs: [{
      baseline_revision: "base123",
      changed_files: ["backend-ts/src/xuanwu/coreDomainContracts.ts"],
      created_at: now,
      delivery_actions: [],
      evidence_ids: [evidenceID],
      final_revision: "abc123",
      id: handoffID,
      review_ref: "git:abc123",
      status: "ready",
      summary: "ready for review",
      updated_at: now,
      work_id: workID
    }],
    runs: [{
      attempt: 1,
      created_at: now,
      id: runID,
      provider: "codex",
      started_at: now,
      status: "succeeded",
      updated_at: now,
      work_id: workID
    }],
    works: [{
      acceptance_criteria: ["type tests pass"],
      created_at: now,
      goal: "freeze core objects",
      id: workID,
      owner: { kind: "project", project_id: "codex-issue-runner" },
      source_ref: "issues:634",
      status: "done",
      updated_at: now,
      workflow_ref: "agent-execution-contract"
    }]
  };
}
