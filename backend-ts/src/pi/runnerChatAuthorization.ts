import type { PiActionContext } from "./actionEngine.ts";
import { SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES } from "./supervisorControlContracts.ts";

const RUNNER_CHAT_MUTATION_ACTIONS = new Set([
  "agent.workflow_request",
  "human_review.respond",
  "issue.create",
  "issue.cancel",
  "issue.delete",
  "issue.acceptance_request",
  "issue.enqueue",
  "issue.schedule_enqueue",
  "issue.status_update",
  "issue.state_repair",
  "issue_completion_watch.create",
  "issue_completion_watch.cancel",
  "notification.preference.update",
  "project.create",
  "runner.settings_update",
  "system.restart",
  "workspace.make_directory",
  "workspace.write_file",
  ...SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES
]);

export function scopedRunnerChatActionContext<T extends PiActionContext>(
  context: T,
  actionType: string,
  target: { issueID?: number; issueIDs?: number[]; projectID?: string }
): T {
  const project = cleanString(target.projectID);
  const issueID = positiveIssueID(target.issueID);
  const issueIDs = uniqueIssueIDs(target.issueIDs);
  if (!isRunnerChatSource(context.source)) return context;
  if (issueID === 0 && issueIDs.length === 0 && project === "") return context;
  if (!RUNNER_CHAT_MUTATION_ACTIONS.has(actionType)) return context;
  const targetAuthorization = authorizedAction(actionType, project, issueID, issueIDs);
  if (context.authorization) {
    if (context.authorization.askOnMissingAuthorization !== true &&
      context.authorization.ask_on_missing_authorization !== true) return context;
    return {
      ...context,
      authorization: {
        ...context.authorization,
        authorizedActions: [
          ...(context.authorization.authorizedActions ?? []),
          targetAuthorization
        ]
      }
    };
  }
  return {
    ...context,
      authorization: {
        allowedActions: [actionType],
        authorizedActions: [targetAuthorization],
        mode: "delegated",
        scope: issueID > 0
          ? { issue_id: issueID }
          : issueIDs.length > 0
            ? { runner_resource: "issues" }
            : { project_id: project }
      }
  };
}

export function isRunnerChatSource(source: unknown): boolean {
  const value = cleanString(source);
  return value === "feishu_runner_chat" || value === "telegram_runner_chat" || value === "runner_chat";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authorizedAction(actionType: string, projectID: string, issueID: number, issueIDs: number[]) {
  if (issueID > 0) return { action_type: actionType, issue_id: issueID };
  if (issueIDs.length > 0) return { action_type: actionType, payload: { issue_ids: issueIDs } };
  return { action_type: actionType, project_id: projectID };
}

function positiveIssueID(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function uniqueIssueIDs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(positiveIssueID).filter((id) => id > 0))];
}
