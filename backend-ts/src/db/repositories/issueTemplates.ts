import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { ProjectNotFoundError } from "./projects.ts";

export type IssueTemplate = {
  content: string;
  created_at: string;
  id: string;
  is_default: number;
  name: string;
  updated_at: string;
};

type IssueTemplateRow = Record<keyof IssueTemplate, unknown>;
type IssueTemplateInput = Partial<Record<keyof IssueTemplate, unknown>>;

const ISSUE_TEMPLATE_COLUMNS = "id, name, content, is_default, created_at, updated_at";

export function listIssueTemplates(db: RunnerDatabase): IssueTemplate[] {
  const templates = db.sqlite.query<IssueTemplateRow, []>(`
    select ${ISSUE_TEMPLATE_COLUMNS} from issue_templates order by is_default desc, created_at asc
  `).all().map(mapIssueTemplateRow);
  return templates.length > 0 ? templates : [defaultIssueTemplate()];
}

export function getIssueTemplate(db: RunnerDatabase, id: string): IssueTemplate | null {
  const row = db.sqlite.query<IssueTemplateRow, [string]>(
    `select ${ISSUE_TEMPLATE_COLUMNS} from issue_templates where id=?`
  ).get(id.trim());
  return row ? mapIssueTemplateRow(row) : null;
}

export function createIssueTemplate(db: RunnerDatabase, input: IssueTemplateInput): IssueTemplate {
  const template = normalizeIssueTemplate(input);
  template.id ||= uniqueIssueTemplateID(db, issueTemplateIDFromName(template.name));
  validateIssueTemplate(template);
  const timestamp = issueTimestamp();
  const write = db.transaction((item: IssueTemplate) => {
    if (item.is_default === 1) clearDefaultTemplates(db, timestamp);
    db.sqlite.run(`insert into issue_templates
      (id, name, content, is_default, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
      [item.id, item.name, item.content, item.is_default, timestamp, timestamp]);
  });
  write(template);
  return mustGetIssueTemplate(db, template.id);
}

export function updateIssueTemplate(db: RunnerDatabase, id: string, input: IssueTemplateInput): IssueTemplate {
  const templateID = id.trim();
  const current = getIssueTemplate(db, templateID);
  if (!current) throw new ProjectNotFoundError();
  const next = normalizeIssueTemplate({ ...current, ...patchValues(input), id: templateID });
  if (current.is_default === 1 && Object.hasOwn(input, "is_default") && next.is_default === 0) next.is_default = 1;
  validateIssueTemplate(next);
  const timestamp = issueTimestamp();
  const write = db.transaction((item: IssueTemplate) => {
    if (item.is_default === 1) clearDefaultTemplates(db, timestamp);
    db.sqlite.run("update issue_templates set name=?, content=?, is_default=?, updated_at=? where id=?",
      [item.name, item.content, item.is_default, timestamp, templateID]);
  });
  write(next);
  return mustGetIssueTemplate(db, templateID);
}

export function deleteIssueTemplate(db: RunnerDatabase, id: string): void {
  const template = getIssueTemplate(db, id);
  if (!template) throw new ProjectNotFoundError();
  if (templateCount(db) <= 1) throw new Error("至少保留一个 issue 模板");
  const write = db.transaction((item: IssueTemplate) => {
    db.sqlite.run("delete from issue_templates where id=?", [item.id]);
    if (item.is_default === 1) db.sqlite.run(`update issue_templates set is_default=1,
      updated_at=? where id=(select id from issue_templates order by created_at asc limit 1)`, [issueTimestamp()]);
  });
  write(template);
}

function defaultIssueTemplate(): IssueTemplate {
  return { id: "default", name: "Default", content: "{{issue.description}}", is_default: 1, created_at: "", updated_at: "" };
}

function normalizeIssueTemplate(input: IssueTemplateInput): IssueTemplate {
  return {
    id: cleanString(input.id) ? issueTemplateIDFromName(cleanString(input.id)) : "", name: cleanString(input.name), content: cleanString(input.content),
    is_default: integerValue(input.is_default ?? 0, "issue_templates.is_default") === 0 ? 0 : 1,
    created_at: "", updated_at: ""
  };
}

function validateIssueTemplate(template: IssueTemplate): void {
  if (template.id === "") throw new Error("模板 ID 不能为空");
  if (template.name === "") throw new Error("模板名称不能为空");
  if (template.content === "") throw new Error("模板内容不能为空");
}

function clearDefaultTemplates(db: RunnerDatabase, timestamp: string): void {
  db.sqlite.run("update issue_templates set is_default=0, updated_at=?", [timestamp]);
}

function uniqueIssueTemplateID(db: RunnerDatabase, base: string): string {
  for (let suffix = 1; ; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`;
    if (!getIssueTemplate(db, candidate)) return candidate;
  }
}

function issueTemplateIDFromName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "template";
}

function templateCount(db: RunnerDatabase): number {
  return db.sqlite.query<{ count: number }, []>("select count(*) as count from issue_templates").get()?.count ?? 0;
}

function mustGetIssueTemplate(db: RunnerDatabase, id: string): IssueTemplate {
  const template = getIssueTemplate(db, id);
  if (!template) throw new Error("issue template missing after write");
  return template;
}

function patchValues(input: IssueTemplateInput): IssueTemplateInput {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null && value !== undefined));
}

function mapIssueTemplateRow(row: IssueTemplateRow): IssueTemplate {
  return {
    id: requiredString(row.id, "issue_templates.id"),
    name: requiredString(row.name, "issue_templates.name"),
    content: requiredString(row.content, "issue_templates.content"),
    is_default: integerValue(row.is_default, "issue_templates.is_default"),
    created_at: requiredString(row.created_at, "issue_templates.created_at"),
    updated_at: requiredString(row.updated_at, "issue_templates.updated_at")
  };
}

function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function optionalString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string") throw new Error("expected string row value");
  return value.trim();
}
function requiredString(value: unknown, label: string): string {
  const text = optionalString(value);
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
function integerValue(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}
