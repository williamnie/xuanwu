import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import {
  validateWorkLedger,
  type WorkAcceptanceContract,
  type WorkLedgerEntry,
  type WorkProvenance,
  type WorkRelation
} from "../../domain/work/contracts.ts";
import { errorMessage } from "../../util/values.ts";
import { type WorkRow, type WorkRelationRow, type WorkEventRow, type WorkEvent } from "./workLedger.ts";

export function mapWork(row: WorkRow): WorkLedgerEntry {
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

export function mapRelation(row: WorkRelationRow): WorkRelation {
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

export function mapEvent(row: WorkEventRow): WorkEvent {
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
