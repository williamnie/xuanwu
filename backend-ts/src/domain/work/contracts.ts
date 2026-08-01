import {
  STATE_TRANSITIONS,
  WORK_STATUSES,
  canTransition,
  parseDomainID,
  type DomainActor,
  type Work as CoreWork,
  type WorkID,
  type WorkStatus
} from "../../xuanwu/coreDomainContracts.ts";

export { WORK_STATUSES, type WorkID, type WorkStatus };

// P00.04 remains the single source for the shared Work status vocabulary and edge table.
export const WORK_STATE_TRANSITIONS = STATE_TRANSITIONS.work;

export const WORK_TYPES = ["objective", "engineering_task"] as const;
export type WorkType = typeof WORK_TYPES[number];

export const WORK_SOURCE_KINDS = [
  "user_request",
  "issue",
  "supervisor_proposal",
  "automation_trigger",
  "guardian_remediation",
  "import"
] as const;
export type WorkSourceKind = typeof WORK_SOURCE_KINDS[number];

export type CompleteWorkSource = {
  actor: DomainActor;
  authority: string;
  completeness: "complete";
  correlation_id: string;
  external_id: string;
  kind: WorkSourceKind;
  occurred_at: string;
  source_event_id?: string;
};

export type LegacyIncompleteWorkSource = {
  actor?: DomainActor;
  authority: string;
  completeness: "legacy_incomplete";
  correlation_id?: string;
  external_id: string;
  kind: WorkSourceKind;
  missing_fields: string[];
  occurred_at: string;
  source_event_id?: string;
};

export type WorkSource = CompleteWorkSource | LegacyIncompleteWorkSource;

export type WorkProvenance = {
  causes: WorkSource[];
  origin: WorkSource;
};

export type WorkAcceptanceCriterion = {
  description: string;
  id: string;
  required: boolean;
};

export type WorkAcceptanceContract = {
  criteria: WorkAcceptanceCriterion[];
  version: number;
};

export type WorkLedgerEntry = Omit<CoreWork, "acceptance_criteria" | "source_ref"> & {
  acceptance: WorkAcceptanceContract;
  agent_profile_id?: string;
  effective_agent_profile?: {
    id: string;
    model: string;
    name: string;
    provider: string;
    selection_reason: string;
    source: "project_default" | "project_provider" | "strategy" | "work";
  };
  effective_provider?: string;
  provenance: WorkProvenance;
  revision: number;
  title: string;
  type: WorkType;
};

export type WorkRelationAudit = {
  actor: DomainActor;
  audit_event_ref: string;
  correlation_id: string;
  occurred_at: string;
  reason: string;
};

export type ParentChildRelation = WorkRelationAudit & {
  child_work_id: WorkID;
  kind: "parent_child";
  parent_work_id: WorkID;
  relation_id: string;
};

export type DependencyRelation = WorkRelationAudit & {
  depends_on_work_id: WorkID;
  kind: "depends_on";
  relation_id: string;
  work_id: WorkID;
};

export type WorkRelation = ParentChildRelation | DependencyRelation;

export type WorkLedgerSnapshot = {
  relations: WorkRelation[];
  works: WorkLedgerEntry[];
};

export type WorkTransitionGate = {
  authority: "deterministic_policy" | "human_approval";
  decision: "allow" | "deny" | "ask";
  policy_ref: string;
};

export type WorkTransitionAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  gate: WorkTransitionGate;
  occurred_at: string;
  reason: string;
};

export type WorkTransitionCommand = {
  audit: WorkTransitionAudit;
  expected_revision: number;
  to: WorkStatus;
  work_id: WorkID;
};

export type WorkTransitionDecision = {
  allowed: boolean;
  violations: string[];
};

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

export function evaluateWorkTransition(
  snapshot: WorkLedgerSnapshot,
  command: WorkTransitionCommand
): WorkTransitionDecision {
  const violations = validateWorkLedger(snapshot);
  const work = snapshot.works.find((item) => item.id === command.work_id);
  if (!work) violations.push(`missing Work ${command.work_id}`);
  violations.push(...validateTransitionAudit(command.audit));
  if (!work) return decision(violations);

  if (!Number.isSafeInteger(command.expected_revision) || command.expected_revision < 0) {
    violations.push("expected revision must be non-negative");
  } else if (command.expected_revision !== work.revision) {
    violations.push(`expected revision ${command.expected_revision} does not match ${work.revision}`);
  }
  if (!canTransition("work", work.status, command.to)) {
    violations.push(`illegal Work transition ${work.status} -> ${command.to}`);
  }
  if (command.audit.gate.decision === "deny") violations.push("transition gate denied");
  if (command.audit.gate.decision === "ask") violations.push("transition gate requires approval");

  const dependencies = snapshot.relations
    .filter((relation): relation is DependencyRelation => relation.kind === "depends_on" && relation.work_id === work.id)
    .map((relation) => snapshot.works.find((item) => item.id === relation.depends_on_work_id))
    .filter((item): item is WorkLedgerEntry => Boolean(item));
  if (["in_progress", "needs_user", "done"].includes(command.to)) {
    for (const dependency of dependencies) {
      if (dependency.status !== "done") violations.push(`dependency ${dependency.id} is ${dependency.status}, not done`);
    }
  }

  if (command.to === "done") {
    const children = snapshot.relations
      .filter((relation): relation is ParentChildRelation => relation.kind === "parent_child" && relation.parent_work_id === work.id)
      .map((relation) => snapshot.works.find((item) => item.id === relation.child_work_id))
      .filter((item): item is WorkLedgerEntry => Boolean(item));
    for (const child of children) {
      if (child.status !== "done") violations.push(`child ${child.id} is ${child.status}, not done`);
    }
  }

  // PI owns the semantic completion decision. Evidence and Handoff are context,
  // not a second deterministic completion gate.
  return decision(violations);
}

function validateProvenance(provenance: WorkProvenance): string[] {
  const errors = validateSource(provenance.origin, "origin");
  provenance.causes.forEach((source, index) => errors.push(...validateSource(source, `cause[${index}]`)));
  const refs = [provenance.origin, ...provenance.causes].map((source) => `${source.authority}:${source.external_id}`);
  if (new Set(refs).size !== refs.length) errors.push("provenance sources must be unique");
  return errors;
}

function validateSource(source: WorkSource, label: string): string[] {
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

function validateRelationAudit(audit: WorkRelationAudit): string[] {
  const errors: string[] = [];
  if (!audit.audit_event_ref.trim()) errors.push("audit_event_ref is required");
  if (!audit.actor.id.trim()) errors.push("actor.id is required");
  if (!audit.reason.trim()) errors.push("reason is required");
  if (!audit.correlation_id.trim()) errors.push("correlation_id is required");
  if (!Number.isFinite(Date.parse(audit.occurred_at))) errors.push("occurred_at must be a timestamp");
  return errors;
}

function validateTransitionAudit(audit: WorkTransitionAudit): string[] {
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

function hasDirectedCycle(nodes: readonly WorkID[], edges: ReadonlyArray<readonly [WorkID, WorkID]>): boolean {
  const adjacent = new Map(nodes.map((node) => [node, [] as WorkID[]]));
  for (const [from, to] of edges) adjacent.get(from)?.push(to);
  const active = new Set<WorkID>();
  const complete = new Set<WorkID>();
  const visit = (node: WorkID): boolean => {
    if (active.has(node)) return true;
    if (complete.has(node)) return false;
    active.add(node);
    for (const next of adjacent.get(node) ?? []) if (visit(next)) return true;
    active.delete(node);
    complete.add(node);
    return false;
  };
  return nodes.some(visit);
}

function decision(violations: string[]): WorkTransitionDecision {
  return { allowed: violations.length === 0, violations: [...new Set(violations)] };
}
