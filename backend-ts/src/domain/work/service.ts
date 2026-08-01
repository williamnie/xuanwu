import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import {
  appendWorkEvent,
  compareAndSetWorkRecord,
  deleteWorkRelationRecord,
  getWork,
  getWorkEvent,
  getWorkRelation,
  insertWorkRecord,
  insertWorkRelationRecord,
  readWorkLedgerSnapshot,
  type WorkEvent,
  type WorkEventWrite
} from "../../db/repositories/workLedger.ts";
import {
  evaluateWorkTransition,
  validateWorkLedger,
  type WorkLedgerEntry,
  type WorkRelation,
  type WorkTransitionAudit,
  type WorkTransitionCommand,
  type WorkTransitionGate
} from "./contracts.ts";

export const WORK_EVENT_TYPES = {
  created: "work.created.v1",
  relationAdded: "work_ledger.relation_added.v1",
  relationRemoved: "work_ledger.relation_removed.v1",
  statusChanged: "work.status_changed.v1",
  updated: "work_ledger.work_updated.v1"
} as const;

export type WorkMutationResult = {
  applied: boolean;
  event: WorkEvent;
  relation?: WorkRelation;
  violations: string[];
  work: WorkLedgerEntry;
};

export type CreateWorkCommand = {
  audit: WorkTransitionAudit;
  work: Omit<WorkLedgerEntry, "created_at" | "revision" | "updated_at">;
};

export type WorkUpdatePatch = Partial<Pick<
  WorkLedgerEntry,
  "acceptance" | "goal" | "provenance" | "title" | "type" | "workflow_ref"
>>;

export type UpdateWorkCommand = {
  audit: WorkTransitionAudit;
  expected_revision: number;
  patch: WorkUpdatePatch;
  work_id: WorkLedgerEntry["id"];
};

export type AddWorkRelationCommand = {
  expected_revision: number;
  gate: WorkTransitionGate;
  relation: WorkRelation;
};

export type RemoveWorkRelationCommand = {
  audit: WorkTransitionAudit;
  expected_revision: number;
  relation_id: string;
  work_id: WorkLedgerEntry["id"];
};

export type TransitionWorkCommand = WorkTransitionCommand;

export type ClaimWorkCommand = Omit<TransitionWorkCommand, "to">;

export class WorkNotFoundError extends Error {
  constructor(id: string) {
    super(`Work ${id} not found`);
    this.name = "WorkNotFoundError";
  }
}

export class WorkCommandValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkCommandValidationError";
  }
}

export class WorkEventConflictError extends Error {
  constructor(eventID: string) {
    super(`Work event ${eventID} is already bound to another mutation`);
    this.name = "WorkEventConflictError";
  }
}

export function createWork(db: RunnerDatabase, command: CreateWorkCommand): WorkMutationResult {
  assertWritableAudit(command.audit);
  if (command.audit.gate.decision !== "allow") {
    throw new WorkCommandValidationError("Work creation requires an allowed deterministic or human gate");
  }
  const work: WorkLedgerEntry = {
    ...command.work,
    created_at: command.audit.occurred_at,
    revision: 0,
    updated_at: command.audit.occurred_at
  };
  const violations = validateWorkLedger({ relations: [], works: [work] });
  if (violations.length > 0) throw new WorkCommandValidationError(violations.join("; "));
  const requestFingerprint = mutationFingerprint("create", { audit: command.audit, work });

  const write = db.transaction(() => {
    const replay = replayExistingMutation(
      db,
      command.audit.event_id,
      work.id,
      WORK_EVENT_TYPES.created,
      "create",
      requestFingerprint
    );
    if (replay) return replay;
    if (getWork(db, work.id)) throw new WorkCommandValidationError(`Work ${work.id} already exists`);

    insertWorkRecord(db, work);
    appendWorkEvent(db, eventWrite({
      audit: command.audit,
      afterRevision: 0,
      beforeRevision: 0,
      eventType: WORK_EVENT_TYPES.created,
      expectedRevision: 0,
      operation: "create",
      outcome: "applied",
      payload: { after: work },
      requestFingerprint,
      work
    }));
    return mutationResult(db, work.id, command.audit.event_id, [], undefined);
  });
  return write.immediate();
}

export function updateWork(db: RunnerDatabase, command: UpdateWorkCommand): WorkMutationResult {
  assertWritableAudit(command.audit);
  assertExpectedRevision(command.expected_revision);
  assertPatchKeys(command.patch);
  const requestFingerprint = mutationFingerprint("update", command);
  const write = db.transaction(() => {
    const replay = replayExistingMutation(
      db,
      command.audit.event_id,
      command.work_id,
      WORK_EVENT_TYPES.updated,
      "update",
      requestFingerprint
    );
    if (replay) return replay;
    const current = mustGetWork(db, command.work_id);
    const next: WorkLedgerEntry = {
      ...current,
      ...definedPatch(command.patch),
      revision: current.revision + 1,
      updated_at: command.audit.occurred_at
    };
    const violations = updateViolations(db, current, next, command);
    if (violations.length > 0) {
      return rejectMutation(db, current, command.audit, WORK_EVENT_TYPES.updated, "update", violations, {
        patch: command.patch
      }, command.expected_revision, requestFingerprint);
    }

    if (!compareAndSetWorkRecord(db, next, command.expected_revision)) {
      throw new Error(`Work ${current.id} changed during update transaction`);
    }
    appendWorkEvent(db, eventWrite({
      audit: command.audit,
      afterRevision: next.revision,
      beforeRevision: current.revision,
      eventType: WORK_EVENT_TYPES.updated,
      expectedRevision: command.expected_revision,
      operation: "update",
      outcome: "applied",
      payload: { after: next, before: current },
      requestFingerprint,
      work: next
    }));
    return mutationResult(db, next.id, command.audit.event_id, [], undefined);
  });
  return write.immediate();
}

export function addWorkRelation(
  db: RunnerDatabase,
  command: AddWorkRelationCommand
): WorkMutationResult {
  assertExpectedRevision(command.expected_revision);
  const audit = relationAudit(command.relation, command.gate);
  assertWritableAudit(audit);
  const sourceWorkID = relationSourceID(command.relation);
  const requestFingerprint = mutationFingerprint("relation_add", { ...command, audit });
  const write = db.transaction(() => {
    const replay = replayExistingMutation(
      db,
      audit.event_id,
      sourceWorkID,
      WORK_EVENT_TYPES.relationAdded,
      "relation_add",
      requestFingerprint
    );
    if (replay) return replay;
    const current = mustGetWork(db, sourceWorkID);
    const snapshot = readWorkLedgerSnapshot(db, current.owner.project_id);
    const violations = [
      ...gateViolations(audit.gate),
      ...revisionViolations(command.expected_revision, current.revision),
      ...validateWorkLedger({ ...snapshot, relations: [...snapshot.relations, command.relation] })
    ];
    if (violations.length > 0) {
      return rejectMutation(
        db,
        current,
        audit,
        WORK_EVENT_TYPES.relationAdded,
        "relation_add",
        unique(violations),
        { relation: command.relation },
        command.expected_revision,
        requestFingerprint
      );
    }

    const next = incremented(current, audit.occurred_at);
    insertWorkRelationRecord(db, current.owner.project_id, command.relation);
    if (!compareAndSetWorkRecord(db, next, command.expected_revision)) {
      throw new Error(`Work ${current.id} changed during relation transaction`);
    }
    appendWorkEvent(db, eventWrite({
      audit,
      afterRevision: next.revision,
      beforeRevision: current.revision,
      eventType: WORK_EVENT_TYPES.relationAdded,
      expectedRevision: command.expected_revision,
      operation: "relation_add",
      outcome: "applied",
      payload: { relation: command.relation },
      requestFingerprint,
      work: next
    }));
    return mutationResult(db, next.id, audit.event_id, [], command.relation);
  });
  return write.immediate();
}

export function removeWorkRelation(
  db: RunnerDatabase,
  command: RemoveWorkRelationCommand
): WorkMutationResult {
  assertWritableAudit(command.audit);
  assertExpectedRevision(command.expected_revision);
  if (command.relation_id.trim() === "") throw new WorkCommandValidationError("relation_id is required");
  const requestFingerprint = mutationFingerprint("relation_remove", command);
  const write = db.transaction(() => {
    const replay = replayExistingMutation(
      db,
      command.audit.event_id,
      command.work_id,
      WORK_EVENT_TYPES.relationRemoved,
      "relation_remove",
      requestFingerprint
    );
    if (replay) return replay;
    const current = mustGetWork(db, command.work_id);
    const relation = getWorkRelation(db, command.relation_id);
    const violations = [
      ...gateViolations(command.audit.gate),
      ...revisionViolations(command.expected_revision, current.revision)
    ];
    if (!relation) violations.push(`Work relation ${command.relation_id} not found`);
    else if (relationSourceID(relation) !== current.id) {
      violations.push(`Work relation ${command.relation_id} is not owned by ${current.id}`);
    }
    if (violations.length > 0 || !relation) {
      return rejectMutation(
        db,
        current,
        command.audit,
        WORK_EVENT_TYPES.relationRemoved,
        "relation_remove",
        unique(violations),
        { relation_id: command.relation_id },
        command.expected_revision,
        requestFingerprint
      );
    }

    const next = incremented(current, command.audit.occurred_at);
    const event = eventWrite({
      audit: command.audit,
      afterRevision: next.revision,
      beforeRevision: current.revision,
      eventType: WORK_EVENT_TYPES.relationRemoved,
      expectedRevision: command.expected_revision,
      operation: "relation_remove",
      outcome: "applied",
      payload: { relation },
      requestFingerprint,
      work: next
    });
    // The removal audit is appended before the destructive row operation; the surrounding
    // transaction still makes the event, delete, and revision bump one atomic commit.
    appendWorkEvent(db, event);
    if (!deleteWorkRelationRecord(db, relation.relation_id)) {
      throw new Error(`Work relation ${relation.relation_id} changed during removal transaction`);
    }
    if (!compareAndSetWorkRecord(db, next, command.expected_revision)) {
      throw new Error(`Work ${current.id} changed during relation removal transaction`);
    }
    return mutationResult(db, next.id, command.audit.event_id, [], relation);
  });
  return write.immediate();
}

export function transitionWork(
  db: RunnerDatabase,
  command: TransitionWorkCommand
): WorkMutationResult {
  return transitionWithOperation(db, command, "transition");
}

export function claimWork(db: RunnerDatabase, command: ClaimWorkCommand): WorkMutationResult {
  return transitionWithOperation(db, { ...command, to: "in_progress" }, "claim");
}

function transitionWithOperation(
  db: RunnerDatabase,
  command: TransitionWorkCommand,
  operation: "claim" | "transition"
): WorkMutationResult {
  assertWritableAudit(command.audit);
  assertExpectedRevision(command.expected_revision);
  const requestFingerprint = mutationFingerprint(operation, command);
  const write = db.transaction(() => {
    const replay = replayExistingMutation(
      db,
      command.audit.event_id,
      command.work_id,
      WORK_EVENT_TYPES.statusChanged,
      operation,
      requestFingerprint
    );
    if (replay) return replay;
    const current = mustGetWork(db, command.work_id);
    const snapshot = readWorkLedgerSnapshot(db, current.owner.project_id);
    const decision = evaluateWorkTransition(snapshot, command);
    if (!decision.allowed) {
      return rejectMutation(
        db,
        current,
        command.audit,
        WORK_EVENT_TYPES.statusChanged,
        operation,
        decision.violations,
        { to: command.to },
        command.expected_revision,
        requestFingerprint
      );
    }

    const next: WorkLedgerEntry = {
      ...current,
      revision: current.revision + 1,
      status: command.to,
      updated_at: command.audit.occurred_at
    };
    if (!compareAndSetWorkRecord(db, next, command.expected_revision)) {
      throw new Error(`Work ${current.id} changed during transition transaction`);
    }
    appendWorkEvent(db, eventWrite({
      audit: command.audit,
      afterRevision: next.revision,
      beforeRevision: current.revision,
      eventType: WORK_EVENT_TYPES.statusChanged,
      expectedRevision: command.expected_revision,
      operation,
      outcome: "applied",
      payload: { after: next, before: current, from: current.status, to: next.status },
      requestFingerprint,
      work: next
    }));
    return mutationResult(db, next.id, command.audit.event_id, [], undefined);
  });
  return write.immediate();
}

function updateViolations(
  db: RunnerDatabase,
  current: WorkLedgerEntry,
  next: WorkLedgerEntry,
  command: UpdateWorkCommand
): string[] {
  const violations = [
    ...gateViolations(command.audit.gate),
    ...revisionViolations(command.expected_revision, current.revision)
  ];
  if (Object.keys(definedPatch(command.patch)).length === 0) violations.push("Work update patch is empty");
  if (command.patch.provenance && !sameJson(command.patch.provenance.origin, current.provenance.origin)) {
    violations.push("Work provenance origin is immutable");
  }
  if (command.patch.acceptance && !sameJson(command.patch.acceptance, current.acceptance)) {
    if (command.patch.acceptance.version !== current.acceptance.version + 1) {
      violations.push(`acceptance version must advance from ${current.acceptance.version} to ${current.acceptance.version + 1}`);
    }
    if (current.status !== "triage" && current.status !== "in_progress") {
      violations.push(`acceptance cannot change while Work is ${current.status}`);
    }
  }
  const snapshot = readWorkLedgerSnapshot(db, current.owner.project_id);
  violations.push(...validateWorkLedger({
    relations: snapshot.relations,
    works: snapshot.works.map((work) => work.id === current.id ? next : work)
  }));
  return unique(violations);
}

function rejectMutation(
  db: RunnerDatabase,
  work: WorkLedgerEntry,
  audit: WorkTransitionAudit,
  eventType: string,
  operation: string,
  violations: string[],
  requested: Record<string, unknown>,
  expectedRevision: number,
  requestFingerprint: string
): WorkMutationResult {
  appendWorkEvent(db, eventWrite({
    audit,
    afterRevision: work.revision,
    beforeRevision: work.revision,
    eventType,
    expectedRevision,
    operation,
    outcome: "rejected",
    payload: { before: work, requested, violations: unique(violations) },
    requestFingerprint,
    work
  }));
  return mutationResult(db, work.id, audit.event_id, unique(violations), undefined);
}

type EventWriteInput = {
  afterRevision: number;
  audit: WorkTransitionAudit;
  beforeRevision: number;
  eventType: string;
  expectedRevision: number;
  operation: string;
  outcome: WorkEventWrite["outcome"];
  payload: Record<string, unknown>;
  requestFingerprint: string;
  work: WorkLedgerEntry;
};

function eventWrite(input: EventWriteInput): WorkEventWrite {
  return {
    actor: input.audit.actor,
    after_revision: input.afterRevision,
    before_revision: input.beforeRevision,
    correlation_id: input.audit.correlation_id,
    event_id: input.audit.event_id,
    event_type: input.eventType,
    expected_revision: input.expectedRevision,
    gate: input.audit.gate,
    occurred_at: input.audit.occurred_at,
    outcome: input.outcome,
    payload: {
      operation: input.operation,
      request_fingerprint: input.requestFingerprint,
      ...input.payload
    },
    project_id: input.work.owner.project_id,
    reason: input.audit.reason,
    work_id: input.work.id
  };
}

function mutationResult(
  db: RunnerDatabase,
  workID: WorkLedgerEntry["id"],
  eventID: string,
  violations: string[],
  relation: WorkRelation | undefined
): WorkMutationResult {
  const work = mustGetWork(db, workID);
  const event = getWorkEvent(db, eventID);
  if (!event) throw new Error(`Work event ${eventID} missing after write`);
  return {
    applied: event.outcome === "applied",
    event,
    ...(relation ? { relation } : {}),
    violations,
    work
  };
}

function replayExistingMutation(
  db: RunnerDatabase,
  eventID: string,
  workID: WorkLedgerEntry["id"],
  eventType: string,
  operation: string,
  requestFingerprint: string
): WorkMutationResult | null {
  const event = getWorkEvent(db, eventID);
  if (!event) return null;
  if (event.work_id !== workID || event.event_type !== eventType ||
      event.payload.operation !== operation || event.payload.request_fingerprint !== requestFingerprint) {
    throw new WorkEventConflictError(eventID);
  }
  const payloadViolations = Array.isArray(event.payload.violations)
    ? event.payload.violations.filter((item): item is string => typeof item === "string")
    : [];
  return {
    applied: event.outcome === "applied",
    event,
    violations: payloadViolations,
    work: mustGetWork(db, workID)
  };
}

function mustGetWork(db: RunnerDatabase, id: WorkLedgerEntry["id"]): WorkLedgerEntry {
  const work = getWork(db, id);
  if (!work) throw new WorkNotFoundError(id);
  return work;
}

function relationAudit(relation: WorkRelation, gate: WorkTransitionGate): WorkTransitionAudit {
  return {
    actor: relation.actor,
    correlation_id: relation.correlation_id,
    event_id: relation.audit_event_ref,
    gate,
    occurred_at: relation.occurred_at,
    reason: relation.reason
  };
}

function relationSourceID(relation: WorkRelation): WorkLedgerEntry["id"] {
  return relation.kind === "parent_child" ? relation.parent_work_id : relation.work_id;
}

function incremented(work: WorkLedgerEntry, timestamp: string): WorkLedgerEntry {
  return { ...work, revision: work.revision + 1, updated_at: timestamp };
}

function gateViolations(gate: WorkTransitionGate): string[] {
  if (gate.decision === "deny") return ["mutation gate denied"];
  if (gate.decision === "ask") return ["mutation gate requires approval"];
  return [];
}

function revisionViolations(expected: number, actual: number): string[] {
  return expected === actual ? [] : [`expected revision ${expected} does not match ${actual}`];
}

function assertExpectedRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new WorkCommandValidationError("expected revision must be a non-negative integer");
  }
}

function assertWritableAudit(audit: WorkTransitionAudit): void {
  const errors: string[] = [];
  if (!audit.event_id.trim()) errors.push("event_id is required");
  if (!audit.actor.id.trim()) errors.push("actor.id is required");
  if (!["user", "supervisor", "runner", "guardian", "automation", "system"].includes(audit.actor.kind)) {
    errors.push("actor.kind is invalid");
  }
  if (!audit.reason.trim()) errors.push("reason is required");
  if (!audit.correlation_id.trim()) errors.push("correlation_id is required");
  if (!Number.isFinite(Date.parse(audit.occurred_at))) errors.push("occurred_at must be a timestamp");
  if (audit.gate.authority !== "deterministic_policy" && audit.gate.authority !== "human_approval") {
    errors.push("gate authority is not trusted");
  }
  if (audit.gate.decision !== "allow" && audit.gate.decision !== "deny" && audit.gate.decision !== "ask") {
    errors.push("gate decision is invalid");
  }
  if (!audit.gate.policy_ref.trim()) errors.push("gate policy_ref is required");
  if (errors.length > 0) throw new WorkCommandValidationError(errors.join("; "));
}

const UPDATE_FIELDS = new Set(["acceptance", "goal", "provenance", "title", "type", "workflow_ref"]);

function assertPatchKeys(patch: WorkUpdatePatch): void {
  const unknown = Object.keys(patch).filter((key) => !UPDATE_FIELDS.has(key));
  if (unknown.length > 0) throw new WorkCommandValidationError(`unsupported Work update fields: ${unknown.join(", ")}`);
}

function definedPatch(patch: WorkUpdatePatch): WorkUpdatePatch {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as WorkUpdatePatch;
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function mutationFingerprint(operation: string, command: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson({ command, operation })).digest("hex")}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
