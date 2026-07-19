import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, type Issue } from "../../db/repositories/issues.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { listStoredEvidence, type StoredEvidenceRecord } from "../../db/repositories/evidence.ts";
import { canSatisfyEvidenceGate, validateEvidence, type EvidenceRecord } from "../evidence/contracts.ts";
import type { DomainActor, WorkID } from "../../xuanwu/coreDomainContracts.ts";

export const READINESS_REQUIREMENTS_EVENT_TYPE = "work.readiness_requirements.declared.v1";
export const READINESS_REQUIREMENTS_SCHEMA_VERSION = 1 as const;
export const READINESS_PROJECTION_CONTRACT = "xw.delivery-readiness.projection.v1" as const;

export const READINESS_STAGES = ["source_ready", "deployed", "observed", "gate_passed"] as const;
export type ReadinessStage = typeof READINESS_STAGES[number];
export const READINESS_EVIDENCE_EVENTS = ["deployment", "observation", "gate_pass", "rollback"] as const;
export type ReadinessEvidenceEvent = typeof READINESS_EVIDENCE_EVENTS[number];

export type ReadinessAudit = {
  actor: DomainActor;
  correlation_id: string;
  event_id: string;
  occurred_at: string;
  reason: string;
};

export type ReadinessRequirement = {
  environment: string;
  migration_gate?: string;
  release_window: string;
  required_stage: ReadinessStage;
  runtime_revision: string;
  source_revision: string;
  source_work_id: WorkID;
};

export type ReadinessRequirementDeclaration = {
  audit: ReadinessAudit;
  requirements: ReadinessRequirement[];
  schema_version: typeof READINESS_REQUIREMENTS_SCHEMA_VERSION;
  work_id: WorkID;
};

export type ReadinessRequirementProjection = ReadinessRequirement & {
  current_stage: ReadinessStage | null;
  evidence_ids: string[];
  missing_evidence: string[];
  next_step: string;
  ready: boolean;
  rollback_evidence_id: string;
  source_issue_id: number | null;
  source_status: string;
};

export type ReadinessProjection = {
  contract: typeof READINESS_PROJECTION_CONTRACT;
  current_stage: ReadinessStage | null;
  declared_at: string;
  declaration_event_id: number | null;
  missing_evidence: string[];
  next_step: string;
  ready: boolean;
  requirements: ReadinessRequirementProjection[];
  status: "not_required" | "ready" | "waiting" | "invalid";
  work_id: WorkID;
};

export type ReadinessEvidenceFacts = {
  environment: string;
  event: ReadinessEvidenceEvent;
  migration_gate: string;
  release_window: string;
  rollback_ref: string;
  runtime_revision: string;
  runtime_stamp: string;
  source_revision: string;
};

type DeclarationEventRow = { created_at: string; id: number; payload: string };

export function declareIssueReadinessRequirements(
  db: RunnerDatabase,
  issueID: number,
  declaration: ReadinessRequirementDeclaration
): { event_id: number; replayed: boolean } {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`Issue ${issueID} not found`);
  const errors = validateReadinessDeclaration(declaration, issueID);
  if (errors.length > 0) throw new Error(`invalid readiness declaration: ${errors.join("; ")}`);
  const directDependencies = directDependencyWorkIDs(db, issue);
  for (const requirement of declaration.requirements) {
    if (!directDependencies.has(requirement.source_work_id)) {
      throw new Error(`readiness source ${requirement.source_work_id} is not a direct Work dependency`);
    }
  }

  const existing = db.sqlite.query<DeclarationEventRow, [number, string, string]>(`
    select id, payload, created_at from issue_events
    where issue_id=? and type=? and json_valid(payload)
      and json_extract(payload, '$.audit.event_id')=?
    order by id desc limit 1
  `).get(issueID, READINESS_REQUIREMENTS_EVENT_TYPE, declaration.audit.event_id);
  if (existing) {
    const stored = parsedDeclaration(existing.payload);
    if (stableJson(stored) !== stableJson(declaration)) {
      throw new Error(`readiness declaration ${declaration.audit.event_id} conflicts with append-only replay`);
    }
    return { event_id: existing.id, replayed: true };
  }
  const event = recordIssueEvent(db, issueID, READINESS_REQUIREMENTS_EVENT_TYPE, declaration);
  return { event_id: event.id, replayed: false };
}

export function readIssueReadiness(db: RunnerDatabase, issueID: number): ReadinessProjection | null {
  const issue = getIssue(db, issueID);
  if (!issue) return null;
  const workID = issueIDToWorkID(issueID);
  const latest = db.sqlite.query<DeclarationEventRow, [number, string]>(`
    select id, payload, created_at from issue_events
    where issue_id=? and type=? order by id desc limit 1
  `).get(issueID, READINESS_REQUIREMENTS_EVENT_TYPE);
  if (!latest) return emptyProjection(workID);
  const declaration = parsedDeclaration(latest.payload);
  if (!declaration) return invalidProjection(workID, latest.id, latest.created_at, "Invalid readiness declaration Evidence.");
  const validation = validateReadinessDeclaration(declaration, issueID);
  if (validation.length > 0) {
    return invalidProjection(workID, latest.id, declaration.audit.occurred_at, validation.join("; "));
  }
  const directDependencies = directDependencyWorkIDs(db, issue);
  const requirements = declaration.requirements.map((requirement) => {
    if (!directDependencies.has(requirement.source_work_id)) {
      return invalidRequirement(requirement, "Readiness source is not a direct Work dependency.");
    }
    return projectRequirement(db, requirement);
  });
  const missing = uniqueStrings(requirements.flatMap((item) => item.missing_evidence));
  const ready = requirements.every((item) => item.ready);
  return {
    contract: READINESS_PROJECTION_CONTRACT,
    current_stage: minimumStage(requirements.map((item) => item.current_stage)),
    declared_at: declaration.audit.occurred_at,
    declaration_event_id: latest.id,
    missing_evidence: missing,
    next_step: ready ? "All declared delivery readiness requirements are satisfied." : requirements.find((item) => !item.ready)?.next_step ?? "Inspect readiness Evidence.",
    ready,
    requirements,
    status: requirements.some((item) => item.source_status === "invalid") ? "invalid" : ready ? "ready" : "waiting",
    work_id: workID
  };
}

export function readinessNotRequired(workID: WorkID): ReadinessProjection {
  return emptyProjection(workID);
}

export function validateReadinessEvidence(evidence: EvidenceRecord): string[] {
  const validation = validateEvidence(evidence);
  if (!validation.ok) return validation.errors;
  const facts = readinessEvidenceFacts(evidence);
  if (!facts) return ["Evidence facts do not implement the readiness contract"];
  const errors: string[] = [];
  if (!canSatisfyEvidenceGate(evidence)) errors.push("readiness Evidence must be trusted, known-kind, and passed");
  if (evidence.artifact_refs.length === 0) errors.push("readiness Evidence requires an artifact ref");
  if (!facts.rollback_ref) errors.push("readiness Evidence requires rollback_ref");
  if (!facts.runtime_stamp) errors.push("readiness Evidence requires runtime_stamp");
  if (facts.event === "gate_pass" && !facts.migration_gate) errors.push("gate_pass Evidence requires migration_gate");
  return errors;
}

function projectRequirement(db: RunnerDatabase, requirement: ReadinessRequirement): ReadinessRequirementProjection {
  let sourceIssueID: number | null = null;
  try {
    sourceIssueID = workIDToIssueID(requirement.source_work_id);
  } catch {
    return invalidRequirement(requirement, "Source Work id is invalid.");
  }
  const source = getIssue(db, sourceIssueID);
  if (!source) return invalidRequirement(requirement, "Source Work is missing.", sourceIssueID);
  const sourceReady = source.status === "done";
  const page = listStoredEvidence(db, { limit: 1000, work_id: requirement.source_work_id });
  const matching = page.items
    .filter((item) => matchingEvidence(item.evidence, requirement))
    .sort((left, right) => left.event_id - right.event_id);
  const lastRollback = matching.filter((item) => readinessEvidenceFacts(item.evidence)?.event === "rollback").at(-1);
  const active = matching.filter((item) => !lastRollback || item.event_id > lastRollback.event_id);
  const deployment = latestEvent(active, "deployment");
  const afterDeployment = deployment ? active.filter((item) => item.event_id > deployment.event_id) : [];
  const observation = latestEvent(afterDeployment, "observation");
  const afterObservation = observation ? active.filter((item) => item.event_id > observation.event_id) : [];
  const gatePass = latestEvent(afterObservation, "gate_pass", requirement.migration_gate);
  const deployed = sourceReady && Boolean(deployment);
  const observed = deployed && Boolean(observation);
  const gatePassed = observed && Boolean(gatePass);
  const currentStage: ReadinessStage | null = gatePassed
    ? "gate_passed"
    : observed ? "observed" : deployed ? "deployed" : sourceReady ? "source_ready" : null;
  const missing = missingForRequirement(requirement, sourceReady, deployed, observed, gatePassed, matching);
  const ready = stageRank(currentStage) >= stageRank(requirement.required_stage);
  return {
    ...requirement,
    current_stage: currentStage,
    evidence_ids: [deployment, observation, gatePass].filter(Boolean).map((item) => item!.evidence.id),
    missing_evidence: ready ? [] : missing,
    next_step: ready ? "Requirement satisfied." : nextStep(missing[0]),
    ready,
    rollback_evidence_id: lastRollback?.evidence.id ?? "",
    source_issue_id: sourceIssueID,
    source_status: source.status
  };
}

function matchingEvidence(evidence: EvidenceRecord, requirement: ReadinessRequirement): boolean {
  if (validateReadinessEvidence(evidence).length > 0) return false;
  const facts = readinessEvidenceFacts(evidence);
  return Boolean(facts)
    && facts!.environment === requirement.environment
    && facts!.release_window === requirement.release_window
    && facts!.runtime_revision === requirement.runtime_revision
    && facts!.source_revision === requirement.source_revision;
}

function latestEvent(
  records: StoredEvidenceRecord[],
  event: ReadinessEvidenceEvent,
  migrationGate = ""
): StoredEvidenceRecord | undefined {
  return records.filter((item) => {
    const facts = readinessEvidenceFacts(item.evidence);
    return facts?.event === event && (event !== "gate_pass" || facts.migration_gate === migrationGate);
  }).at(-1);
}

function missingForRequirement(
  requirement: ReadinessRequirement,
  sourceReady: boolean,
  deployed: boolean,
  observed: boolean,
  gatePassed: boolean,
  matching: StoredEvidenceRecord[]
): string[] {
  const missing: string[] = [];
  if (!sourceReady) missing.push(`source_ready:${requirement.source_work_id}`);
  if (stageRank(requirement.required_stage) >= stageRank("deployed") && !deployed) {
    const observedRuntimeRevisions = matching.map((item) => readinessEvidenceFacts(item.evidence)?.runtime_revision).filter(Boolean);
    missing.push(observedRuntimeRevisions.length > 0
      ? `deployed:runtime_revision=${requirement.runtime_revision}`
      : `deployed:${requirement.environment}:${requirement.runtime_revision}`);
  }
  if (stageRank(requirement.required_stage) >= stageRank("observed") && !observed) {
    missing.push(`observed:${requirement.environment}:${requirement.release_window}`);
  }
  if (requirement.required_stage === "gate_passed" && !gatePassed) {
    missing.push(`gate_passed:${requirement.migration_gate || "unspecified"}`);
  }
  return missing;
}

export function readinessEvidenceFacts(evidence: EvidenceRecord): ReadinessEvidenceFacts | null {
  const facts = evidence.decisive_output.facts;
  const event = textFact(facts.readiness_event) as ReadinessEvidenceEvent;
  if (!READINESS_EVIDENCE_EVENTS.includes(event)) return null;
  const output = {
    environment: textFact(facts.environment),
    event,
    migration_gate: textFact(facts.migration_gate),
    release_window: textFact(facts.release_window),
    rollback_ref: textFact(facts.rollback_ref),
    runtime_revision: textFact(facts.runtime_revision),
    runtime_stamp: textFact(facts.runtime_stamp),
    source_revision: textFact(facts.source_revision)
  };
  return output.environment && output.release_window && output.runtime_revision && output.source_revision ? output : null;
}

function parsedDeclaration(payload: string): ReadinessRequirementDeclaration | null {
  try {
    const value = JSON.parse(payload) as ReadinessRequirementDeclaration;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function validateReadinessDeclaration(declaration: ReadinessRequirementDeclaration, issueID: number): string[] {
  const errors: string[] = [];
  if (declaration.schema_version !== READINESS_REQUIREMENTS_SCHEMA_VERSION) errors.push("schema_version must be 1");
  if (declaration.work_id !== issueIDToWorkID(issueID)) errors.push("work_id does not match Issue authority");
  if (!Array.isArray(declaration.requirements) || declaration.requirements.length === 0) errors.push("requirements are required");
  if (!declaration.audit || !declaration.audit.actor?.id?.trim()) errors.push("audit actor is required");
  if (declaration.audit?.actor && !["user", "supervisor", "runner", "guardian", "automation", "system"].includes(declaration.audit.actor.kind)) {
    errors.push("audit actor kind is invalid");
  }
  if (!declaration.audit?.correlation_id?.trim()) errors.push("audit correlation_id is required");
  if (!declaration.audit?.event_id?.trim()) errors.push("audit event_id is required");
  if (!declaration.audit?.reason?.trim()) errors.push("audit reason is required");
  if (!declaration.audit?.occurred_at || !Number.isFinite(Date.parse(declaration.audit.occurred_at))) errors.push("audit occurred_at must be a timestamp");
  const keys = new Set<string>();
  for (const requirement of declaration.requirements ?? []) {
    if (!READINESS_STAGES.includes(requirement.required_stage)) errors.push("required_stage is invalid");
    for (const field of ["environment", "release_window", "runtime_revision", "source_revision", "source_work_id"] as const) {
      if (typeof requirement[field] !== "string" || !requirement[field].trim()) errors.push(`${field} is required`);
    }
    if (requirement.required_stage === "gate_passed" && !requirement.migration_gate?.trim()) {
      errors.push("gate_passed requirement requires migration_gate");
    }
    const key = `${requirement.source_work_id}\u0000${requirement.environment}\u0000${requirement.runtime_revision}\u0000${requirement.release_window}`;
    if (keys.has(key)) errors.push("duplicate readiness requirement");
    keys.add(key);
  }
  return uniqueStrings(errors);
}

function directDependencyWorkIDs(db: RunnerDatabase, issue: Issue): Set<string> {
  return new Set(db.sqlite.query<{ target_work_id: string }, [string, string]>(`
    select target_work_id from work_relations
    where project_id=? and source_work_id=? and kind='depends_on'
  `).all(issue.project_id, issueIDToWorkID(issue.id)).map((row) => row.target_work_id));
}

function invalidRequirement(
  requirement: ReadinessRequirement,
  detail: string,
  sourceIssueID: number | null = null
): ReadinessRequirementProjection {
  return {
    ...requirement,
    current_stage: null,
    evidence_ids: [],
    missing_evidence: [`invalid:${detail}`],
    next_step: detail,
    ready: false,
    rollback_evidence_id: "",
    source_issue_id: sourceIssueID,
    source_status: "invalid"
  };
}

function emptyProjection(workID: WorkID): ReadinessProjection {
  return {
    contract: READINESS_PROJECTION_CONTRACT,
    current_stage: null,
    declared_at: "",
    declaration_event_id: null,
    missing_evidence: [],
    next_step: "No delivery readiness requirements declared.",
    ready: true,
    requirements: [],
    status: "not_required",
    work_id: workID
  };
}

function invalidProjection(workID: WorkID, eventID: number, declaredAt: string, detail: string): ReadinessProjection {
  return {
    contract: READINESS_PROJECTION_CONTRACT,
    current_stage: null,
    declared_at: declaredAt,
    declaration_event_id: eventID,
    missing_evidence: [`invalid:${detail}`],
    next_step: detail,
    ready: false,
    requirements: [],
    status: "invalid",
    work_id: workID
  };
}

function minimumStage(stages: Array<ReadinessStage | null>): ReadinessStage | null {
  if (stages.length === 0 || stages.some((stage) => stage === null)) return null;
  return stages.reduce<ReadinessStage>((minimum, stage) => (
    stageRank(stage) < stageRank(minimum) ? stage! : minimum
  ), "gate_passed");
}

function stageRank(stage: ReadinessStage | null): number {
  return stage === null ? -1 : READINESS_STAGES.indexOf(stage);
}

function nextStep(missing: string | undefined): string {
  if (!missing) return "Inspect readiness Evidence.";
  if (missing.startsWith("source_ready:")) return "Complete the source Work for the declared revision.";
  if (missing.startsWith("deployed:")) return "Record matching runtime stamp deployment Evidence with artifact and rollback refs.";
  if (missing.startsWith("observed:")) return "Record matching release-window Golden Journey observation Evidence.";
  if (missing.startsWith("gate_passed:")) return "Record matching migration gate Evidence.";
  return missing.replace(/^invalid:/, "");
}

function textFact(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function issueIDToWorkID(issueID: number): WorkID {
  if (!Number.isSafeInteger(issueID) || issueID <= 0) throw new Error("issue id must be a positive integer");
  return `xw:work:issues:${issueID}`;
}

function workIDToIssueID(workID: string): number {
  const match = /^xw:work:issues:([1-9][0-9]*)$/.exec(workID);
  if (!match) throw new Error(`${workID} is not a canonical Issue-backed Work id`);
  const issueID = Number(match[1]);
  if (!Number.isSafeInteger(issueID)) throw new Error(`${workID} is not a canonical Issue-backed Work id`);
  return issueID;
}
