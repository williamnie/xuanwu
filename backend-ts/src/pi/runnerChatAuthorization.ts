import type { PiActionContext } from "./actionEngine.ts";
import { runnerChatMutationActionTypes } from "./actionContracts.ts";

const RUNNER_CHAT_MUTATION_ACTIONS = new Set(runnerChatMutationActionTypes());

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
    const targetScope = authorizationScope(project, issueID, issueIDs);
    return {
      ...context,
      authorization: {
        ...context.authorization,
        authorizedActions: [
          ...(context.authorization.authorizedActions ?? []),
          targetAuthorization
        ],
        scopes: [
          ...authorizationScopes(context.authorization.scopes ?? context.authorization.scope),
          targetScope
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
        scope: authorizationScope(project, issueID, issueIDs)
      }
  };
}

export function isRunnerChatSource(source: unknown): boolean {
  const value = cleanString(source);
  return value === "runner_chat" || value.endsWith("_runner_chat");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function authorizedAction(actionType: string, projectID: string, issueID: number, issueIDs: number[]) {
  if (issueID > 0) return { action_type: actionType, issue_id: issueID };
  if (issueIDs.length > 0) return { action_type: actionType, payload: { issue_ids: issueIDs } };
  return { action_type: actionType, project_id: projectID };
}

function authorizationScope(projectID: string, issueID: number, issueIDs: number[]) {
  if (issueID > 0) return { issue_id: issueID };
  if (issueIDs.length > 0) return { runner_resource: "issues" };
  return { project_id: projectID };
}

function authorizationScopes(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function positiveIssueID(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : 0;
}

function uniqueIssueIDs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(positiveIssueID).filter((id) => id > 0))];
}
