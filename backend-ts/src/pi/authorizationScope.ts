import type { PiActionEnvelope, PiAuthorizationScope, PiGatePolicy } from "./actionGate.ts";

export type PiAuthorizationScopeMatch = { matched: boolean; reason: string };

export function matchPiAuthorizationPolicyScope(
  envelope: PiActionEnvelope,
  policy: PiGatePolicy
): PiAuthorizationScopeMatch {
  if (!hasPolicyScope(policy)) {
    return policy.mode === "delegated" || policy.mode === "autonomous"
      ? denied("authorization scope is empty")
      : matched("");
  }
  return matchPiAuthorizationScope(envelope, policy.scopes ?? policy.scope);
}

export function matchPiAuthorizationScope(
  envelope: PiActionEnvelope,
  input: PiAuthorizationScope | PiAuthorizationScope[] | undefined
): PiAuthorizationScopeMatch {
  const scopes = scopeList(input);
  if (scopes.length === 0) return denied("authorization scope is empty");
  const reasons: string[] = [];
  for (const scope of scopes) {
    const result = matchOneScope(envelope, scope);
    if (result.matched) return result;
    reasons.push(result.reason);
  }
  return denied(reasons.find(Boolean) ?? "authorization scope did not match action");
}

function matchOneScope(envelope: PiActionEnvelope, scope: PiAuthorizationScope): PiAuthorizationScopeMatch {
  if (isEmptyScope(scope)) return denied("authorization scope is empty");
  const runner = scopeRunnerResource(scope);
  if (runner !== "") return matchRunnerScope(envelope, scope, runner);
  const project = scopeProjectID(scope);
  const projectResult = matchProject(project, envelope.project_id);
  if (!projectResult.matched) return projectResult;
  const runtime = matchRuntimeConstraints(envelope, scope);
  if (!runtime.matched) return runtime;

  const goal = scopeGoalID(scope);
  const issueIDs = scopeIssueIDs(scope);
  if (goal !== "") return withRuntimeReason(matchGoalScope(envelope, goal, issueIDs, project), runtime.reason);
  if (issueIDs.length > 0) return withRuntimeReason(matchIssueScope(envelope, issueIDs, project), runtime.reason);
  if (project !== "") return withRuntimeReason(matched(`scope matched project ${project}`), runtime.reason);
  return runtime.reason ? runtime : denied("authorization scope is empty");
}

function matchGoalScope(
  envelope: PiActionEnvelope,
  goal: string,
  issueIDs: number[],
  project: string
): PiAuthorizationScopeMatch {
  const actionIssue = actionIssueID(envelope);
  if (issueIDs.length > 0 && actionIssue > 0) {
    if (issueIDs.includes(actionIssue)) return matched(`scope matched goal ${goal} issue ${actionIssue}`);
    return denied(`goal scope ${goal} issues ${issueIDs.join(",")} do not match action issue ${actionIssue}`);
  }
  const actionGoal = cleanString(envelope.goal_id);
  if (actionGoal === goal) return matched(`scope matched goal ${goal}${project ? ` project ${project}` : ""}`);
  return denied(`goal scope ${goal} does not match action goal ${actionGoal || "<none>"}`);
}

function matchIssueScope(envelope: PiActionEnvelope, issueIDs: number[], project: string): PiAuthorizationScopeMatch {
  const actionIssue = actionIssueID(envelope);
  if (issueIDs.includes(actionIssue)) {
    return matched(`scope matched issue ${actionIssue}${project ? ` in project ${project}` : ""}`);
  }
  return denied(`issue scope ${issueIDs.join(",")} does not match action issue ${actionIssue || "<none>"}`);
}

function matchRunnerResourceScope(envelope: PiActionEnvelope, resource: string): PiAuthorizationScopeMatch {
  if (resource === "agent_catalog") return envelope.action_type === "agent.catalog_list"
    ? matched("scope matched agent catalog")
    : denied(`agent catalog scope does not match action ${envelope.action_type}`);
  if (resource === "issues") return runnerIssueAction(envelope.action_type)
    ? matched("scope matched runner issues")
    : denied(`runner issues scope does not match action ${envelope.action_type}`);
  if (resource === "projects") return runnerProjectAction(envelope.action_type)
    ? matched("scope matched runner projects")
    : denied(`runner projects scope does not match action ${envelope.action_type}`);
  if (resource === "workspace") return envelope.action_type.startsWith("workspace.")
    ? matched("scope matched local workspace")
    : denied(`runner workspace scope does not match action ${envelope.action_type}`);
  if (resource === "runner_settings") return envelope.action_type.startsWith("runner.settings")
    ? matched("scope matched runner settings")
    : denied(`runner settings scope does not match action ${envelope.action_type}`);
  if (resource === "service_lifecycle") return envelope.action_type === "system.restart"
    ? matched("scope matched service lifecycle")
    : denied(`service lifecycle scope does not match action ${envelope.action_type}`);
  return denied(`runner resource scope ${resource} is not supported`);
}

function matchRunnerScope(
  envelope: PiActionEnvelope,
  scope: PiAuthorizationScope,
  runner: string
): PiAuthorizationScopeMatch {
  const runtime = matchRuntimeConstraints(envelope, scope);
  if (!runtime.matched) return runtime;
  return withRuntimeReason(matchRunnerResourceScope(envelope, runner), runtime.reason);
}

function runnerIssueAction(actionType: string): boolean {
  return actionType.startsWith("issue.") || actionType.startsWith("issue_completion_watch.") ||
    actionType === "project.status" || actionType === "project.list";
}

function runnerProjectAction(actionType: string): boolean {
  return actionType === "project.create" || actionType === "project.list" || actionType === "project.status";
}

function matchProject(expected: string, actual: unknown): PiAuthorizationScopeMatch {
  const actionProject = cleanString(actual);
  if (expected === "" || actionProject === "" || expected === actionProject) return matched("");
  return denied(`project scope ${expected} does not match action project ${actionProject || "<none>"}`);
}

function matchRuntimeConstraints(envelope: PiActionEnvelope, scope: PiAuthorizationScope): PiAuthorizationScopeMatch {
  const results = [
    optionalMatchReason("delegation", scope.delegation_id ?? scope.delegationId, envelope.delegation_id),
    optionalMatchReason("heartbeat", scope.heartbeat_id ?? scope.heartbeatId, envelope.heartbeat_id)
  ].filter((result): result is PiAuthorizationScopeMatch => result !== undefined);
  const mismatch = results.find((result) => !result.matched);
  if (mismatch) return mismatch;
  return matched(results.map((result) => result.reason).filter(Boolean).join("; "));
}

function optionalMatchReason(label: string, expected: unknown, actual: unknown): PiAuthorizationScopeMatch | undefined {
  const value = cleanString(expected);
  if (value === "") return undefined;
  const current = cleanString(actual);
  return value === current
    ? matched(`scope matched ${label} ${value}`)
    : denied(`${label} scope ${value} does not match action ${label} ${current || "<none>"}`);
}

function isEmptyScope(scope: PiAuthorizationScope): boolean {
  return scopeProjectID(scope) === "" && scopeIssueIDs(scope).length === 0 &&
    scopeGoalID(scope) === "" && cleanString(scope.delegation_id ?? scope.delegationId) === "" &&
    cleanString(scope.heartbeat_id ?? scope.heartbeatId) === "" && scopeRunnerResource(scope) === "";
}

function scopeList(input: PiAuthorizationScope | PiAuthorizationScope[] | undefined): PiAuthorizationScope[] {
  if (Array.isArray(input)) return input;
  return input ? [input] : [];
}

function scopeProjectID(scope: PiAuthorizationScope): string {
  return cleanString(scope.project_id ?? scope.projectId);
}

function scopeRunnerResource(scope: PiAuthorizationScope): string {
  return cleanString(scope.runner_resource ?? scope.runnerResource);
}

function scopeGoalID(scope: PiAuthorizationScope): string {
  return cleanString(scope.goal_id ?? scope.goalId);
}

function scopeIssueIDs(scope: PiAuthorizationScope): number[] {
  return uniqueNumbers([
    ...numberList(scope.issue_id ?? scope.issueId),
    ...numberList(scope.issue_ids ?? scope.issueIds)
  ]);
}

function actionIssueID(envelope: PiActionEnvelope): number {
  return numberList(envelope.issue_id)[0] ?? numberList(envelope.payload.issue_id).at(0) ?? 0;
}

function numberList(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(numberList);
  const text = cleanString(value);
  if (typeof value === "number") return validNumber(value) ? [value] : [];
  if (text === "") return [];
  const parsed = parseNumberArrayText(text);
  if (parsed.length > 0) return parsed;
  return text.split(",").map((item) => Number.parseInt(item.trim(), 10)).filter(validNumber);
}

function parseNumberArrayText(text: string): number[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.flatMap(numberList) : [];
  } catch {
    return [];
  }
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values));
}

function validNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function hasPolicyScope(policy: PiGatePolicy): boolean {
  return Object.hasOwn(policy, "scope") || Object.hasOwn(policy, "scopes");
}

function matched(reason: string): PiAuthorizationScopeMatch {
  return { matched: true, reason };
}

function denied(reason: string): PiAuthorizationScopeMatch {
  return { matched: false, reason };
}

function withRuntimeReason(result: PiAuthorizationScopeMatch, runtimeReason: string): PiAuthorizationScopeMatch {
  if (!result.matched || runtimeReason === "") return result;
  return matched(`${result.reason}; ${runtimeReason}`);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
