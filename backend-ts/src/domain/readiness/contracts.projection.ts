import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listStoredEvidence, type StoredEvidenceRecord } from "../../db/repositories/evidence.ts";
import { canSatisfyEvidenceGate, validateEvidence, type EvidenceRecord } from "../evidence/contracts.ts";
import type { WorkID } from "../../xuanwu/coreDomainContracts.ts";
import { cleanString } from "../../util/values.ts";
import { READINESS_REQUIREMENTS_EVENT_TYPE, READINESS_PROJECTION_CONTRACT, READINESS_EVIDENCE_EVENTS, READINESS_STAGES } from "./contracts.model.ts";
import type { ReadinessProjection, DeclarationEventRow, ReadinessRequirement, ReadinessRequirementProjection, ReadinessStage, ReadinessEvidenceEvent, ReadinessEvidenceFacts } from "./contracts.model.ts";
import { issueIDToWorkID, uniqueStrings, workIDToIssueID } from "./contracts.values.ts";
import { parsedDeclaration, validateReadinessDeclaration, directDependencyWorkIDs, invalidRequirement } from "./contracts.declaration.ts";

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

export function projectRequirement(db: RunnerDatabase, requirement: ReadinessRequirement): ReadinessRequirementProjection {
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

export function matchingEvidence(evidence: EvidenceRecord, requirement: ReadinessRequirement): boolean {
  if (validateReadinessEvidence(evidence).length > 0) return false;
  const facts = readinessEvidenceFacts(evidence);
  return Boolean(facts)
    && facts!.environment === requirement.environment
    && facts!.release_window === requirement.release_window
    && facts!.runtime_revision === requirement.runtime_revision
    && facts!.source_revision === requirement.source_revision;
}

export function latestEvent(
  records: StoredEvidenceRecord[],
  event: ReadinessEvidenceEvent,
  migrationGate = ""
): StoredEvidenceRecord | undefined {
  return records.filter((item) => {
    const facts = readinessEvidenceFacts(item.evidence);
    return facts?.event === event && (event !== "gate_pass" || facts.migration_gate === migrationGate);
  }).at(-1);
}

export function missingForRequirement(
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
  const event = cleanString(facts.readiness_event) as ReadinessEvidenceEvent;
  if (!READINESS_EVIDENCE_EVENTS.includes(event)) return null;
  const output = {
    environment: cleanString(facts.environment),
    event,
    migration_gate: cleanString(facts.migration_gate),
    release_window: cleanString(facts.release_window),
    rollback_ref: cleanString(facts.rollback_ref),
    runtime_revision: cleanString(facts.runtime_revision),
    runtime_stamp: cleanString(facts.runtime_stamp),
    source_revision: cleanString(facts.source_revision)
  };
  return output.environment && output.release_window && output.runtime_revision && output.source_revision ? output : null;
}

export function emptyProjection(workID: WorkID): ReadinessProjection {
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

export function invalidProjection(workID: WorkID, eventID: number, declaredAt: string, detail: string): ReadinessProjection {
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

export function minimumStage(stages: Array<ReadinessStage | null>): ReadinessStage | null {
  if (stages.length === 0 || stages.some((stage) => stage === null)) return null;
  return stages.reduce<ReadinessStage>((minimum, stage) => (
    stageRank(stage) < stageRank(minimum) ? stage! : minimum
  ), "gate_passed");
}

export function stageRank(stage: ReadinessStage | null): number {
  return stage === null ? -1 : READINESS_STAGES.indexOf(stage);
}

export function nextStep(missing: string | undefined): string {
  if (!missing) return "Inspect readiness Evidence.";
  if (missing.startsWith("source_ready:")) return "Complete the source Work for the declared revision.";
  if (missing.startsWith("deployed:")) return "Record matching runtime stamp deployment Evidence with artifact and rollback refs.";
  if (missing.startsWith("observed:")) return "Record matching release-window Golden Journey observation Evidence.";
  if (missing.startsWith("gate_passed:")) return "Record matching migration gate Evidence.";
  return missing.replace(/^invalid:/, "");
}
