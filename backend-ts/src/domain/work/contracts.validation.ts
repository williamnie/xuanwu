import { WORK_STATUSES, parseDomainID, type WorkID } from "../../xuanwu/coreDomainContracts.ts";
import { WORK_TYPES, WORK_SOURCE_KINDS } from "./contracts.model.ts";
import type { WorkLedgerSnapshot, WorkLedgerEntry, WorkAcceptanceContract, WorkProvenance, WorkSource, WorkRelationAudit, WorkTransitionAudit } from "./contracts.model.ts";
import { hasDirectedCycle } from "./contracts.graph.ts";

export function validateWorkLedger(snapshot: WorkLedgerSnapshot): string[] {
  const errors: string[] = [];
  const works = new Map<WorkID, WorkLedgerEntry>();

  for (const work of snapshot.works) {
    if (parseDomainID(work.id)?.kind !== "work") errors.push(`${work.id} is not a Work id`);
    if (works.has(work.id)) errors.push(`duplicate Work id ${work.id}`);
    works.set(work.id, work);
    if (!WORK_TYPES.includes(work.type)) errors.push(`${work.id} has unsupported Work type ${work.type}`);
    if (!WORK_STATUSES.includes(work.status)) errors.push(`${work.id} has unsupported status ${work.status}`);
    if (!work.owner.project_id.trim()) errors.push(`${work.id} owner project is required`);
    if (!work.title.trim()) errors.push(`${work.id} title is required`);
    if (!work.goal.trim()) errors.push(`${work.id} goal is required`);
    if (!work.workflow_ref.trim()) errors.push(`${work.id} workflow_ref is required`);
    if (!Number.isSafeInteger(work.revision) || work.revision < 0) errors.push(`${work.id} revision must be non-negative`);
    errors.push(...validateAcceptanceContract(work.acceptance).map((error) => `${work.id} ${error}`));
    errors.push(...validateProvenance(work.provenance).map((error) => `${work.id} ${error}`));
  }

  const relationIDs = new Set<string>();
  const relationKeys = new Set<string>();
  const parentByChild = new Map<WorkID, WorkID>();
  const hierarchyEdges: Array<[WorkID, WorkID]> = [];
  const dependencyEdges: Array<[WorkID, WorkID]> = [];

  for (const relation of snapshot.relations) {
    if (!relation.relation_id.trim()) errors.push("Work relation_id is required");
    else if (relationIDs.has(relation.relation_id)) errors.push(`duplicate Work relation id ${relation.relation_id}`);
    relationIDs.add(relation.relation_id);
    errors.push(...validateRelationAudit(relation).map((error) => `${relation.relation_id} ${error}`));

    const [from, to] = relation.kind === "parent_child"
      ? [relation.parent_work_id, relation.child_work_id]
      : [relation.work_id, relation.depends_on_work_id];
    if (from === to) errors.push(`${relation.relation_id} cannot relate Work to itself`);
    const fromWork = works.get(from);
    const toWork = works.get(to);
    if (!fromWork) errors.push(`${relation.relation_id} references missing Work ${from}`);
    if (!toWork) errors.push(`${relation.relation_id} references missing Work ${to}`);
    if (fromWork && toWork && fromWork.owner.project_id !== toWork.owner.project_id) {
      errors.push(`${relation.relation_id} cannot cross project ownership`);
    }

    const relationKey = `${relation.kind}:${from}:${to}`;
    if (relationKeys.has(relationKey)) errors.push(`duplicate Work relation ${relationKey}`);
    relationKeys.add(relationKey);

    if (relation.kind === "parent_child") {
      const existingParent = parentByChild.get(relation.child_work_id);
      if (existingParent && existingParent !== relation.parent_work_id) {
        errors.push(`${relation.child_work_id} cannot have multiple parents`);
      }
      parentByChild.set(relation.child_work_id, relation.parent_work_id);
      hierarchyEdges.push([relation.parent_work_id, relation.child_work_id]);
    } else {
      dependencyEdges.push([relation.work_id, relation.depends_on_work_id]);
    }
  }

  if (hasDirectedCycle(snapshot.works.map((work) => work.id), hierarchyEdges)) {
    errors.push("parent/child cycle detected");
  }
  if (hasDirectedCycle(snapshot.works.map((work) => work.id), dependencyEdges)) {
    errors.push("dependency cycle detected");
  }
  return errors;
}

export function validateAcceptanceContract(contract: WorkAcceptanceContract): string[] {
  const errors: string[] = [];
  if (!Number.isSafeInteger(contract.version) || contract.version <= 0) {
    errors.push("acceptance version must be positive");
  }
  if (contract.criteria.length === 0) errors.push("acceptance criteria are required");
  if (!contract.criteria.some((criterion) => criterion.required)) errors.push("acceptance requires at least one required criterion");
  const ids = new Set<string>();
  for (const criterion of contract.criteria) {
    if (!criterion.id.trim()) errors.push("acceptance criterion id is required");
    else if (ids.has(criterion.id)) errors.push(`duplicate acceptance criterion ${criterion.id}`);
    ids.add(criterion.id);
    if (!criterion.description.trim()) errors.push(`${criterion.id || "acceptance criterion"} description is required`);
  }
  return errors;
}

export function validateProvenance(provenance: WorkProvenance): string[] {
  const errors = validateSource(provenance.origin, "origin");
  provenance.causes.forEach((source, index) => errors.push(...validateSource(source, `cause[${index}]`)));
  const refs = [provenance.origin, ...provenance.causes].map((source) => `${source.authority}:${source.external_id}`);
  if (new Set(refs).size !== refs.length) errors.push("provenance sources must be unique");
  return errors;
}

export function validateSource(source: WorkSource, label: string): string[] {
  const errors: string[] = [];
  if (!WORK_SOURCE_KINDS.includes(source.kind)) errors.push(`${label} has unsupported source kind ${source.kind}`);
  if (!source.authority.trim()) errors.push(`${label} authority is required`);
  if (!source.external_id.trim()) errors.push(`${label} external_id is required`);
  if (!Number.isFinite(Date.parse(source.occurred_at))) errors.push(`${label} occurred_at must be a timestamp`);
  if (source.completeness === "complete") {
    if (!source.actor.id.trim()) errors.push(`${label} actor.id is required`);
    if (!source.correlation_id.trim()) errors.push(`${label} correlation_id is required`);
  } else if (source.missing_fields.length === 0) {
    errors.push(`${label} legacy_incomplete source must list missing_fields`);
  }
  return errors;
}

export function validateRelationAudit(audit: WorkRelationAudit): string[] {
  const errors: string[] = [];
  if (!audit.audit_event_ref.trim()) errors.push("audit_event_ref is required");
  if (!audit.actor.id.trim()) errors.push("actor.id is required");
  if (!audit.reason.trim()) errors.push("reason is required");
  if (!audit.correlation_id.trim()) errors.push("correlation_id is required");
  if (!Number.isFinite(Date.parse(audit.occurred_at))) errors.push("occurred_at must be a timestamp");
  return errors;
}

export function validateTransitionAudit(audit: WorkTransitionAudit): string[] {
  const errors: string[] = [];
  if (!audit.event_id.trim()) errors.push("transition event_id is required");
  if (!audit.actor.id.trim()) errors.push("transition actor.id is required");
  if (!audit.reason.trim()) errors.push("transition reason is required");
  if (!audit.correlation_id.trim()) errors.push("transition correlation_id is required");
  if (!Number.isFinite(Date.parse(audit.occurred_at))) errors.push("transition occurred_at must be a timestamp");
  if (!["deterministic_policy", "human_approval"].includes(audit.gate.authority)) {
    errors.push("transition gate authority is not trusted");
  }
  if (!["allow", "deny", "ask"].includes(audit.gate.decision)) {
    errors.push("transition gate decision is invalid");
  }
  if (!audit.gate.policy_ref.trim()) errors.push("transition gate policy_ref is required");
  return errors;
}
