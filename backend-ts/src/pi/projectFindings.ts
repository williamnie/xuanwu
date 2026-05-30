import type { RunnerDatabase } from "../db/database.ts";
import { redactSensitiveText } from "../util/redact.ts";

export type ProjectFinding = {
  issue_id: number;
  message: string;
  project_id: string;
  reason: string;
  severity: "blocked" | "needs_review";
  status: string;
  title: string;
  updated_at: string;
};

type IssueFindingRow = {
  error: unknown; id: unknown; project_id: unknown; status: unknown; title: unknown; updated_at: unknown;
};
type HoldFindingRow = {
  hold_since: unknown; last_check_error: unknown; message: unknown; project_id: unknown;
  reason: unknown; updated_at: unknown;
};

const ABSOLUTE_PATH_PATTERN = /(?:\/(?:Users|home|private|var|tmp)\/[^\s"'`,;)]*)/g;
const PROJECT_HOLD_ISSUE_ID = 0;

export function scanProjectFindings(db: RunnerDatabase, projectID: string): ProjectFinding[] {
  const id = projectID.trim();
  if (id === "") throw new Error("project id is required");
  return [...issueFindings(db, id), ...holdFindings(db, id)];
}

function issueFindings(db: RunnerDatabase, projectID: string): ProjectFinding[] {
  return db.sqlite.query<IssueFindingRow, [string]>(`
    select id, project_id, title, status, error, updated_at from issues
    where project_id=? and status in ('failed', 'pending_verification')
    order by case status when 'failed' then 0 else 1 end, updated_at asc, id asc
  `).all(projectID).map(mapIssueFinding);
}

function holdFindings(db: RunnerDatabase, projectID: string): ProjectFinding[] {
  if (!tableExists(db, "project_holds")) return [];
  return db.sqlite.query<HoldFindingRow, [string]>(`
    select project_id, reason, message, hold_since, last_check_error, updated_at
    from project_holds where project_id=? order by hold_since asc, updated_at asc
  `).all(projectID).map(mapHoldFinding);
}

function mapIssueFinding(row: IssueFindingRow): ProjectFinding {
  const status = optionalString(row.status, "unknown");
  const issueID = integerValue(row.id);
  const detail = redactFindingText(optionalString(row.error) || optionalString(row.title));
  return {
    issue_id: issueID,
    message: `${issueLead(status, issueID)}${detail ? `: ${detail}` : ""}`,
    project_id: optionalString(row.project_id),
    reason: status === "failed" ? "issue_failed" : "pending_verification",
    severity: status === "failed" ? "blocked" : "needs_review",
    status,
    title: redactFindingText(optionalString(row.title)),
    updated_at: optionalString(row.updated_at)
  };
}

function mapHoldFinding(row: HoldFindingRow): ProjectFinding {
  const reason = redactFindingText(optionalString(row.reason, "project_hold"));
  const detail = holdDetail(row);
  return {
    issue_id: PROJECT_HOLD_ISSUE_ID,
    message: `Project is on hold${detail ? `: ${detail}` : ""}`,
    project_id: optionalString(row.project_id),
    reason: `project_hold:${reason}`,
    severity: "blocked",
    status: "hold",
    title: "Project hold",
    updated_at: optionalString(row.updated_at) || optionalString(row.hold_since)
  };
}

function holdDetail(row: HoldFindingRow): string {
  return [optionalString(row.message), optionalString(row.last_check_error)]
    .map(redactFindingText)
    .filter(Boolean)
    .join("; ");
}

function issueLead(status: string, issueID: number): string {
  if (status === "failed") return `Issue #${issueID} failed`;
  return `Issue #${issueID} is pending verification`;
}

function tableExists(db: RunnerDatabase, table: string): boolean {
  const row = db.sqlite.query<{ name: string }, [string]>(
    "select name from sqlite_master where type='table' and name=?"
  ).get(table);
  return row?.name === table;
}

function redactFindingText(value: string): string {
  return redactSensitiveText(value).replace(ABSOLUTE_PATH_PATTERN, "[redacted-path]");
}

function optionalString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}

function integerValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
