import type { RunnerDatabase } from "../database.ts";
import { getIssue } from "./issues.ts";
import { getProject } from "./projects.ts";

export const TRACKER_ISSUE_PROVIDERS = ["fake", "github", "gitlab", "linear"] as const;
export type TrackerIssueProvider = typeof TRACKER_ISSUE_PROVIDERS[number];

export type TrackerProjectMapping = {
  created_at: string;
  project_id: string;
  provider: TrackerIssueProvider;
  scope: string;
  updated_at: string;
};

export type TrackerIssueLink = {
  created_at: string;
  external_id: string;
  issue_id: number;
  last_external_updated_at: string;
  last_synced_issue_updated_at: string;
  project_id: string;
  provider: TrackerIssueProvider;
  updated_at: string;
};

export type TrackerSyncAudit = {
  action: string;
  correlation_id: string;
  detail?: Record<string, unknown>;
  external_id: string;
  issue_id?: number;
  project_id?: string;
  provider: TrackerIssueProvider;
};

export function trackerIssueProvider(value: unknown): TrackerIssueProvider {
  const provider = text(value, "provider").toLowerCase();
  if (!TRACKER_ISSUE_PROVIDERS.includes(provider as TrackerIssueProvider)) {
    throw new Error("provider must be fake, github, gitlab, or linear");
  }
  return provider as TrackerIssueProvider;
}

export function upsertTrackerProjectMapping(
  db: RunnerDatabase,
  input: { project_id: string; provider: TrackerIssueProvider; scope: string },
  timestamp = new Date()
): TrackerProjectMapping {
  const provider = trackerIssueProvider(input.provider);
  const scope = trackerScope(input.scope);
  const projectID = text(input.project_id, "project_id");
  if (!getProject(db, projectID)) throw new Error("project not found");
  const previous = getTrackerProjectMapping(db, provider, scope);
  const now = timestamp.toISOString();
  db.sqlite.run(`insert into tracker_project_mappings (provider, scope, project_id, created_at, updated_at)
    values (?, ?, ?, ?, ?) on conflict(provider, scope) do update set project_id=excluded.project_id, updated_at=excluded.updated_at`,
  [provider, scope, projectID, previous?.created_at ?? now, now]);
  const saved = getTrackerProjectMapping(db, provider, scope);
  if (!saved) throw new Error("tracker project mapping missing after write");
  return saved;
}

export function getTrackerProjectMapping(db: RunnerDatabase, provider: unknown, scope: unknown): TrackerProjectMapping | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(
    "select provider, scope, project_id, created_at, updated_at from tracker_project_mappings where provider=? and scope=?"
  ).get(trackerIssueProvider(provider), trackerScope(scope));
  return row ? mapProject(row) : null;
}

export function upsertTrackerIssueLink(
  db: RunnerDatabase,
  input: { external_id: string; issue_id: number; last_external_updated_at?: string; last_synced_issue_updated_at?: string; provider: TrackerIssueProvider },
  timestamp = new Date()
): TrackerIssueLink {
  const provider = trackerIssueProvider(input.provider);
  const externalID = text(input.external_id, "external_id");
  const issueID = positiveInteger(input.issue_id, "issue_id");
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error("issue not found");
  const existing = getTrackerIssueLink(db, provider, externalID);
  if (existing && existing.issue_id !== issueID) throw new Error("tracker issue is already linked to another runner issue");
  const now = timestamp.toISOString();
  db.sqlite.run(`insert into tracker_issue_links (
    provider, external_id, project_id, issue_id, last_external_updated_at, last_synced_issue_updated_at, created_at, updated_at
  ) values (?, ?, ?, ?, ?, ?, ?, ?) on conflict(provider, external_id) do update set
    last_external_updated_at=excluded.last_external_updated_at,
    last_synced_issue_updated_at=excluded.last_synced_issue_updated_at,
    updated_at=excluded.updated_at`, [
    provider, externalID, issue.project_id, issueID,
    optionalText(input.last_external_updated_at) || existing?.last_external_updated_at || "",
    optionalText(input.last_synced_issue_updated_at) || existing?.last_synced_issue_updated_at || "",
    existing?.created_at ?? now, now
  ]);
  const saved = getTrackerIssueLink(db, provider, externalID);
  if (!saved) throw new Error("tracker issue link missing after write");
  return saved;
}

export function getTrackerIssueLink(db: RunnerDatabase, provider: unknown, externalID: unknown): TrackerIssueLink | null {
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(`select provider, external_id, project_id, issue_id,
    last_external_updated_at, last_synced_issue_updated_at, created_at, updated_at
    from tracker_issue_links where provider=? and external_id=?`).get(trackerIssueProvider(provider), text(externalID, "external_id"));
  return row ? mapLink(row) : null;
}

export function saveTrackerCursor(db: RunnerDatabase, input: { position: string; provider: TrackerIssueProvider; scope: string }, timestamp = new Date()): void {
  db.sqlite.run(`insert into tracker_sync_cursors (provider, scope, position, updated_at) values (?, ?, ?, ?)
    on conflict(provider, scope) do update set position=excluded.position, updated_at=excluded.updated_at`,
  [trackerIssueProvider(input.provider), trackerScope(input.scope), text(input.position, "cursor.position"), timestamp.toISOString()]);
}

export function recordTrackerSyncAudit(db: RunnerDatabase, input: TrackerSyncAudit, timestamp = new Date()): void {
  db.sqlite.run(`insert into tracker_sync_events (provider, external_id, project_id, issue_id, action, correlation_id, detail_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)`, [
    trackerIssueProvider(input.provider), optionalText(input.external_id), optionalText(input.project_id),
    input.issue_id ? positiveInteger(input.issue_id, "issue_id") : 0, text(input.action, "action"),
    text(input.correlation_id, "correlation_id"), JSON.stringify(input.detail ?? {}), timestamp.toISOString()
  ]);
}

export function trackerScope(value: unknown): string { return text(value, "scope").toLowerCase(); }
function mapProject(row: Record<string, unknown>): TrackerProjectMapping { return { provider: trackerIssueProvider(row.provider), scope: trackerScope(row.scope), project_id: text(row.project_id, "project_id"), created_at: text(row.created_at, "created_at"), updated_at: text(row.updated_at, "updated_at") }; }
function mapLink(row: Record<string, unknown>): TrackerIssueLink { return { provider: trackerIssueProvider(row.provider), external_id: text(row.external_id, "external_id"), project_id: text(row.project_id, "project_id"), issue_id: positiveInteger(row.issue_id, "issue_id"), last_external_updated_at: optionalText(row.last_external_updated_at), last_synced_issue_updated_at: optionalText(row.last_synced_issue_updated_at), created_at: text(row.created_at, "created_at"), updated_at: text(row.updated_at, "updated_at") }; }
function text(value: unknown, label: string): string { const output = optionalText(value); if (!output) throw new Error(`${label} is required`); if (output.length > 4096 || /[\0\r\n]/.test(output)) throw new Error(`${label} is invalid`); return output; }
function optionalText(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function positiveInteger(value: unknown, label: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`); return value; }
