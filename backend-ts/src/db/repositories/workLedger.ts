import type { RunnerDatabase } from "../database.ts";
import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import {
  validateWorkLedger,
  type WorkAcceptanceContract,
  type WorkLedgerEntry,
  type WorkLedgerSnapshot,
  type WorkProvenance,
  type WorkRelation,
  type WorkTransitionGate
} from "../../domain/work/contracts.ts";

type WorkRow = {
  acceptance_json: unknown;
  created_at: unknown;
  goal: unknown;
  id: unknown;
  project_id: unknown;
  provenance_json: unknown;
  revision: unknown;
  status: unknown;
  title: unknown;
  type: unknown;
  updated_at: unknown;
  workflow_ref: unknown;
};

type WorkRelationRow = {
  actor_json: unknown;
  audit_event_ref: unknown;
  correlation_id: unknown;
  kind: unknown;
  occurred_at: unknown;
  reason: unknown;
  relation_id: unknown;
  source_work_id: unknown;
  target_work_id: unknown;
};

type WorkEventRow = {
  actor_json: unknown;
  after_revision: unknown;
  before_revision: unknown;
  correlation_id: unknown;
  created_at: unknown;
  event_id: unknown;
  event_type: unknown;
  expected_revision: unknown;
  gate_authority: unknown;
  gate_decision: unknown;
  gate_policy_ref: unknown;
  occurred_at: unknown;
  outcome: unknown;
  payload_json: unknown;
  project_id: unknown;
  reason: unknown;
  work_id: unknown;
};

export type WorkEventOutcome = "applied" | "rejected";

export type WorkEvent = {
  actor: DomainActor;
  after_revision: number;
  before_revision: number;
  correlation_id: string;
  created_at: string;
  event_id: string;
  event_type: string;
  expected_revision: number;
  gate: WorkTransitionGate;
  occurred_at: string;
  outcome: WorkEventOutcome;
  payload: Record<string, unknown>;
  project_id: string;
  reason: string;
  work_id: WorkLedgerEntry["id"];
};

export type WorkEventWrite = Omit<WorkEvent, "created_at">;

const WORK_COLUMNS = `id, project_id, type, title, goal, status, acceptance_json,
  provenance_json, workflow_ref, revision, created_at, updated_at`;
const RELATION_COLUMNS = `relation_id, kind, source_work_id, target_work_id,
  actor_json, reason, correlation_id, audit_event_ref, occurred_at`;
const EVENT_COLUMNS = `event_id, work_id, project_id, event_type, actor_json, reason,
  correlation_id, gate_authority, gate_decision, gate_policy_ref, expected_revision,
  before_revision, after_revision, outcome, payload_json, occurred_at, created_at`;

export function getWork(db: RunnerDatabase, id: WorkLedgerEntry["id"]): WorkLedgerEntry | null {
  const row = db.sqlite.query<WorkRow, [string]>(
    `select ${WORK_COLUMNS} from works where id=?`
  ).get(id);
  return row ? mapWork(row) : null;
}

export function listWorks(
  db: RunnerDatabase,
  filter: { project_id?: string; status?: WorkLedgerEntry["status"] } = {}
): WorkLedgerEntry[] {
  if (filter.project_id && filter.status) {
    return db.sqlite.query<WorkRow, [string, string]>(`
      select ${WORK_COLUMNS} from works where project_id=? and status=?
      order by updated_at desc, id asc
    `).all(filter.project_id, filter.status).map(mapWork);
  }
  if (filter.project_id) {
    return db.sqlite.query<WorkRow, [string]>(`
      select ${WORK_COLUMNS} from works where project_id=? order by updated_at desc, id asc
    `).all(filter.project_id).map(mapWork);
  }
  if (filter.status) {
    return db.sqlite.query<WorkRow, [string]>(`
      select ${WORK_COLUMNS} from works where status=? order by updated_at desc, id asc
    `).all(filter.status).map(mapWork);
  }
  return db.sqlite.query<WorkRow, []>(`
    select ${WORK_COLUMNS} from works order by updated_at desc, id asc
  `).all().map(mapWork);
}

export function getWorkRelation(db: RunnerDatabase, relationID: string): WorkRelation | null {
  const row = db.sqlite.query<WorkRelationRow, [string]>(
    `select ${RELATION_COLUMNS} from work_relations where relation_id=?`
  ).get(relationID);
  return row ? mapRelation(row) : null;
}

export function listWorkRelations(db: RunnerDatabase, projectID: string): WorkRelation[] {
  return db.sqlite.query<WorkRelationRow, [string]>(`
    select ${RELATION_COLUMNS} from work_relations where project_id=?
    order by kind asc, source_work_id asc, target_work_id asc, relation_id asc
  `).all(projectID).map(mapRelation);
}

export function readWorkLedgerSnapshot(db: RunnerDatabase, projectID: string): WorkLedgerSnapshot {
  return {
    relations: listWorkRelations(db, projectID),
    works: listWorks(db, { project_id: projectID })
  };
}

export function getWorkEvent(db: RunnerDatabase, eventID: string): WorkEvent | null {
  const row = db.sqlite.query<WorkEventRow, [string]>(
    `select ${EVENT_COLUMNS} from work_events where event_id=?`
  ).get(eventID);
  return row ? mapEvent(row) : null;
}

export function listWorkEvents(db: RunnerDatabase, workID: WorkLedgerEntry["id"]): WorkEvent[] {
  return db.sqlite.query<WorkEventRow, [string]>(`
    select ${EVENT_COLUMNS} from work_events where work_id=?
    order by occurred_at asc, event_id asc
  `).all(workID).map(mapEvent);
}

export function insertWorkRecord(db: RunnerDatabase, work: WorkLedgerEntry): void {
  db.sqlite.run(`insert into works
    (id, project_id, type, title, goal, status, acceptance_json, provenance_json,
     workflow_ref, revision, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    work.id, work.owner.project_id, work.type, work.title, work.goal, work.status,
    JSON.stringify(work.acceptance), JSON.stringify(work.provenance), work.workflow_ref,
    work.revision, work.created_at, work.updated_at
  ]);
}

export function compareAndSetWorkRecord(
  db: RunnerDatabase,
  work: WorkLedgerEntry,
  expectedRevision: number
): boolean {
  const result = db.sqlite.run(`update works set
    type=?, title=?, goal=?, status=?, acceptance_json=?, provenance_json=?,
    workflow_ref=?, revision=?, updated_at=?
    where id=? and project_id=? and revision=?`, [
    work.type, work.title, work.goal, work.status, JSON.stringify(work.acceptance),
    JSON.stringify(work.provenance), work.workflow_ref, work.revision, work.updated_at,
    work.id, work.owner.project_id, expectedRevision
  ]);
  return result.changes === 1;
}

export function insertWorkRelationRecord(
  db: RunnerDatabase,
  projectID: string,
  relation: WorkRelation
): void {
  const [sourceWorkID, targetWorkID] = relation.kind === "parent_child"
    ? [relation.parent_work_id, relation.child_work_id]
    : [relation.work_id, relation.depends_on_work_id];
  db.sqlite.run(`insert into work_relations
    (relation_id, project_id, kind, source_work_id, target_work_id, actor_json,
     reason, correlation_id, audit_event_ref, occurred_at, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    relation.relation_id, projectID, relation.kind, sourceWorkID, targetWorkID,
    JSON.stringify(relation.actor), relation.reason, relation.correlation_id,
    relation.audit_event_ref, relation.occurred_at, relation.occurred_at, relation.occurred_at
  ]);
}

export function deleteWorkRelationRecord(db: RunnerDatabase, relationID: string): boolean {
  return db.sqlite.run("delete from work_relations where relation_id=?", [relationID]).changes === 1;
}

export function appendWorkEvent(db: RunnerDatabase, event: WorkEventWrite): void {
  db.sqlite.run(`insert into work_events
    (event_id, work_id, project_id, event_type, actor_json, reason, correlation_id,
     gate_authority, gate_decision, gate_policy_ref, expected_revision, before_revision,
     after_revision, outcome, payload_json, occurred_at, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    event.event_id, event.work_id, event.project_id, event.event_type,
    JSON.stringify(event.actor), event.reason, event.correlation_id,
    event.gate.authority, event.gate.decision, event.gate.policy_ref,
    event.expected_revision, event.before_revision, event.after_revision,
    event.outcome, JSON.stringify(event.payload), event.occurred_at, event.occurred_at
  ]);
}

function mapWork(row: WorkRow): WorkLedgerEntry {
  const work: WorkLedgerEntry = {
    acceptance: jsonObject<WorkAcceptanceContract>(row.acceptance_json, "works.acceptance_json"),
    created_at: requiredString(row.created_at, "works.created_at"),
    goal: requiredString(row.goal, "works.goal"),
    id: requiredString(row.id, "works.id") as WorkLedgerEntry["id"],
    owner: { kind: "project", project_id: requiredString(row.project_id, "works.project_id") },
    provenance: jsonObject<WorkProvenance>(row.provenance_json, "works.provenance_json"),
    revision: nonNegativeInteger(row.revision, "works.revision"),
    status: requiredString(row.status, "works.status") as WorkLedgerEntry["status"],
    title: requiredString(row.title, "works.title"),
    type: requiredString(row.type, "works.type") as WorkLedgerEntry["type"],
    updated_at: requiredString(row.updated_at, "works.updated_at"),
    workflow_ref: requiredString(row.workflow_ref, "works.workflow_ref")
  };
  let violations: string[];
  try {
    violations = validateWorkLedger({ relations: [], works: [work] });
  } catch (error) {
    throw new Error(`invalid Work row ${work.id}: ${errorMessage(error)}`);
  }
  if (violations.length > 0) throw new Error(`invalid Work row ${work.id}: ${violations.join("; ")}`);
  return work;
}

function mapRelation(row: WorkRelationRow): WorkRelation {
  const common = {
    actor: domainActor(row.actor_json, "work_relations.actor_json"),
    audit_event_ref: requiredString(row.audit_event_ref, "work_relations.audit_event_ref"),
    correlation_id: requiredString(row.correlation_id, "work_relations.correlation_id"),
    occurred_at: requiredString(row.occurred_at, "work_relations.occurred_at"),
    reason: requiredString(row.reason, "work_relations.reason"),
    relation_id: requiredString(row.relation_id, "work_relations.relation_id")
  };
  const kind = requiredString(row.kind, "work_relations.kind");
  const source = requiredString(row.source_work_id, "work_relations.source_work_id") as WorkLedgerEntry["id"];
  const target = requiredString(row.target_work_id, "work_relations.target_work_id") as WorkLedgerEntry["id"];
  if (kind === "parent_child") {
    return { ...common, child_work_id: target, kind, parent_work_id: source };
  }
  if (kind === "depends_on") {
    return { ...common, depends_on_work_id: target, kind, work_id: source };
  }
  throw new Error(`work_relations.kind has unsupported value ${kind}`);
}

function mapEvent(row: WorkEventRow): WorkEvent {
  const outcome = requiredString(row.outcome, "work_events.outcome");
  if (outcome !== "applied" && outcome !== "rejected") {
    throw new Error(`work_events.outcome has unsupported value ${outcome}`);
  }
  const authority = requiredString(row.gate_authority, "work_events.gate_authority");
  const decision = requiredString(row.gate_decision, "work_events.gate_decision");
  if (authority !== "deterministic_policy" && authority !== "human_approval") {
    throw new Error(`work_events.gate_authority has unsupported value ${authority}`);
  }
  if (decision !== "allow" && decision !== "deny" && decision !== "ask") {
    throw new Error(`work_events.gate_decision has unsupported value ${decision}`);
  }
  return {
    actor: domainActor(row.actor_json, "work_events.actor_json"),
    after_revision: nonNegativeInteger(row.after_revision, "work_events.after_revision"),
    before_revision: nonNegativeInteger(row.before_revision, "work_events.before_revision"),
    correlation_id: requiredString(row.correlation_id, "work_events.correlation_id"),
    created_at: requiredString(row.created_at, "work_events.created_at"),
    event_id: requiredString(row.event_id, "work_events.event_id"),
    event_type: requiredString(row.event_type, "work_events.event_type"),
    expected_revision: nonNegativeInteger(row.expected_revision, "work_events.expected_revision"),
    gate: {
      authority,
      decision,
      policy_ref: requiredString(row.gate_policy_ref, "work_events.gate_policy_ref")
    },
    occurred_at: requiredString(row.occurred_at, "work_events.occurred_at"),
    outcome,
    payload: jsonObject<Record<string, unknown>>(row.payload_json, "work_events.payload_json"),
    project_id: requiredString(row.project_id, "work_events.project_id"),
    reason: requiredString(row.reason, "work_events.reason"),
    work_id: requiredString(row.work_id, "work_events.work_id") as WorkLedgerEntry["id"]
  };
}

function jsonObject<T extends object>(value: unknown, field: string): T {
  const text = requiredString(value, field);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${field} is not valid JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${field} must be a JSON object`);
  }
  return parsed as T;
}

function domainActor(value: unknown, field: string): DomainActor {
  const actor = jsonObject<Record<string, unknown>>(value, field);
  const kind = requiredString(actor.kind, `${field}.kind`);
  if (!["user", "supervisor", "runner", "guardian", "automation", "system"].includes(kind)) {
    throw new Error(`${field}.kind has unsupported value ${kind}`);
  }
  return {
    id: requiredString(actor.id, `${field}.id`),
    kind: kind as DomainActor["kind"]
  };
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} is required`);
  return value;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
