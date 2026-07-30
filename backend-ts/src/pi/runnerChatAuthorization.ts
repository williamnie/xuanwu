import type { PiActionContext } from "./actionEngine.ts";
import { SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES } from "./supervisorControlContracts.ts";

const RUNNER_CHAT_MUTATION_ACTIONS = new Set([
  "agent.workflow_request",
  "issue.create",
  "issue.cancel",
  "issue.completion_reconcile",
  "issue.enqueue",
  "issue.schedule_enqueue",
  "issue.status_update",
  "issue.state_repair",
  "issue_completion_watch.create",
  "issue_completion_watch.cancel",
  "notification.preference.update",
  "project.create",
  "workspace.make_directory",
  "workspace.write_file",
  ...SUPERVISOR_CONTROL_MUTATION_ACTION_TYPES
]);

export function scopedRunnerChatActionContext<T extends PiActionContext>(
  context: T,
  actionType: string,
  target: { issueID?: number; projectID: string }
): T {
  const project = cleanString(target.projectID);
  if (context.authorization || project === "" || !isRunnerChatSource(context.source)) return context;
  if (!RUNNER_CHAT_MUTATION_ACTIONS.has(actionType)) return context;
  return {
    ...context,
    authorization: {
      allowedActions: [actionType],
      authorizedActions: [authorizedAction(actionType, project, target.issueID)],
      mode: "delegated",
      scope: { project_id: project }
    }
  };
}

export function isRunnerChatSource(source: unknown): boolean {
  const value = cleanString(source);
  return value === "feishu_runner_chat" || value === "runner_chat";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authorizedAction(actionType: string, projectID: string, issueID: number | undefined) {
  const id = Number.isSafeInteger(issueID) && Number(issueID) > 0 ? Number(issueID) : 0;
  return id > 0
    ? { action_type: actionType, issue_id: id, project_id: projectID }
    : { action_type: actionType, project_id: projectID };
}
