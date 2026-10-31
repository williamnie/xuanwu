import type { RunnerDatabase } from "../database.ts";
import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import {
  type WorkLedgerEntry,
  type WorkLedgerSnapshot,
  type WorkRelation,
  type WorkTransitionGate
} from "../../domain/work/contracts.ts";
import { mapWork, mapRelation, mapEvent } from "./workLedgerMapping.ts";

export type WorkRow = {
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

export type WorkRelationRow = {
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

export type WorkEventRow = {
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

type WorkEventOutcome = "applied" | "rejected";

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
