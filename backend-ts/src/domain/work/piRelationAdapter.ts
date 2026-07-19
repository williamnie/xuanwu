import type { RunnerDatabase } from "../../db/database.ts";
import {
  listPiActionEvents,
  listPiActions,
  type PiAction
} from "../../db/repositories/pi/actions.ts";
import type { PiIssueCompletionWatch } from "../../db/repositories/pi/issueCompletionWatches.ts";
import { listIssueCompletionAutomations } from "../../pi/issueCompletionAutomation.ts";
import { listIssues, type Issue } from "../../db/repositories/issues.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import type { WorkID } from "./contracts.ts";
import { issueIDToWorkID } from "./issueAdapter.ts";

export const PI_WORK_RELATION_KINDS = ["execution", "authorization", "observation"] as const;
export type PiWorkRelationKind = typeof PI_WORK_RELATION_KINDS[number];

export const PI_WORK_RELATION_LIFECYCLES = [
  "pending",
  "active",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "expired",
  "legacy_unknown"
] as const;
export type PiWorkRelationLifecycle = typeof PI_WORK_RELATION_LIFECYCLES[number];

export type PiWorkCarrierAuthority =
  "pi_actions" | "automation_watches";

export type PiWorkRelatedRef = {
  authority: string;
  external_id: string;
};

export type PiWorkRelationSourceRef = {
  authority: PiWorkCarrierAuthority;
  event_refs: string[];
  external_id: string;
  related_refs: PiWorkRelatedRef[];
  source_status: string;
  updated_at: string;
};

export type PiWorkRelation = {
  kind: PiWorkRelationKind;
  lifecycle: PiWorkRelationLifecycle;
  project_id: string;
  relation_id: string;
  source_ref: PiWorkRelationSourceRef;
  work_id: WorkID;
};

export type PiWorkRelationGapReason =
  "missing_work_reference" | "missing_work" | "project_mismatch";

export type PiWorkRelationGap = {
  candidate_issue_id?: number;
  reason: PiWorkRelationGapReason;
  source_ref: PiWorkRelationSourceRef;
};

export type PiWorkRelationProjection = {
  relations: PiWorkRelation[];
  unmapped: PiWorkRelationGap[];
};

export type PiWorkRelationFilter = {
  project_id?: string;
  work_id?: WorkID;
};

type ActionProjection = {
  action: PiAction;
  event_refs: string[];
  issue_ids: number[];
};

type CompletionWatchProjection = Omit<PiIssueCompletionWatch, "status"> & { status: string };

type MutableProjection = {
  relations: Map<string, PiWorkRelation>;
  unmapped: Map<string, PiWorkRelationGap>;
};

/**
 * Read-only target-primary projection. PI actions and native Automation watches
 * are related to authoritative Work without creating another relation store.
 */
export function listPiWorkRelations(
  db: RunnerDatabase,
  filter: PiWorkRelationFilter = {}
): PiWorkRelationProjection {
  const issues = new Map(listIssues(db).map((issue) => [issue.id, issue]));
  const actionProjections = listPiActions(db).map((action) => projectAction(db, action));
  const output: MutableProjection = { relations: new Map(), unmapped: new Map() };

  for (const projection of actionProjections) projectActionRelations(output, issues, projection, filter);
  for (const watch of listCompletionWatches(db)) projectWatchRelations(output, issues, watch, filter);

  return {
    relations: [...output.relations.values()].sort(compareRelations),
    unmapped: [...output.unmapped.values()].sort(compareGaps)
  };
}

export function piWorkRelationID(
  kind: PiWorkRelationKind,
  authority: PiWorkCarrierAuthority,
  externalID: string,
  workID: WorkID
): string {
  return ["pi-work-relation", kind, authority, encodeURIComponent(externalID), encodeURIComponent(workID)].join(":");
}

export function piActionRelationLifecycle(status: string): PiWorkRelationLifecycle {
  const value = normalized(status);
  if (["candidate", "pending", "approved", "proposed", "proposal", "pending_approval", "changes_requested"]
    .includes(value)) return "pending";
  if (["executing", "running", "in_progress"].includes(value)) return "active";
  if (value === "snoozed" || value === "paused") return "paused";
  if (["completed", "succeeded", "success", "done"].includes(value)) return "completed";
  if (["failed", "error", "denied", "rejected", "timeout"].includes(value)) return "failed";
  if (["cancelled", "canceled", "skipped", "superseded"].includes(value)) return "cancelled";
  return "legacy_unknown";
}

export function piWatchRelationLifecycle(status: string): PiWorkRelationLifecycle {
  const value = normalized(status);
  if (value === "active") return "active";
  if (value === "satisfied" || value === "notified") return "completed";
  if (value === "failed") return "failed";
  if (value === "cancelled" || value === "canceled") return "cancelled";
  return "legacy_unknown";
}

function projectAction(db: RunnerDatabase, action: PiAction): ActionProjection {
  const events = listPiActionEvents(db, { actionId: action.id });
  return {
    action,
    event_refs: events.map((event) => makeDomainID("evidence", "pi_action_events", event.id)),
    issue_ids: actionIssueIDs(action)
  };
}

function projectActionRelations(
  output: MutableProjection,
  issues: Map<number, Issue>,
  projection: ActionProjection,
  filter: PiWorkRelationFilter
): void {
  const { action } = projection;
  const source = actionSourceRef(projection);
  projectCarrierTargets(output, issues, {
    carrier_project_id: action.project_id,
    filter,
    issue_ids: projection.issue_ids,
    kind: "execution",
    lifecycle: piActionRelationLifecycle(action.status),
    source_ref: source
  });
}

function projectWatchRelations(
  output: MutableProjection,
  issues: Map<number, Issue>,
  watch: CompletionWatchProjection,
  filter: PiWorkRelationFilter
): void {
  const relatedRefs: PiWorkRelatedRef[] = [];
  addRelatedRef(relatedRefs, "pi_conversations", watch.origin_conversation_id);
  addRelatedRef(relatedRefs, "source_events", watch.source_event_id);
  addRelatedRef(relatedRefs, "source_messages", watch.source_message_id);
  const source = sourceRef(
    "automation_watches",
    watch.id,
    watch.status,
    watch.updated_at,
    [],
    relatedRefs
  );
  const issueIDs = uniquePositiveIDs(watch.items.map((item) => item.issue_id));
  projectCarrierTargets(output, issues, {
    carrier_project_id: watch.project_id,
    filter,
    issue_ids: issueIDs,
    kind: "observation",
    lifecycle: piWatchRelationLifecycle(watch.status),
    source_ref: source
  });
}

function projectCarrierTargets(
  output: MutableProjection,
  issues: Map<number, Issue>,
  input: {
    carrier_project_id: string;
    filter: PiWorkRelationFilter;
    issue_ids: number[];
    kind: PiWorkRelationKind;
    lifecycle: PiWorkRelationLifecycle;
    source_ref: PiWorkRelationSourceRef;
  }
): void {
  if (input.issue_ids.length === 0) {
    if (carrierMatchesFilter(input.carrier_project_id, input.filter)) {
      addGap(output, { reason: "missing_work_reference", source_ref: input.source_ref });
    }
    return;
  }

  for (const issueID of input.issue_ids) {
    const issue = issues.get(issueID);
    if (!issue) {
      if (carrierMatchesFilter(input.carrier_project_id, input.filter)) {
        addGap(output, { candidate_issue_id: issueID, reason: "missing_work", source_ref: input.source_ref });
      }
      continue;
    }
    if (input.filter.project_id && issue.project_id !== input.filter.project_id) continue;
    const workID = issueIDToWorkID(issue.id);
    if (input.filter.work_id && workID !== input.filter.work_id) continue;
    if (input.carrier_project_id && input.carrier_project_id !== issue.project_id) {
      addGap(output, { candidate_issue_id: issueID, reason: "project_mismatch", source_ref: input.source_ref });
      continue;
    }
    const relationID = piWorkRelationID(input.kind, input.source_ref.authority, input.source_ref.external_id, workID);
    output.relations.set(relationID, {
      kind: input.kind,
      lifecycle: input.lifecycle,
      project_id: issue.project_id,
      relation_id: relationID,
      source_ref: input.source_ref,
      work_id: workID
    });
  }
}

function actionSourceRef(projection: ActionProjection): PiWorkRelationSourceRef {
  const relatedRefs: PiWorkRelatedRef[] = [];
  addRelatedRef(relatedRefs, "pi_conversations", projection.action.conversation_id);
  addRelatedRef(relatedRefs, "pi_delegations", projection.action.delegation_id);
  addRelatedRef(relatedRefs, "pi_guardian_decisions", projection.action.guardian_decision_id);
  addRelatedRef(relatedRefs, "pi_heartbeat_runs", projection.action.heartbeat_id);
  return sourceRef(
    "pi_actions",
    projection.action.id,
    projection.action.status,
    projection.action.updated_at,
    projection.event_refs,
    relatedRefs
  );
}

function sourceRef(
  authority: PiWorkCarrierAuthority,
  externalID: string,
  status: string,
  updatedAt: string,
  eventRefs: string[],
  relatedRefs: PiWorkRelatedRef[]
): PiWorkRelationSourceRef {
  return {
    authority,
    event_refs: uniqueStrings(eventRefs),
    external_id: externalID,
    related_refs: uniqueRelatedRefs(relatedRefs),
    source_status: status,
    updated_at: updatedAt
  };
}

function actionIssueIDs(action: PiAction): number[] {
  const payload = jsonObject(action.payload_json);
  const result = jsonObject(action.result_json);
  const candidates: unknown[] = [
    action.issue_id,
    payload.issue_id,
    payload.issue_ids,
    payload.target_issue_id,
    payload.target_issue_ids
  ];
  if (action.action_type === "issue.create" || action.action_type === "agent.workflow_request") {
    candidates.push(result.id, result.issue_id);
  }
  return uniquePositiveIDs(candidates.flatMap(positiveIDs));
}

function listCompletionWatches(db: RunnerDatabase): CompletionWatchProjection[] {
  return listIssueCompletionAutomations(db, { limit: 100 });
}

function positiveIDs(value: unknown): number[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((item) => typeof item === "number" ? item : Number(String(item ?? "").trim()))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

function uniquePositiveIDs(values: unknown[]): number[] {
  return [...new Set(values.flatMap(positiveIDs))].sort((a, b) => a - b);
}

function jsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function addRelatedRef(refs: PiWorkRelatedRef[], authority: string, externalID: string): void {
  if (externalID.trim()) refs.push({ authority, external_id: externalID.trim() });
}

function uniqueRelatedRefs(refs: PiWorkRelatedRef[]): PiWorkRelatedRef[] {
  const unique = new Map(refs.map((ref) => [`${ref.authority}:${ref.external_id}`, ref]));
  return [...unique.values()].sort((left, right) =>
    left.authority.localeCompare(right.authority) || left.external_id.localeCompare(right.external_id)
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function addGap(output: MutableProjection, gap: PiWorkRelationGap): void {
  const key = [gap.source_ref.authority, gap.source_ref.external_id, gap.reason, gap.candidate_issue_id ?? ""].join(":");
  output.unmapped.set(key, gap);
}

function carrierMatchesFilter(projectID: string, filter: PiWorkRelationFilter): boolean {
  if (filter.work_id) return false;
  return !filter.project_id || projectID === filter.project_id;
}

function compareRelations(left: PiWorkRelation, right: PiWorkRelation): number {
  return left.work_id.localeCompare(right.work_id) || left.kind.localeCompare(right.kind) ||
    left.relation_id.localeCompare(right.relation_id);
}

function compareGaps(left: PiWorkRelationGap, right: PiWorkRelationGap): number {
  return left.source_ref.authority.localeCompare(right.source_ref.authority) ||
    left.source_ref.external_id.localeCompare(right.source_ref.external_id) ||
    left.reason.localeCompare(right.reason) ||
    (left.candidate_issue_id ?? 0) - (right.candidate_issue_id ?? 0);
}

function normalized(value: string): string {
  return value.trim().toLowerCase();
}
