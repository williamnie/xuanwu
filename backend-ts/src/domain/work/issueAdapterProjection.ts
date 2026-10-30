import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { latestIssueEventsByIssueID, listIssueEvents, type IssueEvent } from "../../db/repositories/issueEvents.ts";
import { countIssues, getIssue, listIssues, type Issue, type IssueFilter } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { resolveExecutorSelection, type AgentRecommendation } from "../../pi/runtime/agentOrchestration.ts";
import { makeDomainID, parseDomainID, type DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import { WORK_STATUSES, type WorkLedgerEntry, type WorkProvenance, type WorkStatus } from "./contracts.ts";
import { cleanString } from "../../util/values.ts";
import { effectiveAgentProfile } from "./issueAdapterValidation.ts";
import { parsedObject, domainActor } from "./issueAdapterModel.ts";

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
  return issues.map((issue) => projectIssueAsWork(db, issue, createdEvents.get(issue.id)));
}

export function countIssueBackedWorks(db: RunnerDatabase, filter: IssueFilter = {}): number {
  return countIssues(db, filter);
}

export function projectIssueAsWork(
  db: RunnerDatabase,
  issue: Issue,
  created?: IssueEvent
): WorkLedgerEntry {
  const createdEvent = created ?? listIssueEvents(db, issue.id, { limit: 1, types: ["issue.created"] })[0];
  const project = getProject(db, issue.project_id);
  const selection = project ? resolveExecutorSelection(db, project, issue) : null;
  return issueAsWork(issue, createdEvent, selection);
}

export function issueAsWork(
  issue: Issue,
  createdEvent?: IssueEvent,
  selection?: AgentRecommendation | null
): WorkLedgerEntry {
  const status = issueStatusToWorkStatus(issue.status);
  return {
    acceptance: {
      criteria: [{
        description: "Satisfy the authoritative Issue goal; PI judges the actual Provider Session and workspace facts.",
        id: "issue-delivery",
        required: true
      }],
      version: 1
    },
    created_at: issue.created_at,
    agent_profile_id: issue.agent_profile_id,
    ...(selection ? {
      effective_agent_profile: effectiveAgentProfile(issue, selection),
      effective_provider: selection.provider
    } : {}),
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
  if (status === "pending_verification") return "needs_user";
  if (!WORK_STATUSES.includes(status as WorkStatus)) throw new Error(`unsupported Issue status ${status}`);
  return status as WorkStatus;
}

function issueProvenance(issue: Issue, createdEvent?: IssueEvent): WorkProvenance {
  const eventPayload = parsedObject(createdEvent?.payload);
  const actor = domainActor(eventPayload?.actor);
  const correlationID = cleanString(eventPayload?.correlation_id);
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
  const authority = cleanString(source.authority);
  const externalID = cleanString(source.external_id);
  const sourceEventID = cleanString(source.source_event_id);
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
