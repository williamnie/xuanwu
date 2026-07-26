import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { enqueueIssue, retryIssue, cancelIssue } from "../../db/repositories/issueActions.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import {
  latestIssueEventsByIssueID,
  listIssueEvents,
  recordIssueEvent,
  type IssueEvent
} from "../../db/repositories/issueEvents.ts";
import { countIssues, getIssue, listIssues, type Issue, type IssueFilter } from "../../db/repositories/issues.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { getWork } from "../../db/repositories/workLedger.ts";
import { makeDomainID, parseDomainID, type DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import {
  evaluateWorkTransition,
  WORK_STATUSES,
  type WorkLedgerEntry,
  type WorkProvenance,
  type WorkStatus,
  type WorkTransitionAudit
} from "./contracts.ts";
import { createWork, transitionWork, updateWork } from "./service.ts";

const ISSUE_WORK_WRITE_EVENT = "issue.work_adapter_write";
const ISSUE_WORK_SHADOW_MISMATCH_EVENT = "issue.work_shadow_mismatch";
const ISSUE_WORK_POLICY_REF = "agent-execution-contract";
const SHADOW_POLICY_REF = "xuanwu-work-shadow-v1";

export type IssueWorkShadowMode = "disabled" | "best_effort";
export type IssueWorkAction = "cancel" | "enqueue" | "retry";

export type IssueWorkPatch = Partial<Pick<WorkLedgerEntry, "goal" | "title">>;

export type IssueWorkCreateCommand = {
  audit: WorkTransitionAudit;
  depends_on_issue_ids?: number[];
  goal: string;
  project_id: string;
  source?: {
    authority: string;
    external_id: string;
    kind: "automation_trigger";
    source_event_id: string;
  };
  status: "todo" | "triage" | "in_progress";
  title: string;
  type: "engineering_task";
};

export type IssueWorkUpdateCommand = {
  audit: WorkTransitionAudit;
  expected_revision: number;
  patch: IssueWorkPatch;
  shadow_mode?: IssueWorkShadowMode;
  work_id: WorkLedgerEntry["id"];
};

export type IssueWorkActionCommand = {
  action: IssueWorkAction;
  audit: WorkTransitionAudit;
  expected_revision: number;
  shadow_mode?: IssueWorkShadowMode;
  work_id: WorkLedgerEntry["id"];
};

export type IssueWorkShadowResult = {
  error?: string;
  mismatches: string[];
  mode: IssueWorkShadowMode;
  status: "created" | "disabled" | "failed" | "matched" | "mismatch" | "updated";
  work_id: WorkLedgerEntry["id"];
};

export type IssueWorkDualReadResult = {
  authority: "issues";
  legacy: WorkLedgerEntry;
  mismatches: string[];
  status: "matched" | "mismatch" | "missing_target";
  target: WorkLedgerEntry | null;
  work: WorkLedgerEntry;
};

export type IssueWorkMutationResult = {
  applied: boolean;
  audit_event_id: string;
  shadow: IssueWorkShadowResult;
  violations: string[];
  work: WorkLedgerEntry;
};

type AdapterWriteOutcome = Omit<IssueWorkMutationResult, "shadow">;

type StoredAdapterAudit = {
  fingerprint: string;
  outcome: "applied" | "rejected";
  violations: string[];
};

export function issueIDToWorkID(issueID: number): WorkLedgerEntry["id"] {
  if (!Number.isSafeInteger(issueID) || issueID <= 0) throw new Error("issue id must be a positive integer");
  return makeDomainID("work", "issues", issueID);
}

export function workIDToIssueID(workID: string): number {
  const parsed = parseDomainID(workID);
  if (!parsed || parsed.kind !== "work" || parsed.authority !== "issues" || !/^[1-9]\d*$/.test(parsed.local_id)) {
    throw new Error(`${workID} is not a canonical Issue-backed Work id`);
  }
  const issueID = Number(parsed.local_id);
  if (!Number.isSafeInteger(issueID) || issueID <= 0 || issueIDToWorkID(issueID) !== workID) {
    throw new Error(`${workID} is not a canonical Issue-backed Work id`);
  }
  return issueID;
}

export function getIssueBackedWork(db: RunnerDatabase, workID: string): WorkLedgerEntry | null {
  const issue = getIssue(db, workIDToIssueID(workID));
  return issue ? projectIssueAsWork(db, issue) : null;
}

export function getIssueAsWork(db: RunnerDatabase, issueID: number): WorkLedgerEntry | null {
  const issue = getIssue(db, issueID);
  return issue ? projectIssueAsWork(db, issue) : null;
}

export function listIssueBackedWorks(db: RunnerDatabase, filter: IssueFilter = {}): WorkLedgerEntry[] {
  const issues = listIssues(db, filter);
  const createdEvents = latestIssueEventsByIssueID(db, issues.map((issue) => issue.id), "issue.created");
  return issues.map((issue) => issueAsWork(issue, createdEvents.get(issue.id)));
}

export function countIssueBackedWorks(db: RunnerDatabase, filter: IssueFilter = {}): number {
  return countIssues(db, filter);
}

export function projectIssueAsWork(db: RunnerDatabase, issue: Issue): WorkLedgerEntry {
  const createdEvent = listIssueEvents(db, issue.id, { limit: 1, types: ["issue.created"] })[0];
  return issueAsWork(issue, createdEvent);
}

export function issueAsWork(issue: Issue, createdEvent?: IssueEvent): WorkLedgerEntry {
  const status = issueStatusToWorkStatus(issue.status);
  return {
    acceptance: {
      completion_rule: "all_required",
      criteria: [{
        description: "Satisfy the authoritative Issue description and verification requirements.",
        id: "issue-delivery",
        required: true,
        verification_policy_ref: ISSUE_WORK_POLICY_REF
      }],
      requires_handoff: true,
      version: 1
    },
    created_at: issue.created_at,
    goal: issue.description.trim() || issue.title,
    id: issueIDToWorkID(issue.id),
    owner: { kind: "project", project_id: issue.project_id },
    provenance: issueProvenance(issue, createdEvent),
    revision: issueCompatibilityRevision(issue),
    status,
    title: issue.title,
    type: "engineering_task",
    updated_at: issue.updated_at,
    workflow_ref: issueWorkflowRef(issue)
  };
}

export function issueStatusToWorkStatus(status: string): WorkStatus {
  if (!WORK_STATUSES.includes(status as WorkStatus)) throw new Error(`unsupported Issue status ${status}`);
  return status as WorkStatus;
}

export function workStatusToIssueStatus(status: WorkStatus): string {
  if (!WORK_STATUSES.includes(status)) throw new Error(`unsupported Work status ${status}`);
  return status;
}

export function createIssueBackedWork(
  db: RunnerDatabase,
  command: IssueWorkCreateCommand
): IssueWorkMutationResult {
  const violations = [
    ...auditViolations(command.audit),
    ...createViolations(command)
  ];
  if (violations.length > 0) throw new Error([...new Set(violations)].join("; "));
  const fingerprint = createFingerprint(command);
  const write = db.transaction((): AdapterWriteOutcome => {
    const replay = replayIssueWorkCreate(db, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const issue = createIssue(db, {
      depends_on_issue_ids: command.depends_on_issue_ids,
      description: command.goal,
      project_id: command.project_id,
      status: command.status,
      title: command.title
    }, {
      createdEventPayload: {
        actor: command.audit.actor,
        correlation_id: command.audit.correlation_id,
        event_id: command.audit.event_id,
        fingerprint,
        gate: command.audit.gate,
        operation: "create",
        outcome: "applied",
        reason: command.audit.reason,
        ...(command.source ? { source: command.source } : {})
      }
    });
    return {
      applied: true,
      audit_event_id: command.audit.event_id,
      violations: [],
      work: projectIssueAsWork(db, issue)
    };
  }).immediate();
  return { ...write, shadow: disabledShadow(write.work.id) };
}

export function updateIssueBackedWork(
  db: RunnerDatabase,
  command: IssueWorkUpdateCommand
): IssueWorkMutationResult {
  const fingerprint = mutationFingerprint("update", command);
  const issueID = workIDToIssueID(command.work_id);
  const write = db.transaction((): AdapterWriteOutcome => {
    const replay = replayAdapterWrite(db, issueID, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const before = mustGetIssueWork(db, issueID);
    const violations = [
      ...auditViolations(command.audit),
      ...revisionViolations(command.expected_revision, before.revision),
      ...patchViolations(command.patch)
    ];
    if (violations.length > 0) {
      return rejectAdapterWrite(db, issueID, before, command.audit, fingerprint, "update", violations, command.patch);
    }
    try {
      updateIssue(db, issueID, issuePatch(command.patch));
    } catch (error) {
      return rejectAdapterWrite(db, issueID, before, command.audit, fingerprint, "update", [errorMessage(error)], command.patch);
    }
    const after = mustGetIssueWork(db, issueID);
    recordAdapterWrite(db, issueID, command.audit, fingerprint, "update", "applied", [], before, after, command.patch);
    return { applied: true, audit_event_id: command.audit.event_id, violations: [], work: after };
  }).immediate();
  return attachShadow(db, write, command.audit, command.shadow_mode);
}

export function applyIssueWorkAction(
  db: RunnerDatabase,
  command: IssueWorkActionCommand
): IssueWorkMutationResult {
  const fingerprint = mutationFingerprint("action", command);
  const issueID = workIDToIssueID(command.work_id);
  const write = db.transaction((): AdapterWriteOutcome => {
    const replay = replayAdapterWrite(db, issueID, command.audit.event_id, fingerprint);
    if (replay) return replay;
    const before = mustGetIssueWork(db, issueID);
    const target = actionTargetStatus(command.action);
    const idempotentEnqueue = command.action === "enqueue" && before.status === "todo";
    const decision = evaluateWorkTransition({ relations: [], works: [before] }, {
      audit: command.audit,
      expected_revision: command.expected_revision,
      to: target,
      work_id: before.id
    });
    const violations = idempotentEnqueue
      ? decision.violations.filter((violation) => violation !== "illegal Work transition todo -> todo")
      : decision.violations;
    if (violations.length > 0) {
      return rejectAdapterWrite(db, issueID, before, command.audit, fingerprint, command.action, violations, { to: target });
    }
    if (!idempotentEnqueue) {
      try {
        applyLegacyIssueAction(db, issueID, command.action, command.audit.reason);
      } catch (error) {
        return rejectAdapterWrite(db, issueID, before, command.audit, fingerprint, command.action, [errorMessage(error)], { to: target });
      }
    }
    const after = mustGetIssueWork(db, issueID);
    if (after.status !== target) {
      return rejectAdapterWrite(db, issueID, after, command.audit, fingerprint, command.action,
        [`legacy Issue action left status ${after.status}; expected ${target}`], { to: target });
    }
    recordAdapterWrite(db, issueID, command.audit, fingerprint, command.action, "applied", [], before, after, {
      ...(idempotentEnqueue ? { idempotent: true } : {}),
      to: target
    });
    return { applied: true, audit_event_id: command.audit.event_id, violations: [], work: after };
  }).immediate();
  return attachShadow(db, write, command.audit, command.shadow_mode);
}

export function readIssueWorkDual(
  db: RunnerDatabase,
  issueID: number
): IssueWorkDualReadResult | null {
  const legacy = getIssueAsWork(db, issueID);
  if (!legacy) return null;
  const target = getWork(db, legacy.id);
  if (!target) {
    return {
      authority: "issues",
      legacy,
      mismatches: ["target_missing"],
      status: "missing_target",
      target: null,
      work: legacy
    };
  }
  const mismatches = issueWorkShadowMismatches(legacy, target);
  return {
    authority: "issues",
    legacy,
    mismatches,
    status: mismatches.length > 0 ? "mismatch" : "matched",
    target,
    work: legacy
  };
}

export function syncIssueWorkShadow(
  db: RunnerDatabase,
  issueID: number,
  audit: WorkTransitionAudit
): IssueWorkShadowResult {
  const projection = mustGetIssueWork(db, issueID);
  const gateViolations = auditViolations(audit);
  if (gateViolations.length > 0) {
    recordShadowMismatch(db, issueID, audit, projection.id, gateViolations);
    return {
      error: gateViolations.join("; "),
      mismatches: gateViolations,
      mode: "best_effort",
      status: "failed",
      work_id: projection.id
    };
  }
  try {
    let shadow = getWork(db, projection.id);
    let changed = false;
    let created = false;
    if (!shadow) {
      const createdResult = createWork(db, {
        audit: shadowAudit(audit, "create"),
        work: withoutPersistenceFields(projection)
      });
      shadow = createdResult.work;
      changed = createdResult.applied;
      created = createdResult.applied;
    } else {
      const patch = shadowPatch(projection, shadow);
      if (Object.keys(patch).length > 0) {
        const updated = updateWork(db, {
          audit: shadowAudit(audit, "update"),
          expected_revision: shadow.revision,
          patch,
          work_id: shadow.id
        });
        shadow = updated.work;
        changed ||= updated.applied;
      }
      if (shadow.status !== projection.status) {
        const transitioned = transitionWork(db, {
          audit: shadowAudit(audit, "status"),
          expected_revision: shadow.revision,
          to: projection.status,
          work_id: shadow.id
        });
        shadow = transitioned.work;
        changed ||= transitioned.applied;
      }
    }
    const mismatches = issueWorkShadowMismatches(projection, shadow);
    if (mismatches.length > 0) {
      recordShadowMismatch(db, issueID, audit, projection.id, mismatches);
      return { mismatches, mode: "best_effort", status: "mismatch", work_id: projection.id };
    }
    return {
      mismatches: [],
      mode: "best_effort",
      status: created ? "created" : changed ? "updated" : "matched",
      work_id: projection.id
    };
  } catch (error) {
    const message = errorMessage(error);
    recordShadowMismatch(db, issueID, audit, projection.id, [message]);
    return { error: message, mismatches: [message], mode: "best_effort", status: "failed", work_id: projection.id };
  }
}

function attachShadow(
  db: RunnerDatabase,
  result: AdapterWriteOutcome,
  audit: WorkTransitionAudit,
  mode: IssueWorkShadowMode = "disabled"
): IssueWorkMutationResult {
  if (!result.applied || mode === "disabled") {
    return { ...result, shadow: disabledShadow(result.work.id) };
  }
  return { ...result, shadow: syncIssueWorkShadow(db, workIDToIssueID(result.work.id), audit) };
}

function disabledShadow(workID: WorkLedgerEntry["id"]): IssueWorkShadowResult {
  return { mismatches: [], mode: "disabled", status: "disabled", work_id: workID };
}

function issueProvenance(issue: Issue, createdEvent?: IssueEvent): WorkProvenance {
  const eventPayload = parsedObject(createdEvent?.payload);
  const actor = domainActor(eventPayload?.actor);
  const correlationID = stringValue(eventPayload?.correlation_id);
  const source = automationSource(eventPayload?.source, actor, correlationID, createdEvent?.created_at || issue.created_at);
  if (source) {
    return {
      causes: [{
        authority: "issues", completeness: "complete", correlation_id: correlationID,
        external_id: String(issue.id), kind: "issue", occurred_at: createdEvent?.created_at || issue.created_at,
        actor: actor!, source_event_id: makeDomainID("evidence", "issue_events", createdEvent!.id)
      }],
      origin: source
    };
  }
  const common = {
    authority: "issues",
    external_id: String(issue.id),
    kind: "issue" as const,
    occurred_at: createdEvent?.created_at || issue.created_at,
    ...(createdEvent ? { source_event_id: makeDomainID("evidence", "issue_events", createdEvent.id) } : {})
  };
  if (actor && correlationID) {
    return { causes: [], origin: { ...common, actor, completeness: "complete", correlation_id: correlationID } };
  }
  const missingFields = [!actor ? "actor" : "", !correlationID ? "correlation_id" : ""].filter(Boolean);
  return {
    causes: [],
    origin: {
      ...common,
      ...(actor ? { actor } : {}),
      ...(correlationID ? { correlation_id: correlationID } : {}),
      completeness: "legacy_incomplete",
      missing_fields: missingFields
    }
  };
}

function automationSource(
  value: unknown,
  actor: DomainActor | undefined,
  correlationID: string,
  occurredAt: string
): WorkProvenance["origin"] | undefined {
  if (!actor || !correlationID || !value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const authority = stringValue(source.authority);
  const externalID = stringValue(source.external_id);
  const sourceEventID = stringValue(source.source_event_id);
  if (authority !== "automation_definitions" || !externalID || !sourceEventID || source.kind !== "automation_trigger") return undefined;
  return {
    actor, authority, completeness: "complete", correlation_id: correlationID,
    external_id: externalID, kind: "automation_trigger", occurred_at: occurredAt, source_event_id: sourceEventID
  };
}

function issueCompatibilityRevision(issue: Issue): number {
  const digest = createHash("sha256").update(JSON.stringify([
    issue.id,
    issue.project_id,
    issue.title,
    issue.description,
    issue.status,
    issue.required_skill_intents,
    issue.recommended_skill_intents,
    issue.required_mcp_capabilities,
    issue.recommended_mcp_capabilities,
    issue.service_tier,
    issue.agent_profile_id,
    issue.source_session_id,
    issue.source_turn_id,
    issue.source_excerpt,
    issue.workflow_snapshot_json,
    issue.updated_at
  ])).digest("hex").slice(0, 13);
  return Number.parseInt(digest, 16);
}

function issueWorkflowRef(issue: Issue): string {
  const source = issue.workflow_snapshot_json.trim() || "workflow:implement@1";
  const digest = createHash("sha256").update(source).digest("hex").slice(0, 16);
  return `issues:${issue.id}:workflow:${digest}`;
}

function actionTargetStatus(action: IssueWorkAction): WorkStatus {
  return action === "cancel" ? "cancelled" : "todo";
}

function applyLegacyIssueAction(db: RunnerDatabase, issueID: number, action: IssueWorkAction, reason: string): Issue {
  if (action === "enqueue") return enqueueIssue(db, issueID);
  if (action === "retry") return retryIssue(db, issueID);
  return cancelIssue(db, issueID, reason);
}

function issuePatch(patch: IssueWorkPatch): { description?: string; title?: string } {
  return {
    ...(patch.goal !== undefined ? { description: patch.goal } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {})
  };
}

function patchViolations(patch: IssueWorkPatch): string[] {
  const keys = Object.keys(patch);
  const violations: string[] = [];
  const unsupported = keys.filter((key) => key !== "goal" && key !== "title");
  if (unsupported.length > 0) violations.push(`unsupported Issue-backed Work fields: ${unsupported.join(", ")}`);
  if (keys.length === 0) violations.push("Issue-backed Work patch is empty");
  if (patch.title !== undefined && patch.title.trim() === "") violations.push("Work title is required");
  if (patch.goal !== undefined && patch.goal.trim() === "") violations.push("Work goal is required");
  return violations;
}

function createViolations(command: IssueWorkCreateCommand): string[] {
  const violations: string[] = [];
  if (!command.project_id.trim()) violations.push("project_id is required");
  if (!command.title.trim()) violations.push("Work title is required");
  if (!command.goal.trim()) violations.push("Work goal is required");
  if (command.type !== "engineering_task") {
    violations.push("Issue-backed Work type must be engineering_task");
  }
  if (command.status !== "triage" && command.status !== "todo" &&
    !(command.status === "in_progress" && command.source?.kind === "automation_trigger")) {
    violations.push("Issue-backed Work must be created in triage or todo unless a governed Automation dispatch starts its Run");
  }
  return violations;
}

function auditViolations(audit: WorkTransitionAudit): string[] {
  const violations: string[] = [];
  if (!audit.event_id.trim()) violations.push("event_id is required");
  if (!audit.actor.id.trim()) violations.push("actor.id is required");
  if (!["user", "supervisor", "runner", "guardian", "automation", "system"].includes(audit.actor.kind)) {
    violations.push("actor.kind is invalid");
  }
  if (!audit.reason.trim()) violations.push("reason is required");
  if (!audit.correlation_id.trim()) violations.push("correlation_id is required");
  if (!Number.isFinite(Date.parse(audit.occurred_at))) violations.push("occurred_at must be a timestamp");
  if (audit.gate.authority !== "deterministic_policy" && audit.gate.authority !== "human_approval") {
    violations.push("gate authority is not trusted");
  }
  if (audit.gate.decision === "deny") violations.push("mutation gate denied");
  if (audit.gate.decision === "ask") violations.push("mutation gate requires approval");
  if (audit.gate.decision !== "allow" && audit.gate.decision !== "deny" && audit.gate.decision !== "ask") {
    violations.push("gate decision is invalid");
  }
  if (!audit.gate.policy_ref.trim()) violations.push("gate policy_ref is required");
  return violations;
}

function revisionViolations(expected: number, actual: number): string[] {
  if (!Number.isSafeInteger(expected) || expected < 0) return ["expected revision must be a non-negative integer"];
  return expected === actual ? [] : [`expected revision ${expected} does not match ${actual}`];
}

function mutationFingerprint(operation: string, command: IssueWorkUpdateCommand | IssueWorkActionCommand): string {
  const body = "patch" in command
    ? { operation, work_id: command.work_id, expected_revision: command.expected_revision, patch: command.patch, audit: command.audit }
    : { operation, work_id: command.work_id, expected_revision: command.expected_revision, action: command.action, audit: command.audit };
  return createHash("sha256").update(stableJson(body)).digest("hex");
}

function createFingerprint(command: IssueWorkCreateCommand): string {
  return createHash("sha256").update(stableJson({ command, operation: "create" })).digest("hex");
}

function replayIssueWorkCreate(
  db: RunnerDatabase,
  eventID: string,
  fingerprint: string
): AdapterWriteOutcome | null {
  const existing = db.sqlite.query<{ issue_id: number; payload: string }, [string]>(`
    select issue_id, payload from issue_events
    where type='issue.created'
      and json_extract(case when json_valid(payload) then payload else '{}' end, '$.event_id')=?
    order by id asc limit 1
  `).get(eventID);
  if (!existing) return null;
  const payload = parsedObject(existing.payload);
  if (payload?.fingerprint !== fingerprint) {
    throw new Error(`Issue Work adapter event ${eventID} conflicts with another command`);
  }
  return {
    applied: true,
    audit_event_id: eventID,
    violations: [],
    work: mustGetIssueWork(db, existing.issue_id)
  };
}

function replayAdapterWrite(
  db: RunnerDatabase,
  issueID: number,
  eventID: string,
  fingerprint: string
): AdapterWriteOutcome | null {
  if (!eventID.trim()) return null;
  const rows = db.sqlite.query<{ payload: string }, [number, string]>(`
    select payload from issue_events
    where issue_id=? and type=? order by id desc
  `).all(issueID, ISSUE_WORK_WRITE_EVENT);
  const existing = rows.map((row) => parsedObject(row.payload))
    .find((payload) => payload?.event_id === eventID);
  if (!existing) return null;
  if (existing.fingerprint !== fingerprint) throw new Error(`Issue Work adapter event ${eventID} conflicts with another command`);
  const stored = existing as unknown as StoredAdapterAudit;
  return {
    applied: stored.outcome === "applied",
    audit_event_id: eventID,
    violations: Array.isArray(stored.violations) ? stored.violations.filter((item): item is string => typeof item === "string") : [],
    work: mustGetIssueWork(db, issueID)
  };
}

function rejectAdapterWrite(
  db: RunnerDatabase,
  issueID: number,
  before: WorkLedgerEntry,
  audit: WorkTransitionAudit,
  fingerprint: string,
  operation: string,
  violations: string[],
  requested: unknown
): AdapterWriteOutcome {
  const uniqueViolations = [...new Set(violations)];
  recordAdapterWrite(db, issueID, audit, fingerprint, operation, "rejected", uniqueViolations, before, before, requested);
  return { applied: false, audit_event_id: audit.event_id, violations: uniqueViolations, work: before };
}

function recordAdapterWrite(
  db: RunnerDatabase,
  issueID: number,
  audit: WorkTransitionAudit,
  fingerprint: string,
  operation: string,
  outcome: "applied" | "rejected",
  violations: string[],
  before: WorkLedgerEntry,
  after: WorkLedgerEntry,
  requested: unknown
): void {
  recordIssueEvent(db, issueID, ISSUE_WORK_WRITE_EVENT, {
    actor: audit.actor,
    after_revision: after.revision,
    before_revision: before.revision,
    correlation_id: audit.correlation_id,
    event_id: audit.event_id,
    fingerprint,
    gate: audit.gate,
    operation,
    outcome,
    reason: audit.reason,
    requested,
    violations,
    work_id: before.id
  });
}

function shadowAudit(audit: WorkTransitionAudit, operation: string): WorkTransitionAudit {
  return {
    ...audit,
    event_id: `${audit.event_id}:shadow:${operation}`,
    gate: { authority: "deterministic_policy", decision: "allow", policy_ref: SHADOW_POLICY_REF },
    reason: `${audit.reason} (Issue-authoritative Work shadow ${operation})`
  };
}

function shadowPatch(projection: WorkLedgerEntry, shadow: WorkLedgerEntry) {
  return {
    ...(projection.acceptance !== shadow.acceptance && !sameJson(projection.acceptance, shadow.acceptance)
      ? { acceptance: projection.acceptance } : {}),
    ...(projection.goal !== shadow.goal ? { goal: projection.goal } : {}),
    ...(projection.provenance !== shadow.provenance && !sameJson(projection.provenance, shadow.provenance)
      ? { provenance: projection.provenance } : {}),
    ...(projection.title !== shadow.title ? { title: projection.title } : {}),
    ...(projection.type !== shadow.type ? { type: projection.type } : {}),
    ...(projection.workflow_ref !== shadow.workflow_ref ? { workflow_ref: projection.workflow_ref } : {})
  };
}

export function issueWorkShadowMismatches(projection: WorkLedgerEntry, shadow: WorkLedgerEntry): string[] {
  const mismatches: string[] = [];
  if (projection.id !== shadow.id) mismatches.push("id");
  if (projection.owner.project_id !== shadow.owner.project_id) mismatches.push("owner.project_id");
  if (projection.type !== shadow.type) mismatches.push("type");
  if (projection.title !== shadow.title) mismatches.push("title");
  if (projection.goal !== shadow.goal) mismatches.push("goal");
  if (projection.status !== shadow.status) mismatches.push("status");
  if (!sameJson(projection.acceptance, shadow.acceptance)) mismatches.push("acceptance");
  if (!sameJson(projection.provenance, shadow.provenance)) mismatches.push("provenance");
  if (projection.workflow_ref !== shadow.workflow_ref) mismatches.push("workflow_ref");
  return mismatches;
}

function recordShadowMismatch(
  db: RunnerDatabase,
  issueID: number,
  audit: WorkTransitionAudit,
  workID: WorkLedgerEntry["id"],
  mismatches: string[]
): void {
  try {
    const alreadyRecorded = db.sqlite.query<{ count: number }, [number, string, string]>(`
      select count(*) as count from issue_events
      where issue_id=? and type=? and json_extract(payload, '$.event_id')=?
    `).get(issueID, ISSUE_WORK_SHADOW_MISMATCH_EVENT, audit.event_id)?.count ?? 0;
    if (alreadyRecorded > 0) return;
    recordIssueEvent(db, issueID, ISSUE_WORK_SHADOW_MISMATCH_EVENT, {
      actor: audit.actor,
      correlation_id: audit.correlation_id,
      event_id: audit.event_id,
      mismatches,
      reason: audit.reason,
      work_id: workID
    });
  } catch {
    // Shadow observability is best effort and must never roll back the legacy authority write.
  }
}

function withoutPersistenceFields(work: WorkLedgerEntry): Omit<WorkLedgerEntry, "created_at" | "revision" | "updated_at"> {
  const { created_at: _createdAt, revision: _revision, updated_at: _updatedAt, ...input } = work;
  return input;
}

function mustGetIssueWork(db: RunnerDatabase, issueID: number): WorkLedgerEntry {
  const work = getIssueAsWork(db, issueID);
  if (!work) throw new Error(`Issue ${issueID} not found`);
  return work;
}

function parsedObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function domainActor(value: unknown): DomainActor | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const actor = value as Record<string, unknown>;
  const id = stringValue(actor.id);
  const kind = stringValue(actor.kind);
  if (!id || !["user", "supervisor", "runner", "guardian", "automation", "system"].includes(kind)) return undefined;
  return { id, kind: kind as DomainActor["kind"] };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortJson(item)])
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
