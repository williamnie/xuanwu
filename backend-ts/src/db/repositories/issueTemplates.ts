import type { RunnerDatabase } from "../database.ts";

export type IssueTemplate = {
  content: string;
  created_at: string;
  id: string;
  is_default: number;
  name: string;
  updated_at: string;
};

type IssueTemplateRow = Record<keyof IssueTemplate, unknown>;

const ISSUE_TEMPLATE_COLUMNS = "id, name, content, is_default, created_at, updated_at";

export function listIssueTemplates(db: RunnerDatabase): IssueTemplate[] {
  const templates = db.sqlite.query<IssueTemplateRow, []>(`
    select ${ISSUE_TEMPLATE_COLUMNS} from issue_templates order by is_default desc, created_at asc
  `).all().map(mapIssueTemplateRow);
  return templates.length > 0 ? templates : [defaultIssueTemplate()];
}

function defaultIssueTemplate(): IssueTemplate {
  return {
    id: "default",
    name: "Default",
    content: "{{issue.description}}",
    is_default: 1,
    created_at: "",
    updated_at: ""
  };
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
