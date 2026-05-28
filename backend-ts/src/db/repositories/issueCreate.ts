import type { RunnerDatabase } from "../database.ts";
import { getIssue, type Issue } from "./issues.ts";
import { ProjectNotFoundError } from "./projects.ts";

export type CreateIssueInput = Partial<Record<keyof NormalizedIssueWrite, unknown>>;

type NormalizedIssueWrite = {
  agent_profile_id: string;
  description: string;
  priority: number;
  project_id: string;
  prompt_template: string;
  source_excerpt: string;
  source_session_id: string;
  source_turn_id: string;
  status: string;
  template_id: string;
  title: string;
  workflow_snapshot_json: string;
};

export const ISSUE_TITLE_MAX_RUNES = 50;
export const VALID_ISSUE_STATUSES = new Set([
  "triage",
  "todo",
  "in_progress",
  "pending_verification",
  "done",
  "failed",
  "cancelled"
]);

export function createIssue(db: RunnerDatabase, input: CreateIssueInput): Issue {
  const issue = normalizeIssueForWrite(input);
  validateIssueForCreate(db, issue);
  const timestamp = issueTimestamp();
  const insertIssue = db.transaction((record: NormalizedIssueWrite) => {
    db.sqlite.run(`insert into issues
      (project_id, title, description, status, priority, template_id,
       prompt_template, agent_profile_id, source_session_id, source_turn_id,
       source_excerpt, workflow_snapshot_json, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.project_id, record.title, record.description, record.status, record.priority,
        record.template_id, record.prompt_template, record.agent_profile_id,
        record.source_session_id, record.source_turn_id, record.source_excerpt,
        record.workflow_snapshot_json, timestamp, timestamp]);
    const id = lastInsertID(db);
    db.sqlite.run(
      `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
      [id, "issue.created", "", timestamp]
    );
    return id;
  });
  return mustGetIssue(db, insertIssue(issue));
}

function validateIssueForCreate(db: RunnerDatabase, issue: NormalizedIssueWrite): void {
  if (!projectExists(db, issue.project_id)) throw new ProjectNotFoundError();
  if (!VALID_ISSUE_STATUSES.has(issue.status)) throw new Error("status 不合法");
  if (issue.title === "") throw new Error("issue 内容不能为空");
}

function projectExists(db: RunnerDatabase, id: string): boolean {
  const row = db.sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from projects where id = ?"
  ).get(id);
  return (row?.count ?? 0) > 0;
}

function normalizeIssueForWrite(input: CreateIssueInput): NormalizedIssueWrite {
  const description = cleanString(input.description);
  const title = cleanString(input.title) || deriveIssueTitle(description);
  return {
    project_id: cleanString(input.project_id),
    title,
    description,
    status: cleanString(input.status) || "triage",
    priority: integerInput(input.priority),
    template_id: cleanString(input.template_id),
    prompt_template: cleanString(input.prompt_template),
    agent_profile_id: normalizeIdentifier(input.agent_profile_id),
    source_session_id: normalizeSourceSessionID(input.source_session_id),
    source_turn_id: cleanString(input.source_turn_id),
    source_excerpt: cleanString(input.source_excerpt),
    workflow_snapshot_json: cleanString(input.workflow_snapshot_json)
  };
}

function mustGetIssue(db: RunnerDatabase, id: number): Issue {
  const issue = getIssue(db, id);
  if (!issue) throw new Error("created issue missing");
  return issue;
}

function lastInsertID(db: RunnerDatabase): number {
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (typeof row?.id !== "number" || !Number.isInteger(row.id) || row.id <= 0) {
    throw new Error("inserted issue id must be positive");
  }
  return row.id;
}

export function normalizeSourceSessionID(value: unknown): string {
  const text = cleanString(value);
  if (!text) return "";
  const separator = text.indexOf(":");
  if (separator < 0) return text;
  const provider = text.slice(0, separator).trim().toLowerCase();
  const sessionID = text.slice(separator + 1).trim();
  return provider === "codex" ? sessionID : text;
}

export function normalizeIdentifier(value: unknown): string {
  let out = "";
  let lastDash = false;
  for (const char of cleanString(value).toLowerCase()) {
    if (/^[a-z0-9_-]$/.test(char)) {
      out += char;
      lastDash = char === "-";
    } else if (!lastDash) {
      out += "-";
      lastDash = true;
    }
  }
  return out.replace(/^-+|-+$/g, "");
}

export function deriveIssueTitle(content: string): string {
  const line = content.split("\n").map((item) => item.trim()).find(Boolean) ?? "";
  return truncateRunes(line, ISSUE_TITLE_MAX_RUNES);
}

function truncateRunes(value: string, maxRunes: number): string {
  const runes = [...value];
  return runes.length <= maxRunes ? value : `${runes.slice(0, maxRunes - 1).join("")}…`;
}

export function integerInput(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}

export function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function issueTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
