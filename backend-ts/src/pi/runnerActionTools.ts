import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiMcpActionTools, PI_MCP_TOOL_NAMES } from "./mcpToolDefinitions.ts";
import type { PiRunnerActionLayer } from "./runnerActions.ts";

export const PI_RUNNER_ACTION_TOOL_NAMES = [
  "agent_profile_recommend",
  "executor_profile_assign_proposal",
  "executor_issue_create_proposal",
  "verification_workflow_request",
  "review_workflow_request",
  "report_workflow_request",
  "needs_user_escalation",
  "issue_list",
  "issue_status_summary",
  "issue_execution_status",
  "issue_read",
  "issue_create_proposal",
  "issue_state_diagnose",
  "issue_state_repair_proposal",
  "issue_comment",
  "issue_enqueue_batch_triage",
  "issue_enqueue_proposal",
  "issue_enqueue_next_triage",
  "issue_schedule_enqueue",
  "repo_search",
  "repo_read_excerpt",
  "repo_tree",
  "project_status",
  "project_list",
  "session_list",
  "session_read_summary",
  "session_steer_proposal",
  "skill_list",
  "skill_read",
  "skill_recommend",
  "skill_intent_audit",
  ...PI_MCP_TOOL_NAMES
] as const;

type ActionToolName = (typeof PI_RUNNER_ACTION_TOOL_NAMES)[number];
type ActionExecutor<TParams extends TSchema> = (params: Static<TParams>) => unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });
const positiveID = Type.Integer({ minimum: 1 });
const positiveNumber = Type.Integer({ minimum: 1 });
const skillIntentList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));
const mcpCapabilityList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));
const textList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));
const looseList = Type.Optional(Type.Array(Type.Any()));
const TOOL_RESULT_MAX_CHARS = 8192;

export function createPiRunnerActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    ...agentOrchestrationTools(actions),
    ...issueActionTools(actions),
    ...repoActionTools(actions),
    ...projectActionTools(actions),
    ...sessionActionTools(actions),
    ...skillActionTools(actions),
    ...createPiMcpActionTools(actions)
  ];
}

function repoActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("repo_search", "Repo Search",
      "Search text in the current project repository using a bounded read-only scanner.",
      Type.Object({
        max_results: Type.Optional(positiveNumber),
        path: optionalString,
        query: requiredText
      }, objectOptions), actions.searchRepo),
    actionTool("repo_read_excerpt", "Repo Read Excerpt",
      "Read a bounded excerpt from one file in the current project repository.",
      Type.Object({
        max_bytes: Type.Optional(positiveNumber),
        max_lines: Type.Optional(positiveNumber),
        path: requiredText,
        start_line: Type.Optional(positiveNumber)
      }, objectOptions), actions.readRepoExcerpt),
    actionTool("repo_tree", "Repo Tree",
      "List a bounded directory tree for the current project repository.",
      Type.Object({
        max_depth: Type.Optional(Type.Integer({ minimum: 0 })),
        max_entries: Type.Optional(positiveNumber),
        path: optionalString
      }, objectOptions), actions.readRepoTree)
  ];
}

function agentOrchestrationTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("agent_profile_recommend", "Agent Profile Recommend",
      "Recommend executor provider/profile/skill intent strategy for an issue or project.",
      Type.Object({
        agent_profile_id: optionalString,
        issue_id: Type.Optional(positiveID),
        project_id: optionalString,
        role: optionalString
      }, objectOptions), actions.recommendExecutorProfile),
    actionTool("executor_profile_assign_proposal", "Executor Profile Assign Proposal",
      "Create a pending proposal to assign or recommend an executor profile for an issue.",
      Type.Object({ agent_profile_id: optionalString, issue_id: positiveID, rationale: optionalString }, objectOptions),
      actions.assignExecutorProfileProposal),
    workflowTool("executor_issue_create_proposal", "Executor Issue Create Proposal", actions.createExecutorIssueProposal),
    workflowTool("verification_workflow_request", "Verifier Workflow Request", actions.createVerificationWorkflow),
    workflowTool("review_workflow_request", "Reviewer Workflow Request", actions.createReviewWorkflow),
    workflowTool("report_workflow_request", "Reporter Workflow Request", actions.createReportWorkflow),
    actionTool("needs_user_escalation", "Needs User Escalation",
      "Create a pending needs_user escalation comment proposal for an issue.",
      Type.Object({ issue_id: positiveID, reason: requiredText, requested_action: optionalString }, objectOptions),
      actions.escalateNeedsUser)
  ];
}

function workflowTool(
  name: ActionToolName,
  label: string,
  executeAction: (params: Static<ReturnType<typeof workflowParams>>) => unknown
): ToolDefinition {
  const parameters = workflowParams();
  return actionTool(name, label,
    "Create a pending role-specific agent workflow issue linked to a parent issue or project.",
    parameters, executeAction as ActionExecutor<typeof parameters>);
}

function workflowParams() {
  return Type.Object({
    agent_profile_id: optionalString,
    goal_id: optionalString,
    instructions: optionalString,
    project_id: optionalString,
    rationale: optionalString,
    recommended_skill_intents: skillIntentList,
    report_type: optionalString,
    required_skill_intents: skillIntentList,
    target_issue_id: Type.Optional(positiveID),
    title: optionalString,
    verification_plan: optionalString
  }, objectOptions);
}

function issueActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("issue_list", "Issue List", "List runner issues through the action layer.",
      Type.Object({ limit: Type.Optional(positiveNumber), project_id: optionalString, status: optionalString }, objectOptions),
      actions.listIssues),
    actionTool("issue_status_summary", "Issue Status Summary",
      "Return compact issue counts by status. Use this for questions like how many issues are unfinished.",
      Type.Object({ project_id: optionalString, status: optionalString }, objectOptions), actions.issueStatusSummary),
    actionTool("issue_execution_status", "Issue Execution Status",
      "Return compact run/progress status for one issue without full description or raw logs.",
      Type.Object({ id: positiveID }, objectOptions), actions.issueExecutionStatus),
    actionTool("issue_read", "Issue Read", "Read one runner issue through the action layer.",
      Type.Object({ id: positiveID }, objectOptions), actions.readIssue),
    actionTool("issue_create_proposal", "Issue Create Proposal",
      "Create a high-risk pending proposal for a new issue; does not create the issue directly.",
      Type.Object({
        description: requiredText,
        project_id: optionalString,
        rationale: optionalString,
        title: optionalString,
        context_pack: Type.Optional(Type.Any()),
        evidence: looseList,
        relevant_files: looseList,
        proposed_changes: textList,
        acceptance_criteria: textList,
        validation: textList,
        open_questions: textList,
        required_skill_intents: skillIntentList,
        recommended_skill_intents: skillIntentList,
        required_mcp_capabilities: mcpCapabilityList,
        recommended_mcp_capabilities: mcpCapabilityList
      }, objectOptions), actions.createIssueProposal),
    issueStateDiagnoseTool(actions),
    issueStateRepairTool(actions),
    actionTool("issue_comment", "Issue Comment", "Add a low-risk agent comment to an issue.",
      Type.Object({ body: requiredText, issue_id: positiveID }, objectOptions), actions.commentIssue),
    actionTool("issue_enqueue_proposal", "Issue Enqueue Proposal",
      "Enqueue an issue when the user asks to run now; delegated Runner Chat can execute this directly.",
      Type.Object({ issue_id: positiveID, rationale: optionalString }, objectOptions), actions.enqueueIssueProposal),
    actionTool("issue_enqueue_batch_triage", "Issue Enqueue Batch Triage",
      "Batch-enqueue all matching status=triage issues in the requested/default Runner issue project when PI understands the user wants a batch start; execution remains serial.",
      Type.Object({
        issue_ids: Type.Optional(Type.Array(positiveID)),
        project_id: optionalString,
        rationale: optionalString,
        user_phrase: requiredText
      }, objectOptions), actions.enqueueBatchTriageIssues),
    actionTool("issue_enqueue_next_triage", "Issue Enqueue Next Triage",
      "Select and enqueue exactly one next triage issue in the requested/default Runner issue project when the user asks to continue the next/current-group task.",
      Type.Object({ project_id: optionalString, rationale: optionalString }, objectOptions), actions.enqueueNextTriageIssue),
    actionTool("issue_schedule_enqueue", "Issue Schedule Enqueue",
      "Create a real one-time cron to enqueue exactly one issue at next_run_at (RFC3339). Use this when the user chooses a specific later time in chat.",
      Type.Object({
        issue_id: positiveID,
        name: optionalString,
        next_run_at: requiredText,
        rationale: optionalString,
        timezone: optionalString
      }, objectOptions), actions.scheduleIssueEnqueue)
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
    "Create a deterministic issue state repair proposal from issue_state_diagnose output; delegated Runner issue-manager mode can auto-execute authorized repairs.",
    Type.Object({
      diagnosis_code: optionalString,
      issue_id: positiveID,
      operation: optionalString,
      rationale: optionalString
    }, objectOptions), actions.createIssueStateRepairProposal);
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
      Type.Object({ project_id: optionalString, provider: optionalString, role: optionalString }, objectOptions), actions.listSessions),
    actionTool("session_read_summary", "Session Summary", "Read a runner-observed session summary.",
      Type.Object({ session_key: requiredText }, objectOptions), actions.readSessionSummary),
    actionTool("session_steer_proposal", "Session Steer Proposal",
      "Create a high-risk pending proposal to steer a running executor session.",
      Type.Object({ prompt: requiredText, rationale: optionalString, session_key: requiredText }, objectOptions),
      actions.createSessionSteerProposal)
  ];
}

function skillActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("skill_list", "Skill List", "List Codex skills metadata visible to PI.",
      Type.Object({}, objectOptions), actions.listSkills),
    actionTool("skill_read", "Skill Read", "Read one Codex skill metadata record by id.",
      Type.Object({ id: requiredText }, objectOptions), actions.readSkill),
    actionTool("skill_recommend", "Skill Recommend", "Recommend required or recommended skill intents for an issue/project prompt.",
      Type.Object({ description: optionalString, project_id: optionalString, title: optionalString }, objectOptions), actions.recommendSkills),
    actionTool("skill_intent_audit", "Skill Intent Audit", "Audit whether a completed session used the expected skill intents.",
      Type.Object({ issue_id: positiveID, issue_run_id: optionalString, used_skill_intents: skillIntentList }, objectOptions), actions.auditSkillIntents)
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

function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: boundedToolResultText(details) }],
    details
  };
}

function boundedToolResultText(details: unknown): string {
  const text = JSON.stringify(details, null, 2) ?? "null";
  if (text.length <= TOOL_RESULT_MAX_CHARS) return text;
  return `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[tool result truncated: ${text.length - TOOL_RESULT_MAX_CHARS} chars omitted; full result preserved in tool details.]`;
}
