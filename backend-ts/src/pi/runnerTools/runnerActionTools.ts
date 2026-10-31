import { Type, type Static } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiMcpActionTools } from "../mcp/mcpToolDefinitions.ts";
import type { PiRunnerActionLayer } from "./runnerActions.ts";
import { requiredText, optionalString, positiveNumber, objectOptions, positiveID, textList, ActionToolName, ActionExecutor, skillIntentList } from "./runnerActionToolSchemas.ts";
import { issueActionTools } from "./runnerIssueTools.ts";
import { projectActionTools, runnerControlTools, sessionActionTools, skillActionTools } from "./runnerContextTools.ts";
import { actionTool } from "./runnerActionToolResult.ts";

export function createPiRunnerActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    ...agentOrchestrationTools(actions),
    ...issueActionTools(actions),
    ...repoActionTools(actions),
    ...manualContextTools(actions),
    ...projectActionTools(actions),
    ...runnerControlTools(actions),
    ...sessionActionTools(actions),
    ...skillActionTools(actions),
    ...createPiMcpActionTools(actions)
  ];
}

export function manualContextTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("manual_context_intake", "Manual Context Intake",
      "Fetch recent source context and build a bounded context bundle. This tool does not classify intent or create proposals; PI must inspect the returned bundle and choose any follow-up tool.",
      Type.Object({
        attachment_kinds: Type.Optional(Type.Array(requiredText)),
        cursor: optionalString,
        limit: Type.Optional(positiveNumber),
        lookback_minutes: Type.Optional(positiveNumber),
        message_id: optionalString,
        now: optionalString,
        project_id: optionalString,
        require_attachments: Type.Optional(Type.Boolean()),
        source: optionalString,
        source_provider_id: optionalString,
        source_turn_id: optionalString,
        source_tool_name: optionalString,
        thread_key: optionalString,
        user_prompt: optionalString
      }, objectOptions), actions.runManualContextIntake)
  ];
}

export function repoActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
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

export function agentOrchestrationTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("agent_catalog_list", "Agent Catalog List",
      "List the Code Agent runtimes currently known to Xuanwu and the durable Agent Profiles available for routing. This is read-only and does not refresh or change provider state.",
      Type.Object({}, objectOptions), actions.listAgentCatalog),
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
    workflowTool("review_workflow_request", "Reviewer Workflow Request", actions.createReviewWorkflow),
    workflowTool("report_workflow_request", "Reporter Workflow Request", actions.createReportWorkflow),
    actionTool("needs_user_escalation", "Needs User Escalation",
      "Create a pending needs_user escalation comment proposal for an issue.",
      Type.Object({ issue_id: positiveID, reason: requiredText, requested_action: optionalString }, objectOptions),
      actions.escalateNeedsUser),
    actionTool("human_review_request_create", "Human Review Request Create",
      "Create an explicit review for a needs_user Issue. Use kind=acceptance when the user confirms the current delivery is complete or accepts it as-is; use decision/risk_acceptance only for choices or authorization to do further work. If the user already explicitly confirmed this delivery, record that exact scope here and answer it with human_review_response in this turn; do not ask them to confirm again or switch Project chats. The question must say exactly what is accepted.",
      Type.Object({
        acceptance_summary: textList,
        consequences: optionalString,
        evidence_refs: textList,
        excluded_scope: textList,
        issue_id: positiveID,
        kind: Type.Optional(Type.Union([
          Type.Literal("decision"),
          Type.Literal("acceptance"),
          Type.Literal("risk_acceptance")
        ])),
        question: requiredText,
        recommendation: optionalString
      }, objectOptions), actions.createHumanReviewRequest)
  ];
}

export function workflowTool(
  name: ActionToolName,
  label: string,
  executeAction: (params: Static<ReturnType<typeof workflowParams>>) => unknown
): ToolDefinition {
  const parameters = workflowParams();
  return actionTool(name, label,
    "Create a pending role-specific agent workflow issue linked to a parent issue or project.",
    parameters, executeAction as ActionExecutor<typeof parameters>);
}

export function workflowParams() {
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

export { PI_RUNNER_ACTION_TOOL_NAMES } from "./runnerActionToolSchemas.ts";
