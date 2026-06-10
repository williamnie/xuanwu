import type { RunnerDatabase } from "../database.ts";
import { getIssue, type Issue } from "./issues.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { normalizeMcpCapabilityList } from "../../mcp/policy.ts";
import { normalizeSkillIntentList } from "../../skills/intents.ts";

export type CreateIssueInput = Partial<Record<keyof NormalizedIssueWrite, unknown>>;

type NormalizedIssueWrite = {
  agent_profile_id: string;
  description: string;
  priority: number;
  project_id: string;
  prompt_template: string;
  recommended_mcp_capabilities: string;
  recommended_skill_intents: string;
  required_mcp_capabilities: string;
  required_skill_intents: string;
  service_tier: string;
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
const DEFAULT_ISSUE_TEMPLATE_ID = "default";
const DEFAULT_ISSUE_TEMPLATE_CONTENT = "{{issue.description}}";

type IssueTemplateSnapshot = {
  content: string;
  id: string;
};

export function createIssue(db: RunnerDatabase, input: CreateIssueInput): Issue {
  const issue = normalizeIssueForWrite(db, input);
  validateIssueForCreate(db, issue);
  const timestamp = issueTimestamp();
  const insertIssue = db.transaction((record: NormalizedIssueWrite) => {
    db.sqlite.run(`insert into issues
      (project_id, title, description, status, priority, template_id,
       prompt_template, required_skill_intents_json, recommended_skill_intents_json,
       required_mcp_capabilities_json, recommended_mcp_capabilities_json, agent_profile_id,
       service_tier, source_session_id, source_turn_id, source_excerpt, workflow_snapshot_json, created_at, updated_at)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [record.project_id, record.title, record.description, record.status, record.priority,
        record.template_id, record.prompt_template, record.required_skill_intents,
        record.recommended_skill_intents, record.required_mcp_capabilities,
        record.recommended_mcp_capabilities, record.agent_profile_id, record.service_tier, record.source_session_id,
        record.source_turn_id, record.source_excerpt, record.workflow_snapshot_json, timestamp, timestamp]);
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

function normalizeIssueForWrite(db: RunnerDatabase, input: CreateIssueInput): NormalizedIssueWrite {
  const description = cleanString(input.description);
  const title = cleanString(input.title) || deriveIssueTitle(description);
  const template = resolveIssueTemplateSnapshot(
    db,
    cleanString(input.template_id),
    cleanString(input.prompt_template)
  );
  return {
    project_id: cleanString(input.project_id),
    title,
    description,
    status: cleanString(input.status) || "triage",
    priority: integerInput(input.priority),
    template_id: template.id,
    prompt_template: template.content,
    required_skill_intents: normalizeSkillIntentList(input.required_skill_intents),
    recommended_skill_intents: normalizeSkillIntentList(input.recommended_skill_intents),
    required_mcp_capabilities: normalizeMcpCapabilityList(input.required_mcp_capabilities),
    recommended_mcp_capabilities: normalizeMcpCapabilityList(input.recommended_mcp_capabilities),
    service_tier: cleanString(input.service_tier),
    agent_profile_id: normalizeIdentifier(input.agent_profile_id),
    source_session_id: normalizeSourceSessionID(input.source_session_id),
    source_turn_id: cleanString(input.source_turn_id),
    source_excerpt: cleanString(input.source_excerpt),
    workflow_snapshot_json: cleanString(input.workflow_snapshot_json)
  };
}

function resolveIssueTemplateSnapshot(
  db: RunnerDatabase,
  templateID: string,
  promptTemplate: string
): IssueTemplateSnapshot {
  if (promptTemplate !== "") return { id: templateID, content: promptTemplate };
  const template = templateID === "" ? defaultTemplateSnapshot(db) : templateSnapshotByID(db, templateID);
  if (template) return template;
  if (templateID === "" || templateID === DEFAULT_ISSUE_TEMPLATE_ID) return fallbackTemplateSnapshot();
  throw new Error("issue template 不存在");
}

function templateSnapshotByID(db: RunnerDatabase, templateID: string): IssueTemplateSnapshot | null {
  const row = db.sqlite.query<IssueTemplateSnapshot, [string]>(
    "select id, content from issue_templates where id=?"
  ).get(templateID);
  return row ? { id: row.id.trim(), content: row.content.trim() } : null;
}

function defaultTemplateSnapshot(db: RunnerDatabase): IssueTemplateSnapshot | null {
  const row = db.sqlite.query<IssueTemplateSnapshot, []>(`
    select id, content from issue_templates order by is_default desc, created_at asc limit 1
  `).get();
  return row ? { id: row.id.trim(), content: row.content.trim() } : null;
}

function fallbackTemplateSnapshot(): IssueTemplateSnapshot {
  return { id: DEFAULT_ISSUE_TEMPLATE_ID, content: DEFAULT_ISSUE_TEMPLATE_CONTENT };
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
