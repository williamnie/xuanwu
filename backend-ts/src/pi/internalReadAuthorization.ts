import type { PiAuthorizedAction, PiGatePolicy } from "./actionGate.ts";

export function piInternalReadAuthorization(input: {
  issueID: number;
  projectID: string;
  toolNames: readonly string[];
}): PiGatePolicy {
  const authorizedActions = input.toolNames.map((name) => authorizedReadAction(
    actionTypeForTool(name),
    input.projectID,
    input.issueID
  ));
  return {
    allowedActions: authorizedActions.map((action) => action.action_type).filter(isString),
    authorizedActions,
    enforceAuthorizedReadScope: true,
    mode: "delegated",
    // Repository and Session reads are project-scoped and do not naturally
    // carry issue_id. Exact issue reads remain restricted below by their
    // authorized action envelope.
    scope: { project_id: input.projectID }
  };
}

function authorizedReadAction(actionType: string, projectID: string, issueID: number): PiAuthorizedAction {
  return issueBoundAction(actionType)
    ? { action_type: actionType, issue_id: issueID, project_id: projectID }
    : { action_type: actionType, project_id: projectID };
}

function issueBoundAction(actionType: string): boolean {
  return actionType === "issue.read";
}

function actionTypeForTool(name: string): string {
  if (name.startsWith("issue_")) return name.replace("issue_", "issue.");
  if (name.startsWith("session_")) return name.replace("session_", "session.");
  if (name.startsWith("repo_")) return name.replace("repo_", "repo.");
  if (name.startsWith("memory_")) return name.replace("memory_", "memory.");
  if (name === "project_status") return "project.status";
  return `sdk.${name}`;
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}
