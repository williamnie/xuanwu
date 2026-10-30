import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, type Issue } from "../../db/repositories/issues.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { READINESS_REQUIREMENTS_EVENT_TYPE, READINESS_REQUIREMENTS_SCHEMA_VERSION, READINESS_STAGES } from "./contracts.model.ts";
import type { ReadinessRequirementDeclaration, DeclarationEventRow, ReadinessRequirement, ReadinessRequirementProjection } from "./contracts.model.ts";
import { stableJson, issueIDToWorkID, uniqueStrings } from "./contracts.values.ts";

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

export function parsedDeclaration(payload: string): ReadinessRequirementDeclaration | null {
  try {
    const value = JSON.parse(payload) as ReadinessRequirementDeclaration;
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

export function validateReadinessDeclaration(declaration: ReadinessRequirementDeclaration, issueID: number): string[] {
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

export function directDependencyWorkIDs(db: RunnerDatabase, issue: Issue): Set<string> {
  return new Set(db.sqlite.query<{ target_work_id: string }, [string, string]>(`
    select target_work_id from work_relations
    where project_id=? and source_work_id=? and kind='depends_on'
  `).all(issue.project_id, issueIDToWorkID(issue.id)).map((row) => row.target_work_id));
}

export function invalidRequirement(
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
