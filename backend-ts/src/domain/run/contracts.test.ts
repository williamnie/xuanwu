import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import {
  ATTEMPT_STATE_TRANSITIONS,
  RUN_STATE_TRANSITIONS,
  aggregateRunCost,
  emptyRunCost,
  evaluateAttemptTransition,
  evaluateRunTransition,
  makeRunAttemptID,
  mapLegacyIssueRunStatus,
  providerAttemptRef,
  validateRunLifecycle,
  type AttemptStatus,
  type RunAttempt,
  type RunCost,
  type RunLedgerEntry,
  type RunLifecycleSnapshot,
  type RunStatus,
  type RunTransitionAudit,
  type RunWorkRelation
} from "./contracts.ts";

const NOW = "2026-07-16T05:00:00.000Z";
const LATER = "2026-07-16T05:01:00.000Z";
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const ADR_PATH = "docs/architecture/xuanwu/0020-run-attempt-lifecycle-contract.md";

describe("Run / Attempt lifecycle contract", () => {
  test("reuses the P00.04 Run state machine and evaluates lifecycle transitions as pure functions", () => {
    expect(RUN_STATE_TRANSITIONS.running).toEqual(["recovering", "succeeded", "failed", "cancelled"]);
    expect(ATTEMPT_STATE_TRANSITIONS.running).toEqual(["succeeded", "failed", "interrupted"]);

    const createdAttempt = attempt("created");
    const created = lifecycle("created", [createdAttempt]);
    expect(evaluateRunTransition(created, runTransition(created, "running"))).toEqual({ allowed: true, violations: [] });
    expect(evaluateAttemptTransition(created, attemptTransition(created, createdAttempt, "running")))
      .toEqual({ allowed: true, violations: [] });
    expect(evaluateRunTransition(created, runTransition(created, "succeeded")).violations)
      .toContain("illegal Run transition created -> succeeded");
  });

  test("models initial, recovery, and resume provider invocations as Attempts under one Run", () => {
    const failed = attempt("failed");
    const recovering = lifecycle("running", [failed]);
    expect(evaluateRunTransition(recovering, runTransition(recovering, "recovering"))).toEqual({
      allowed: true,
      violations: []
    });

    recovering.run.status = "recovering";
    const recovery = attempt("created", 2, "recovery");
    recovering.attempts.push(recovery);
    recovering.run.cost = aggregateRunCost(recovering.attempts);
    expect(validateRunLifecycle(recovering)).toEqual([]);
    expect(evaluateAttemptTransition(recovering, attemptTransition(recovering, recovery, "running")))
      .toEqual({ allowed: true, violations: [] });

    recovery.kind = "initial";
    expect(validateRunLifecycle(recovering)).toContain(`${recovery.id} only the first Attempt can be initial`);
  });

  test("maps current Codex and Claude provider refs without making sessions the Run identity", () => {
    expect(providerAttemptRef({
      provider: "codex",
      provider_run_id: "codex:thread-656:turn-1",
      provider_session_id: "thread-656",
      provider_turn_id: "turn-1"
    })).toEqual({
      invocation_ref: "codex:thread-656:turn-1",
      observation_ref: "codex:thread-656",
      provider: "codex",
      session_ref: "thread-656",
      turn_ref: "turn-1"
    });
    expect(providerAttemptRef({
      provider: "claude",
      provider_run_id: "cli:claude:656",
      provider_session_id: "session-656",
      provider_turn_id: "result-uuid-1"
    })).toEqual({
      invocation_ref: "cli:claude:656",
      observation_ref: "claude:session-656",
      provider: "claude",
      session_ref: "session-656",
      turn_ref: "result-uuid-1"
    });
    expect(() => providerAttemptRef({
      provider: "claude",
      provider_run_id: "cli:claude:656",
      provider_turn_id: "result-without-session"
    })).toThrow("provider turn requires a session ref");
    expect(mapLegacyIssueRunStatus("in_progress")).toBe("running");
    expect(() => mapLegacyIssueRunStatus("pending_verification")).toThrow("unsupported legacy issue_run status");
    expect(() => mapLegacyIssueRunStatus("done")).toThrow("unsupported legacy issue_run status");
  });

  test("enforces terminal invariants and forbids transitions out of terminal states", () => {
    const succeededAttempt = attempt("succeeded");
    const running = lifecycle("running", [succeededAttempt]);
    expect(evaluateRunTransition(running, runTransition(running, "succeeded"))).toEqual({
      allowed: true,
      violations: []
    });

    const succeeded = lifecycle("succeeded", [succeededAttempt]);
    expect(validateRunLifecycle(succeeded)).toEqual([]);
    expect(evaluateRunTransition(succeeded, runTransition(succeeded, "failed")).violations)
      .toContain("illegal Run transition succeeded -> failed");

    succeeded.attempts[0] = attempt("running");
    succeeded.run.cost = aggregateRunCost(succeeded.attempts);
    expect(validateRunLifecycle(succeeded)).toEqual(expect.arrayContaining([
      `${succeeded.run.id} terminal Run cannot contain a live Attempt`,
      `${succeeded.run.id} succeeded Run requires the latest Attempt to succeed`
    ]));

    const missingTerminal = lifecycle("failed", [attempt("failed")]);
    delete missingTerminal.run.terminal;
    delete missingTerminal.run.ended_at;
    expect(validateRunLifecycle(missingTerminal)).toEqual(expect.arrayContaining([
      `${missingTerminal.run.id} Run terminal status requires ended_at`,
      `${missingTerminal.run.id} Run terminal status requires terminal record`
    ]));
  });

  test("requires immutable Work ownership and a deterministic permission gate", () => {
    const current = lifecycle("created", [attempt("created")]);
    current.relation.work_id = makeDomainID("work", "issues", 999);
    expect(validateRunLifecycle(current)).toContain(`${current.run.id} relation references another Work`);

    current.relation.work_id = current.run.work_id;
    const command = runTransition(current, "running");
    command.audit.gate.decision = "ask";
    expect(evaluateRunTransition(current, command).violations).toContain("transition gate requires approval");
    command.audit.gate.decision = "allow";
    command.audit.gate.authority = "llm" as RunTransitionAudit["gate"]["authority"];
    expect(evaluateRunTransition(current, command).violations).toContain("transition gate authority is not trusted");
  });

  test("aggregates token and monetary cost from Attempt facts without inventing unavailable values", () => {
    const first = attempt("succeeded", 1, "initial", measuredCost(100, 20, 40, 5, 1000));
    const second = attempt("succeeded", 2, "resume", measuredCost(50, 10, 10, 2, 500));
    const aggregate = aggregateRunCost([first, second]);
    expect(aggregate).toMatchObject({
      money: { amount_micros: 1500, basis: "provider_reported", currency: "USD" },
      usage: {
        cached_input_tokens: 50,
        completeness: "complete",
        input_tokens: 150,
        output_tokens: 30,
        reasoning_output_tokens: 7,
        total_tokens: 180
      }
    });

    const current = lifecycle("succeeded", [first, second]);
    expect(validateRunLifecycle(current)).toEqual([]);
    current.run.cost.usage.total_tokens = 999;
    expect(validateRunLifecycle(current)).toContain(`${current.run.id} cost must equal the deterministic Attempt aggregate`);
    expect(aggregateRunCost([])).toEqual(emptyRunCost());
  });

  test("keeps canonical authority, migration windows, rollback, and provider mapping documented", () => {
    const adr = readFileSync(resolve(REPO_ROOT, ADR_PATH), "utf8");
    for (const heading of [
      "Run / Attempt identity",
      "状态机",
      "Codex / Claude provider refs",
      "terminal rules",
      "cost fields"
    ]) expect(adr).toContain(heading);
    expect(adr).toContain("`issue_runs` 是唯一 Run authority");
    expect(adr).toContain("`agent_sessions` 与 provider session 只提供 observation / drill-down");
    expect(adr).toContain("双写窗口为 0");
    expect(adr).toContain("P11.05");
    expect(adr).toContain("LLM 只能提出 lifecycle transition proposal");
  });
});

function lifecycle(status: RunStatus, attempts: RunAttempt[]): RunLifecycleSnapshot {
  const id = makeDomainID("run", "issue_runs", "issue:656/run:1");
  const workID = makeDomainID("work", "issues", 656);
  const run: RunLedgerEntry = {
    cost: aggregateRunCost(attempts),
    created_at: NOW,
    id,
    provider: "codex",
    revision: 0,
    sequence: 1,
    status,
    trigger: "initial",
    updated_at: LATER,
    work_id: workID,
    ...(status === "created" ? {} : { started_at: NOW }),
    ...(isTerminalStatus(status) ? {
      ended_at: LATER,
      terminal: { reason: `Run ${status}`, source_ref: `issue_runs:${id}` }
    } : {})
  };
  const relation: RunWorkRelation = {
    actor: { id: "runner", kind: "runner" },
    audit_event_ref: "issue-event:656:run-created",
    correlation_id: "issue-656-run-1",
    kind: "executes",
    occurred_at: NOW,
    reason: "claim Work for execution",
    run_id: id,
    work_id: workID
  };
  return {
    attempts: attempts.map((item) => ({
      ...item,
      id: makeRunAttemptID(id, item.sequence),
      provider_ref: { ...item.provider_ref },
      run_id: id
    })),
    relation,
    run
  };
}

function attempt(
  status: AttemptStatus,
  sequence = 1,
  kind: RunAttempt["kind"] = "initial",
  cost: RunCost = emptyRunCost()
): RunAttempt {
  const runID = makeDomainID("run", "issue_runs", "issue:656/run:1");
  return {
    cost,
    created_at: NOW,
    id: makeRunAttemptID(runID, sequence),
    kind,
    provider_ref: {
      invocation_ref: status === "created" ? "" : `codex:thread-656:turn-${sequence}`,
      observation_ref: "codex:thread-656",
      provider: "codex",
      session_ref: "thread-656",
      ...(status === "created" ? {} : { turn_ref: `turn-${sequence}` })
    },
    revision: 0,
    run_id: runID,
    sequence,
    status,
    updated_at: LATER,
    ...(status === "created" ? {} : { started_at: NOW }),
    ...(isAttemptTerminalStatus(status) ? {
      ended_at: LATER,
      terminal: { reason: `Attempt ${status}`, source_ref: `provider-event:turn-${sequence}:${status}` }
    } : {})
  };
}

function measuredCost(input: number, output: number, cached: number, reasoning: number, amount: number): RunCost {
  return {
    money: { amount_micros: amount, basis: "provider_reported", currency: "USD" },
    pricing_refs: [],
    source_refs: [`provider-usage:${input}:${output}`],
    usage: {
      cached_input_tokens: cached,
      completeness: "complete",
      input_tokens: input,
      output_tokens: output,
      reasoning_output_tokens: reasoning,
      total_tokens: input + output
    }
  };
}

function audit(): RunTransitionAudit {
  return {
    actor: { id: "runner", kind: "runner" },
    correlation_id: "issue-656-transition",
    event_id: "run-event:656:transition",
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: "run-lifecycle:v1" },
    occurred_at: LATER,
    reason: "advance lifecycle"
  };
}

function runTransition(snapshot: RunLifecycleSnapshot, to: RunStatus) {
  return { audit: audit(), expected_revision: snapshot.run.revision, run_id: snapshot.run.id, to };
}

function attemptTransition(snapshot: RunLifecycleSnapshot, current: RunAttempt, to: AttemptStatus) {
  return {
    attempt_id: makeRunAttemptID(snapshot.run.id, current.sequence),
    audit: audit(),
    expected_revision: current.revision,
    run_id: snapshot.run.id,
    to
  };
}

function isTerminalStatus(status: RunStatus): boolean {
  return ["succeeded", "failed", "cancelled"].includes(status);
}

function isAttemptTerminalStatus(status: AttemptStatus): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(status);
}
