import type { RunnerDatabase } from "../db/database.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns } from "../db/repositories/issues.ts";
import { getProject, ProjectNotFoundError } from "../db/repositories/projects.ts";
import { mergeSkillIntents, parseSkillIntentList, parseSkillPolicy } from "./intents.ts";

export type SkillIntentAudit = {
  allowed_skill_intents: string[];
  created_at: string;
  expected_skill_intents: string[];
  id: number;
  issue_id: number;
  issue_run_id: string;
  missing_skill_intents: string[];
  status: "mismatch" | "ok";
  unauthorized_skill_intents: string[];
  used_skill_intents: string[];
};

export type SkillIntentAuditInput = { issueRunID?: string; usedSkillIntents?: string[] };
export type SkillIntentAuditFilter = { issueID?: number; issueRunID?: string };

type AuditRow = Record<keyof SkillIntentAudit, unknown>;
const COLUMNS = `id, issue_id, issue_run_id, expected_skill_intents_json, used_skill_intents_json,
  missing_skill_intents_json, unauthorized_skill_intents_json, allowed_skill_intents_json,
  status, created_at`;

export function auditIssueSkillIntents(
  db: RunnerDatabase,
  issueID: number,
  input: SkillIntentAuditInput = {}
): SkillIntentAudit {
  const issue = getIssue(db, issueID);
  if (!issue) throw new ProjectNotFoundError();
  const project = getProject(db, issue.project_id);
  const expected = mergeSkillIntents(issue.required_skill_intents, project?.default_skill_policy && parseSkillPolicy(project.default_skill_policy).required);
  const used = mergeSkillIntents(input.usedSkillIntents, usedSkillIntentsFromEvents(db, issueID));
  const allowed = parseSkillPolicy(project?.default_skill_policy).allowed ?? [];
  const missing = expected.filter((id) => !used.includes(id));
  const unauthorized = allowed.length === 0 ? [] : used.filter((id) => !allowed.includes(id));
  const status = missing.length || unauthorized.length ? "mismatch" : "ok";
  const issueRunID = input.issueRunID ?? latestRunID(db, issueID);
  db.sqlite.run(`insert into pi_skill_intent_audits
    (issue_id, issue_run_id, expected_skill_intents_json, used_skill_intents_json,
     missing_skill_intents_json, unauthorized_skill_intents_json, allowed_skill_intents_json,
     status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [issueID, issueRunID, JSON.stringify(expected), JSON.stringify(used),
      JSON.stringify(missing), JSON.stringify(unauthorized), JSON.stringify(allowed), status, now()]);
  const audit = mustGetAudit(db, lastInsertID(db));
  persistIssueRunAudit(db, issueID, issueRunID, audit);
  return audit;
}

export function listSkillIntentAudits(db: RunnerDatabase, filter: SkillIntentAuditFilter = {}): SkillIntentAudit[] {
  const where = filter.issueID ? " where issue_id=?" : filter.issueRunID ? " where issue_run_id=?" : "";
  const args = filter.issueID ? [filter.issueID] : filter.issueRunID ? [filter.issueRunID] : [];
  return db.sqlite.query<AuditRow, Array<number | string>>(
    `select ${COLUMNS} from pi_skill_intent_audits${where} order by id asc`
  ).all(...args).map(mapAudit);
}

function persistIssueRunAudit(db: RunnerDatabase, issueID: number, issueRunID: string, audit: SkillIntentAudit): void {
  if (issueRunID === "") return;
  db.sqlite.run("update issue_runs set skill_intent_audit_json=? where id=? and issue_id=?", [JSON.stringify(audit), issueRunID, issueID]);
}

function usedSkillIntentsFromEvents(db: RunnerDatabase, issueID: number): string[] {
  const text = listIssueEvents(db, issueID).map((event) => event.payload).join("\n");
  const explicit = [...text.matchAll(/(?:Using|used|use)\s+([a-z0-9_:-]+(?:[\/][a-z0-9_:-]+)?)\s+skill/gi)]
    .map((match) => match[1] ?? "");
  const tagged = [...text.matchAll(/skill(?:_intent)?[=:]+([a-z0-9_:-]+(?:[\/][a-z0-9_:-]+)?)/gi)]
    .map((match) => match[1] ?? "");
  return parseSkillIntentList([...explicit, ...tagged]);
}

function latestRunID(db: RunnerDatabase, issueID: number): string {
  return listIssueRuns(db, issueID).at(-1)?.id ?? "";
}

function mustGetAudit(db: RunnerDatabase, id: number): SkillIntentAudit {
  const row = db.sqlite.query<AuditRow, [number]>(`select ${COLUMNS} from pi_skill_intent_audits where id=?`).get(id);
  if (!row) throw new Error("skill intent audit missing after write");
  return mapAudit(row);
}

function mapAudit(row: AuditRow): SkillIntentAudit {
  return {
    allowed_skill_intents: jsonList(row.allowed_skill_intents_json),
    created_at: stringValue(row.created_at),
    expected_skill_intents: jsonList(row.expected_skill_intents_json),
    id: numberValue(row.id),
    issue_id: numberValue(row.issue_id),
    issue_run_id: stringValue(row.issue_run_id),
    missing_skill_intents: jsonList(row.missing_skill_intents_json),
    status: stringValue(row.status) === "ok" ? "ok" : "mismatch",
    unauthorized_skill_intents: jsonList(row.unauthorized_skill_intents_json),
    used_skill_intents: jsonList(row.used_skill_intents_json)
  };
}

function jsonList(value: unknown): string[] {
  return parseSkillIntentList(stringValue(value));
}

function lastInsertID(db: RunnerDatabase): number {
  return numberValue(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
}

function now(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) ? value : 0;
}
