import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiRunnerActionLayer } from "./runnerActions.ts";

export const PI_RUNNER_ACTION_TOOL_NAMES = [
  "issue_list",
  "issue_read",
  "issue_create_proposal",
  "issue_state_diagnose",
  "issue_state_repair_proposal",
  "issue_comment",
  "issue_update_refinement",
  "issue_enqueue_proposal",
  "project_status",
  "project_list",
  "session_list",
  "session_read_summary",
  "session_steer_proposal"
] as const;

type ActionToolName = (typeof PI_RUNNER_ACTION_TOOL_NAMES)[number];
type ActionExecutor<TParams extends TSchema> = (params: Static<TParams>) => unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });
const positiveID = Type.Integer({ minimum: 1 });

export function createPiRunnerActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    ...issueActionTools(actions),
    ...projectActionTools(actions),
    ...sessionActionTools(actions)
  ];
}

function issueActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("issue_list", "Issue List", "List runner issues through the action layer.",
      Type.Object({ project_id: optionalString, status: optionalString }, objectOptions), actions.listIssues),
    actionTool("issue_read", "Issue Read", "Read one runner issue through the action layer.",
      Type.Object({ id: positiveID }, objectOptions), actions.readIssue),
    actionTool("issue_create_proposal", "Issue Create Proposal",
      "Create a high-risk pending proposal for a new issue; does not create the issue directly.",
      Type.Object({
        acceptance_criteria: optionalString,
        description: requiredText,
        project_id: optionalString,
        rationale: optionalString,
        title: optionalString,
        verification_plan: optionalString
      }, objectOptions), actions.createIssueProposal),
    issueStateDiagnoseTool(actions),
    issueStateRepairTool(actions),
    actionTool("issue_comment", "Issue Comment", "Add a low-risk agent comment to an issue.",
      Type.Object({ body: requiredText, issue_id: positiveID }, objectOptions), actions.commentIssue),
    issueRefinementTool(actions),
    actionTool("issue_enqueue_proposal", "Issue Enqueue Proposal",
      "Create a high-risk pending proposal to enqueue an issue; does not move it directly.",
      Type.Object({ issue_id: positiveID, rationale: optionalString }, objectOptions), actions.enqueueIssueProposal)
  ];
}

function issueStateDiagnoseTool(actions: PiRunnerActionLayer): ToolDefinition {
  return actionTool("issue_state_diagnose", "Issue State Diagnose",
    "Diagnose issue/session/runtime state mismatches and recommended state-manager actions.",
    Type.Object({
      deadline_at: optionalString,
      project_id: optionalString,
      target_issue_ids: Type.Optional(Type.Array(positiveID)),
      target_label: optionalString,
      target_status: optionalString
    }, objectOptions), actions.diagnoseIssueState);
}

function issueStateRepairTool(actions: PiRunnerActionLayer): ToolDefinition {
  return actionTool("issue_state_repair_proposal", "Issue State Repair Proposal",
    "Create a pending issue state repair proposal; delegated mode can auto-execute authorized repairs.",
    Type.Object({
      diagnosis_code: optionalString,
      issue_id: positiveID,
      operation: optionalString,
      rationale: optionalString
    }, objectOptions), actions.createIssueStateRepairProposal);
}

function issueRefinementTool(actions: PiRunnerActionLayer): ToolDefinition {
  return actionTool("issue_update_refinement", "Issue Refinement Proposal",
    "Create a high-risk pending proposal to update an issue refinement block.",
    Type.Object({
      acceptance_criteria: optionalString,
      context: optionalString,
      issue_id: positiveID,
      needs_human_confirmation: optionalString,
      non_goals: optionalString,
      problem: optionalString,
      rationale: optionalString,
      recommendation_reasoning: optionalString,
      recommended_profile: optionalString,
      recommended_provider: optionalString,
      risk_level: optionalString,
      risks: optionalString,
      verification_plan: optionalString
    }, objectOptions), actions.createUpdateRefinementProposal);
}

function projectActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("project_status", "Project Status", "Read a project status snapshot through the action layer.",
      Type.Object({ project_id: optionalString }, objectOptions), actions.projectStatus),
    actionTool("project_list", "Project List", "List runner projects through the action layer.",
      Type.Object({}, objectOptions), actions.listProjects)
  ];
}

function sessionActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("session_list", "Session List", "List runner-observed sessions through the action layer.",
      Type.Object({ project_id: optionalString, provider: optionalString }, objectOptions), actions.listSessions),
    actionTool("session_read_summary", "Session Summary", "Read a runner-observed session summary.",
      Type.Object({ session_key: requiredText }, objectOptions), actions.readSessionSummary),
    actionTool("session_steer_proposal", "Session Steer Proposal",
      "Create a high-risk pending proposal to steer a running executor session.",
      Type.Object({ prompt: requiredText, rationale: optionalString, session_key: requiredText }, objectOptions),
      actions.createSessionSteerProposal)
  ];
}

function actionTool<TParams extends TSchema>(
  name: ActionToolName,
  label: string,
  description: string,
  parameters: TParams,
  executeAction: ActionExecutor<TParams>
): ToolDefinition<TParams> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallId, params) {
      const details = executeAction(params);
      return toolResult(details);
    }
  };
}

function toolResult(details: unknown): AgentToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(details, null, 2) ?? "null" }],
    details
  };
}
