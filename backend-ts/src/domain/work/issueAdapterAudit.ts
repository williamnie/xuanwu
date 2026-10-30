import type { RunnerDatabase } from "../../db/database.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { type WorkLedgerEntry, type WorkTransitionAudit } from "./contracts.ts";
import {
  type IssueWorkMutationResult,
  parsedObject,
  ISSUE_WORK_WRITE_EVENT,
  type StoredAdapterAudit
} from "./issueAdapterModel.ts";
import { getIssueAsWork } from "./issueAdapterProjection.ts";

export function replayIssueWorkCreate(
  db: RunnerDatabase,
  eventID: string,
  fingerprint: string
): IssueWorkMutationResult | null {
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

export function replayAdapterWrite(
  db: RunnerDatabase,
  issueID: number,
  eventID: string,
  fingerprint: string
): IssueWorkMutationResult | null {
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

export function rejectAdapterWrite(
  db: RunnerDatabase,
  issueID: number,
  before: WorkLedgerEntry,
  audit: WorkTransitionAudit,
  fingerprint: string,
  operation: string,
  violations: string[],
  requested: unknown
): IssueWorkMutationResult {
  const uniqueViolations = [...new Set(violations)];
  recordAdapterWrite(db, issueID, audit, fingerprint, operation, "rejected", uniqueViolations, before, before, requested);
  return { applied: false, audit_event_id: audit.event_id, violations: uniqueViolations, work: before };
}

export function recordAdapterWrite(
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

export function mustGetIssueWork(db: RunnerDatabase, issueID: number): WorkLedgerEntry {
  const work = getIssueAsWork(db, issueID);
  if (!work) throw new Error(`Issue ${issueID} not found`);
  return work;
}
