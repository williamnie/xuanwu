import type { RunnerDatabase } from "../database.ts";

export type AutomationExecutionLink = {
  automation_id: string;
  automation_run_id: string;
  created_at: string;
  issue_id: number;
  run_id: string;
  updated_at: string;
  work_id: string;
  workflow_ref: string;
};

type Row = Record<string, unknown>;

export function getAutomationExecutionLink(db: RunnerDatabase, automationRunID: string): AutomationExecutionLink | null {
  const row = db.sqlite.query<Row, [string]>("select * from automation_execution_links where automation_run_id=?")
    .get(automationRunID);
  return row ? map(row) : null;
}

export function createAutomationExecutionLink(
  db: RunnerDatabase,
  input: AutomationExecutionLink
): AutomationExecutionLink {
  const existing = getAutomationExecutionLink(db, input.automation_run_id);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(input)) throw new Error("automation execution link conflict");
    return existing;
  }
  db.sqlite.run(`insert into automation_execution_links
    (automation_run_id, automation_id, workflow_ref, issue_id, work_id, run_id, created_at, updated_at)
    values (?, ?, ?, ?, ?, ?, ?, ?)`, [
    input.automation_run_id, input.automation_id, input.workflow_ref, input.issue_id,
    input.work_id, input.run_id, input.created_at, input.updated_at
  ]);
  return input;
}

function map(row: Row): AutomationExecutionLink {
  return {
    automation_id: text(row.automation_id), automation_run_id: text(row.automation_run_id),
    created_at: text(row.created_at), issue_id: number(row.issue_id), run_id: text(row.run_id),
    updated_at: text(row.updated_at), work_id: text(row.work_id), workflow_ref: text(row.workflow_ref)
  };
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("invalid automation execution link");
  return value;
}
function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error("invalid automation execution issue id");
  return Number(value);
}
