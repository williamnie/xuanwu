import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import {
  getWork,
  getWorkEvent,
  listWorkEvents,
  listWorkRelations
} from "../../db/repositories/workLedger.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import type {
  DependencyRelation,
  WorkLedgerEntry,
  WorkTransitionAudit,
  WorkTransitionGate
} from "./contracts.ts";
import {
  WORK_EVENT_TYPES,
  addWorkRelation,
  claimWork,
  createWork,
  removeWorkRelation,
  transitionWork,
  updateWork,
  type CreateWorkCommand
} from "./service.ts";

const tempRoots: string[] = [];
const PROJECT_ID = "work-ledger-test";
const BASE_TIME = Date.parse("2026-07-16T01:00:00.000Z");
const ADR_PATH = resolve(import.meta.dir, "../../../../docs/architecture/xuanwu/0013-work-ledger-repository-service.md");

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

describe("Work Ledger repository service", () => {
  test("creates and updates Work with revision-consistent events in the same ledger", async () => {
    const db = await openFixtureDatabase();
    try {
      const created = createWork(db, {
        audit: audit("event-create-1", 0),
        work: workInput(1)
      });

      expect(created.applied).toBe(true);
      expect(getWork(db, workID(1))).toEqual(created.work);
      expect(created.event).toMatchObject({
        after_revision: 0,
        before_revision: 0,
        event_type: WORK_EVENT_TYPES.created,
        expected_revision: 0,
        outcome: "applied"
      });
      expect((created.event.payload.after as WorkLedgerEntry).title).toBe("Work 1");

      const updated = updateWork(db, {
        audit: audit("event-update-1", 1),
        expected_revision: 0,
        patch: { goal: "ship the repository service", title: "Repository service" },
        work_id: workID(1)
      });

      expect(updated.applied).toBe(true);
      expect(updated.work).toMatchObject({
        goal: "ship the repository service",
        revision: 1,
        title: "Repository service"
      });
      expect(updated.event).toMatchObject({
        after_revision: 1,
        before_revision: 0,
        event_type: WORK_EVENT_TYPES.updated,
        expected_revision: 0,
        outcome: "applied"
      });
      expect((updated.event.payload.before as WorkLedgerEntry).title).toBe("Work 1");
      expect((updated.event.payload.after as WorkLedgerEntry).title).toBe("Repository service");

      const replay = updateWork(db, {
        audit: audit("event-update-1", 1),
        expected_revision: 0,
        patch: { goal: "ship the repository service", title: "Repository service" },
        work_id: workID(1)
      });
      expect(replay.applied).toBe(true);
      expect(replay.work.revision).toBe(1);
      expect(() => updateWork(db, {
        audit: audit("event-update-1", 1),
        expected_revision: 0,
        patch: { title: "different command" },
        work_id: workID(1)
      })).toThrow("already bound to another mutation");
      expect(listWorkEvents(db, workID(1))).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  test("allows only one claim across database connections and audits the stale precondition", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const first = await openDatabase({ stateDir });
    insertProject(first);
    const second = await openDatabase({ stateDir });
    try {
      createWork(first, {
        audit: audit("event-create-claim", 0),
        work: workInput("claim", { status: "todo" })
      });

      const firstClaim = claimWork(first, {
        audit: audit("event-claim-first", 1),
        expected_revision: 0,
        work_id: workID("claim")
      });
      const staleClaim = claimWork(second, {
        audit: audit("event-claim-stale", 2),
        expected_revision: 0,
        work_id: workID("claim")
      });

      expect(firstClaim).toMatchObject({ applied: true, work: { revision: 1, status: "in_progress" } });
      expect(staleClaim).toMatchObject({
        applied: false,
        event: { after_revision: 1, before_revision: 1, expected_revision: 0, outcome: "rejected" },
        work: { revision: 1, status: "in_progress" }
      });
      expect(staleClaim.violations).toContain("expected revision 0 does not match 1");
      expect(listWorkEvents(first, workID("claim")).map((event) => event.outcome))
        .toEqual(["applied", "applied", "rejected"]);
    } finally {
      second.close();
      first.close();
    }
  });

  test("applies and removes relations atomically while dependency and cycle gates fail closed", async () => {
    const db = await openFixtureDatabase();
    try {
      createWork(db, {
        audit: audit("event-create-dependent", 0),
        work: workInput("dependent", { status: "todo" })
      });
      createWork(db, {
        audit: audit("event-create-prerequisite", 1),
        work: workInput("prerequisite", { status: "in_progress" })
      });

      const relation = dependency("dependent", "prerequisite", "event-relation-add", 2);
      const added = addWorkRelation(db, {
        expected_revision: 0,
        gate: allowGate(),
        relation
      });
      expect(added).toMatchObject({ applied: true, work: { revision: 1 } });
      expect(listWorkRelations(db, PROJECT_ID)).toEqual([relation]);

      const blockedClaim = claimWork(db, {
        audit: audit("event-claim-blocked", 3),
        expected_revision: 1,
        work_id: workID("dependent")
      });
      expect(blockedClaim.applied).toBe(false);
      expect(blockedClaim.violations).toContain(
        `dependency ${workID("prerequisite")} is in_progress, not done`
      );

      const reverse = dependency("prerequisite", "dependent", "event-relation-cycle", 4);
      const cycle = addWorkRelation(db, {
        expected_revision: 0,
        gate: allowGate(),
        relation: reverse
      });
      expect(cycle.applied).toBe(false);
      expect(cycle.violations).toContain("dependency cycle detected");
      expect(listWorkRelations(db, PROJECT_ID)).toEqual([relation]);

      const removed = removeWorkRelation(db, {
        audit: audit("event-relation-remove", 5),
        expected_revision: 1,
        relation_id: relation.relation_id,
        work_id: workID("dependent")
      });
      expect(removed).toMatchObject({ applied: true, work: { revision: 2 } });
      expect(listWorkRelations(db, PROJECT_ID)).toEqual([]);
      expect(getWorkEvent(db, "event-relation-remove")).toMatchObject({
        after_revision: 2,
        before_revision: 1,
        event_type: WORK_EVENT_TYPES.relationRemoved,
        outcome: "applied"
      });
    } finally {
      db.close();
    }
  });

  test("rolls back the Work row when event append fails", async () => {
    const db = await openFixtureDatabase();
    try {
      createWork(db, {
        audit: audit("event-create-rollback", 0),
        work: workInput("rollback")
      });
      db.sqlite.run(`create trigger reject_work_updated_event
        before insert on work_events
        when new.event_type = 'work_ledger.work_updated.v1'
        begin
          select raise(abort, 'event append fixture failure');
        end`);

      expect(() => updateWork(db, {
        audit: audit("event-update-rollback", 1),
        expected_revision: 0,
        patch: { title: "must roll back" },
        work_id: workID("rollback")
      })).toThrow("event append fixture failure");

      expect(getWork(db, workID("rollback"))).toMatchObject({ revision: 0, title: "Work rollback" });
      expect(getWorkEvent(db, "event-update-rollback")).toBeNull();
    } finally {
      db.close();
    }
  });

  test("rejects an unapproved update without changing revision and records the migration boundary", async () => {
    const db = await openFixtureDatabase();
    try {
      createWork(db, {
        audit: audit("event-create-gate", 0),
        work: workInput("gate")
      });
      const deniedAudit = audit("event-update-gate", 1);
      deniedAudit.gate = { ...deniedAudit.gate, decision: "ask" };

      const denied = updateWork(db, {
        audit: deniedAudit,
        expected_revision: 0,
        patch: { title: "not approved" },
        work_id: workID("gate")
      });

      expect(denied).toMatchObject({
        applied: false,
        event: { after_revision: 0, before_revision: 0, outcome: "rejected" },
        work: { revision: 0, title: "Work gate" }
      });
      expect(denied.violations).toContain("mutation gate requires approval");

      const note = readFileSync(ADR_PATH, "utf8");
      expect(note).toContain("仍是 W0 唯一运行态读写 authority");
      expect(note).toContain("W1 仍最多一个正式 release");
      expect(note).toContain("P02.04/P02.06 必须复用本 service");
    } finally {
      db.close();
    }
  });

  test("completes from the canonical in-progress state without caller-supplied artifact claims", async () => {
    const db = await openFixtureDatabase();
    try {
      createWork(db, {
        audit: audit("event-create-done", 0),
        work: workInput("done", { status: "in_progress" })
      });
      const acceptance = acceptanceProjection(workID("done"));
      const callerClaim = {
        acceptance,
        audit: audit("event-done-untrusted", 1),
        expected_revision: 0,
        to: "done" as const,
        work_id: workID("done")
      };

      const completed = transitionWork(db, {
        ...callerClaim,
        audit: audit("event-done", 2),
        expected_revision: 0,
        to: "done",
        work_id: workID("done")
      });
      expect(completed).toMatchObject({ applied: true, work: { revision: 1, status: "done" } });
    } finally {
      db.close();
    }
  });
});

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await tempRoot();
  const db = await openDatabase({ stateDir: join(root, "state") });
  insertProject(db);
  return db;
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-work-service-"));
  tempRoots.push(root);
  return root;
}

function insertProject(db: RunnerDatabase): void {
  const timestamp = new Date(BASE_TIME).toISOString();
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values (?, ?, ?, ?, ?)`, [PROJECT_ID, "Work Ledger Test", "/tmp", timestamp, timestamp]);
}

function workInput(
  id: string | number,
  patch: Partial<CreateWorkCommand["work"]> = {}
): CreateWorkCommand["work"] {
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
    goal: `complete Work ${id}`,
    id: workID(id),
    owner: { kind: "project", project_id: PROJECT_ID },
    provenance: {
      causes: [],
      origin: {
        actor: { id: "user", kind: "user" },
        authority: "issues",
        completeness: "complete",
        correlation_id: `issue-${id}`,
        external_id: String(id),
        kind: "issue",
        occurred_at: new Date(BASE_TIME).toISOString()
      }
    },
    status: "triage",
    title: `Work ${id}`,
    type: "engineering_task",
    workflow_ref: "agent-execution-contract",
    ...patch
  };
}

function workID(id: string | number): WorkLedgerEntry["id"] {
  return makeDomainID("work", "issues", id);
}

function audit(eventID: string, seconds: number): WorkTransitionAudit {
  return {
    actor: { id: "runner", kind: "runner" },
    correlation_id: `correlation:${eventID}`,
    event_id: eventID,
    gate: allowGate(),
    occurred_at: new Date(BASE_TIME + seconds * 1000).toISOString(),
    reason: `apply ${eventID}`
  };
}

function allowGate(): WorkTransitionGate {
  return {
    authority: "deterministic_policy",
    decision: "allow",
    policy_ref: "work-policy:v1"
  };
}

function dependency(
  source: string,
  target: string,
  eventID: string,
  seconds: number
): DependencyRelation {
  const eventAudit = audit(eventID, seconds);
  return {
    actor: eventAudit.actor,
    audit_event_ref: eventID,
    correlation_id: eventAudit.correlation_id,
    depends_on_work_id: workID(target),
    kind: "depends_on",
    occurred_at: eventAudit.occurred_at,
    reason: eventAudit.reason,
    relation_id: `dependency:${source}:${target}`,
    work_id: workID(source)
  };
}

function acceptanceProjection(work_id: WorkLedgerEntry["id"]) {
  return {
    contract_version: 1,
    evidence: [{
      criterion_ids: ["focused-tests"],
      id: makeDomainID("evidence", "issue_events", "done-test"),
      status: "passed" as const,
      work_id
    }],
    handoffs: [{
      id: makeDomainID("handoff", "derived", "done-test"),
      status: "ready" as const,
      work_id
    }]
  };
}
