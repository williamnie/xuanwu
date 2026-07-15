import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import {
  WORK_STATE_TRANSITIONS,
  evaluateWorkTransition,
  validateAcceptanceContract,
  validateWorkLedger,
  type DependencyRelation,
  type WorkLedgerEntry,
  type WorkLedgerSnapshot,
  type WorkRelation,
  type WorkTransitionCommand
} from "./contracts.ts";

const NOW = "2026-07-16T00:00:00.000Z";
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const ADR_PATH = "docs/architecture/xuanwu/0011-work-ledger-domain-contract.md";

describe("Work Ledger domain contract", () => {
  test("defines complete provenance and a versioned acceptance contract", () => {
    const work = makeWork(647);
    expect(validateWorkLedger({ relations: [], works: [work] })).toEqual([]);
    expect(validateAcceptanceContract({
      ...work.acceptance,
      criteria: [...work.acceptance.criteria, work.acceptance.criteria[0]]
    })).toContain("duplicate acceptance criterion focused-tests");

    const legacy = makeWork(648, {
      provenance: {
        causes: [],
        origin: {
          authority: "issues",
          completeness: "legacy_incomplete",
          external_id: "648",
          kind: "issue",
          missing_fields: ["actor", "correlation_id"],
          occurred_at: NOW
        }
      }
    });
    expect(validateWorkLedger({ relations: [], works: [legacy] })).toEqual([]);
  });

  test("reuses the shared pure state table and rejects illegal transitions", () => {
    expect(WORK_STATE_TRANSITIONS.triage).toEqual(["todo", "cancelled"]);
    const snapshot = ledger([makeWork(647)]);
    expect(evaluateWorkTransition(snapshot, transition(647, "todo"))).toEqual({
      allowed: true,
      violations: []
    });

    snapshot.works[0].status = "done";
    const decision = evaluateWorkTransition(snapshot, transition(647, "in_progress"));
    expect(decision.allowed).toBe(false);
    expect(decision.violations).toContain("illegal Work transition done -> in_progress");
  });

  test("blocks execution until dependencies are done", () => {
    const dependent = makeWork(647, { status: "todo" });
    const prerequisite = makeWork(648, { status: "in_progress" });
    const relation = dependency(647, 648);
    const snapshot = ledger([dependent, prerequisite], [relation]);

    expect(evaluateWorkTransition(snapshot, transition(647, "in_progress")).violations)
      .toContain(`dependency ${prerequisite.id} is in_progress, not done`);
    prerequisite.status = "done";
    expect(evaluateWorkTransition(snapshot, transition(647, "in_progress"))).toMatchObject({ allowed: true });
  });

  test("requires every acceptance criterion, passed Evidence, and a ready Handoff before done", () => {
    const work = makeWork(647, { status: "pending_verification" });
    const snapshot = ledger([work]);
    const command = transition(647, "done", {
      acceptance: {
        contract_version: 1,
        evidence: [{
          criterion_ids: ["focused-tests"],
          id: makeDomainID("evidence", "issue_events", 9001),
          status: "passed",
          work_id: work.id
        }],
        handoffs: [{
          id: makeDomainID("handoff", "derived", "647@abc123"),
          status: "ready",
          work_id: work.id
        }]
      }
    });
    expect(evaluateWorkTransition(snapshot, command)).toEqual({ allowed: true, violations: [] });

    command.acceptance!.evidence[0].status = "failed";
    const rejected = evaluateWorkTransition(snapshot, command);
    expect(rejected.allowed).toBe(false);
    expect(rejected.violations).toEqual(expect.arrayContaining([
      "required acceptance criterion focused-tests lacks passed Evidence",
      "done requires passed Evidence"
    ]));
  });

  test("rejects circular dependencies and hierarchy cycles", () => {
    const works = [makeWork(647), makeWork(648), makeWork(649)];
    const relations: WorkRelation[] = [
      dependency(647, 648),
      dependency(648, 649),
      dependency(649, 647),
      parentChild(647, 648),
      parentChild(648, 647)
    ];
    expect(validateWorkLedger(ledger(works, relations))).toEqual(expect.arrayContaining([
      "dependency cycle detected",
      "parent/child cycle detected"
    ]));
  });

  test("requires deterministic permission and audit fields on every status change", () => {
    const snapshot = ledger([makeWork(647)]);
    const command = transition(647, "todo");
    command.audit.gate.decision = "ask";
    command.audit.reason = "";
    expect(evaluateWorkTransition(snapshot, command).violations).toEqual(expect.arrayContaining([
      "transition reason is required",
      "transition gate requires approval"
    ]));

    command.audit.gate.decision = "allow";
    command.audit.gate.authority = "llm" as WorkTransitionCommand["audit"]["gate"]["authority"];
    expect(evaluateWorkTransition(snapshot, command).violations)
      .toContain("transition gate authority is not trusted");
  });

  test("keeps a canonical contract and bounded migration path", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const heading of [
      "Work type", "状态转移表", "parent / child / dependency", "source / provenance", "acceptance contract"
    ]) expect(adr).toContain(heading);
    expect(adr).toContain("Action、Delegation、Completion Watch 不是 Work type");
    expect(adr).toContain("`issues`、`issue_events` 与现有 Issue API/state service");
    expect(adr).toContain("W1");
    expect(adr).toContain("W2");
    expect(adr).toContain("P11.05/P11.09");
    expect(adr).toContain("LLM 只能提出 transition proposal");
  });
});

function makeWork(id: number, patch: Partial<WorkLedgerEntry> = {}): WorkLedgerEntry {
  return {
    acceptance: {
      completion_rule: "all_required",
      criteria: [{
        description: "focused tests pass",
        id: "focused-tests",
        required: true,
        verification_policy_ref: "verification-policy:focused-tests"
      }],
      requires_handoff: true,
      version: 1
    },
    created_at: NOW,
    goal: `complete Work ${id}`,
    id: makeDomainID("work", "issues", id),
    owner: { kind: "project", project_id: "codex-issue-runner" },
    provenance: {
      causes: [],
      origin: {
        actor: { id: "user", kind: "user" },
        authority: "issues",
        completeness: "complete",
        correlation_id: `issue-${id}`,
        external_id: String(id),
        kind: "issue",
        occurred_at: NOW
      }
    },
    revision: 0,
    status: "triage",
    title: `Work ${id}`,
    type: "engineering_task",
    updated_at: NOW,
    workflow_ref: "agent-execution-contract",
    ...patch
  };
}

function ledger(works: WorkLedgerEntry[], relations: WorkRelation[] = []): WorkLedgerSnapshot {
  return { relations, works };
}

function dependency(workID: number, prerequisiteID: number): DependencyRelation {
  return {
    actor: { id: "planner", kind: "supervisor" },
    audit_event_ref: `work-event:dependency:${workID}:${prerequisiteID}`,
    correlation_id: `dependency:${workID}:${prerequisiteID}`,
    depends_on_work_id: makeDomainID("work", "issues", prerequisiteID),
    kind: "depends_on",
    occurred_at: NOW,
    reason: "declared roadmap prerequisite",
    relation_id: `dependency:${workID}:${prerequisiteID}`,
    work_id: makeDomainID("work", "issues", workID)
  };
}

function parentChild(parentID: number, childID: number): WorkRelation {
  return {
    actor: { id: "planner", kind: "supervisor" },
    audit_event_ref: `work-event:parent:${parentID}:${childID}`,
    child_work_id: makeDomainID("work", "issues", childID),
    correlation_id: `parent:${parentID}:${childID}`,
    kind: "parent_child",
    occurred_at: NOW,
    parent_work_id: makeDomainID("work", "issues", parentID),
    reason: "decompose objective",
    relation_id: `parent:${parentID}:${childID}`
  };
}

function transition(
  workID: number,
  to: WorkTransitionCommand["to"],
  patch: Partial<WorkTransitionCommand> = {}
): WorkTransitionCommand {
  return {
    audit: {
      actor: { id: "runner", kind: "runner" },
      correlation_id: `transition:${workID}:${to}`,
      event_id: `work-event:${workID}:${to}`,
      gate: {
        authority: "deterministic_policy",
        decision: "allow",
        policy_ref: "work-state-policy:v1"
      },
      occurred_at: NOW,
      reason: `move Work to ${to}`
    },
    expected_revision: 0,
    to,
    work_id: makeDomainID("work", "issues", workID),
    ...patch
  };
}
