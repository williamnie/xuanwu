import type { RunnerDatabase } from "../database.ts";
import { issueTimestamp } from "./issueCreate.ts";
import { updateIssue } from "./issueUpdate.ts";
import { getIssue, type Issue } from "./issues.ts";
import { ProjectNotFoundError } from "./projects.ts";
import { listNightlyBatches, type NightlyBatch, type NightlyBatchItem } from "./nightlyBatches.ts";

export type NightlyBatchInput = { issue_ids?: unknown; policy?: unknown; project_id?: unknown; promotion_mode?: unknown };

const ACTIVE = "active";
const PENDING = "pending";
const CURRENT = "current";

export function getNightlyBatch(db: RunnerDatabase, id: number): NightlyBatch | null {
  return listNightlyBatches(db).find((batch) => batch.id === id) ?? null;
}

export function createNightlyBatch(db: RunnerDatabase, input: NightlyBatchInput): NightlyBatch {
  const normalized = normalizeNightlyInput(input);
  validateNightlyIssues(db, normalized.project_id, normalized.issue_ids);
  const timestamp = issueTimestamp();
  const write = db.transaction(() => {
    db.sqlite.run(`insert into nightly_batches
      (project_id, policy, promotion_mode, status, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
      [normalized.project_id, normalized.policy, normalized.promotion_mode, ACTIVE, timestamp, timestamp]);
    const batchID = lastInsertID(db);
    normalized.issue_ids.forEach((issueID, index) => db.sqlite.run(`insert into nightly_batch_items
      (batch_id, issue_id, position, status, updated_at) values (?, ?, ?, ?, ?)`,
      [batchID, issueID, index + 1, PENDING, timestamp]));
    promoteNextNightlyBatchIssue(db, batchID);
    return batchID;
  });
  return mustGetNightlyBatch(db, write());
}

export function promoteNextNightlyBatchIssue(db: RunnerDatabase, id: number): NightlyBatch {
  const batch = getNightlyBatch(db, id);
  if (!batch) throw new ProjectNotFoundError();
  if (batch.status !== ACTIVE) return batch;
  if (currentItem(batch)) return batch;
  const next = nextPendingItem(batch);
  if (!next) return finishBatch(db, id);
  promoteIssue(db, batch, next);
  return mustGetNightlyBatch(db, id);
}

function promoteIssue(db: RunnerDatabase, batch: NightlyBatch, item: NightlyBatchItem): Issue {
  const issue = getIssue(db, item.issue_id);
  if (!issue) throw new ProjectNotFoundError();
  if (issue.status !== "triage") throw new Error(`issue #${issue.id} is ${issue.status}, want triage`);
  const promoted = updateIssue(db, issue.id, { status: "todo", priority: 100000 - item.position, error: "" });
  db.sqlite.run("update nightly_batch_items set status=?, updated_at=? where batch_id=? and issue_id=?",
    [CURRENT, issueTimestamp(), batch.id, issue.id]);
  db.sqlite.run("update nightly_batches set current_issue_id=?, updated_at=? where id=?",
    [issue.id, issueTimestamp(), batch.id]);
  return promoted;
}

function finishBatch(db: RunnerDatabase, id: number): NightlyBatch {
  db.sqlite.run("update nightly_batches set status='done', current_issue_id=0, updated_at=? where id=?", [issueTimestamp(), id]);
  return mustGetNightlyBatch(db, id);
}

function normalizeNightlyInput(input: NightlyBatchInput): { issue_ids: number[]; policy: string; project_id: string; promotion_mode: string } {
  return {
    project_id: cleanString(input.project_id),
    issue_ids: Array.isArray(input.issue_ids) ? input.issue_ids.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0) : [],
    policy: cleanString(input.policy) || "fail_stop",
    promotion_mode: cleanString(input.promotion_mode) || "auto"
  };
}

function validateNightlyIssues(db: RunnerDatabase, projectID: string, issueIDs: number[]): void {
  if (projectID === "") throw new Error("project_id 不能为空");
  if (issueIDs.length === 0) throw new Error("nightly batch 至少需要一个 issue");
  if (new Set(issueIDs).size !== issueIDs.length) throw new Error("issue id 重复");
  for (const issueID of issueIDs) validateNightlyIssue(db, projectID, issueID);
}

function validateNightlyIssue(db: RunnerDatabase, projectID: string, issueID: number): void {
  const issue = getIssue(db, issueID);
  if (!issue) throw new ProjectNotFoundError();
  if (issue.project_id !== projectID) throw new Error(`issue #${issueID} 不属于项目 ${projectID}`);
  if (issue.status !== "triage") throw new Error(`issue #${issueID} 不是 triage 状态`);
}

function currentItem(batch: NightlyBatch): NightlyBatchItem | undefined {
  return batch.items.find((item) => item.status === CURRENT);
}

function nextPendingItem(batch: NightlyBatch): NightlyBatchItem | undefined {
  return batch.items.find((item) => item.status === PENDING);
}

function mustGetNightlyBatch(db: RunnerDatabase, id: number): NightlyBatch {
  const batch = getNightlyBatch(db, id);
  if (!batch) throw new Error("nightly batch missing after write");
  return batch;
}

function lastInsertID(db: RunnerDatabase): number { return db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id ?? 0; }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
