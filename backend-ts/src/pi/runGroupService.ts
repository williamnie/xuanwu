import type { RunnerDatabase } from "../db/database.ts";
import type { Issue } from "../db/repositories/issues.ts";
import {
  addPiRunGroupItem,
  createPiRunGroup,
  getPiRunGroup,
  listPiRunGroupItems,
  refreshPiRunGroupCompletion,
  updatePiRunGroupItem,
  type PiRunGroup
} from "../db/repositories/pi.ts";
import { deriveRunGroupReportView } from "./runGroupReportStatus.ts";

export type BatchRunGroupInput = {
  conversationID?: string;
  issues: Issue[];
  projectID: string;
  userPhrase?: string;
};

export function createBatchRunGroup(db: RunnerDatabase, input: BatchRunGroupInput): PiRunGroup {
  const group = createPiRunGroup(db, {
    expected_issue_count: input.issues.length,
    origin_conversation_id: cleanString(input.conversationID),
    project_id: input.projectID,
    user_phrase: cleanString(input.userPhrase)
  });
  input.issues.forEach((issue, index) => {
    addPiRunGroupItem(db, {
      enqueue_status: "pending",
      issue_id: issue.id,
      issue_title_snapshot: issue.title,
      position: index + 1,
      report_bucket: "active",
      report_status: "active",
      run_group_id: group.id,
      status: "active"
    });
  });
  return group;
}

export function attachRunGroupEnqueueAction(
  db: RunnerDatabase,
  runGroupID: string,
  issueID: number,
  actionID: string
): void {
  if (cleanString(runGroupID) === "" || cleanString(actionID) === "") return;
  updatePiRunGroupItem(db, runGroupID, issueID, { enqueue_action_id: actionID });
}

export function updateRunGroupEnqueueResult(
  db: RunnerDatabase,
  runGroupID: string,
  issueID: number,
  status: string,
  reason = ""
): void {
  if (cleanString(runGroupID) === "") return;
  updatePiRunGroupItem(db, runGroupID, issueID, {
    enqueue_status: normalizeEnqueueStatus(status),
    report_reason: cleanString(reason)
  });
  refreshPiRunGroupCompletion(db, runGroupID);
}

export function refreshRunGroupIssueReports(db: RunnerDatabase, runGroupID: string): PiRunGroup | null {
  const group = getPiRunGroup(db, runGroupID);
  if (!group) return null;
  for (const item of listPiRunGroupItems(db, group.id)) {
    const report = deriveRunGroupReportView(item);
    if (!report.reportable && item.enqueue_status === "completed") continue;
    updatePiRunGroupItem(db, group.id, item.issue_id, {
      report_bucket: report.report_bucket,
      report_status: report.report_status,
      status: report.status
    });
  }
  return refreshPiRunGroupCompletion(db, group.id);
}

function normalizeEnqueueStatus(status: string): string {
  const clean = cleanString(status);
  if (clean === "completed") return "completed";
  if (clean === "pending") return "pending_approval";
  if (clean === "failed") return "failed";
  if (clean === "skipped" || clean === "denied" || clean === "snoozed") return "skipped";
  return "failed";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
