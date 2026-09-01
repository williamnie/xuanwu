import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiMcpActionTools, PI_MCP_TOOL_NAMES } from "./mcpToolDefinitions.ts";
import type { PiRunnerActionLayer } from "./runnerActions.ts";
import { formatModelVisibleToolOutput } from "../security/promptInjectionDefense.ts";

export const PI_RUNNER_ACTION_TOOL_NAMES = [
  "agent_catalog_list",
  "agent_profile_recommend",
  "executor_profile_assign_proposal",
  "executor_issue_create_proposal",
  "review_workflow_request",
  "report_workflow_request",
  "needs_user_escalation",
  "human_review_request_create",
  "human_review_response",
  "issue_list",
  "issue_status_summary",
  "issue_execution_status",
  "issue_acceptance_request",
  "issue_read",
  "issue_create_proposal",
  "issue_create_batch_proposal",
  "issue_cancel",
  "issue_delete",
  "issue_status_update",
  "issue_state_diagnose",
  "issue_state_repair_proposal",
  "issue_comment",
  "issue_enqueue_batch_triage",
  "issue_enqueue_proposal",
  "issue_enqueue_next_triage",
  "issue_schedule_enqueue",
  "issue_completion_watch_create",
  "issue_completion_watch_list",
  "issue_completion_watch_cancel",
  "repo_search",
  "repo_read_excerpt",
  "repo_tree",
  "manual_context_intake",
  "project_status",
  "project_list",
  "runner_settings_read",
  "runner_settings_update",
  "system_restart",
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
type ActionExecutor<TParams extends TSchema> = (params: Static<TParams>) => Promise<unknown> | unknown;

const objectOptions = { additionalProperties: false };
const optionalString = Type.Optional(Type.String());
const requiredText = Type.String({ minLength: 1, pattern: "\\S" });
const positiveID = Type.Integer({ minimum: 1 });
const positiveNumber = Type.Integer({ minimum: 1 });
const issueQueryScope = Type.Optional(Type.Union([Type.Literal("global"), Type.Literal("project")]));
const skillIntentList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));
const mcpCapabilityList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));
const textList = Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "\\S" })));
const TOOL_RESULT_MAX_CHARS = 8192;

const evidenceItem = Type.Object({
  confidence: optionalString,
  excerpt: optionalString,
  issue_id: Type.Optional(positiveID),
  message_id: optionalString,
  path: optionalString,
  reason: optionalString,
  session_key: optionalString,
  source_kind: optionalString,
  summary: optionalString
}, objectOptions);
const evidenceValue = Type.Union([requiredText, evidenceItem]);
const evidenceList = Type.Optional(Type.Array(evidenceValue));
const relevantFile = Type.Object({
  path: requiredText,
  reason: optionalString,
  symbols: Type.Optional(Type.Array(requiredText))
}, objectOptions);
const repoContextPack = Type.Optional(Type.Object({
  acceptance_criteria: textList,
  confidence: optionalString,
  evidence: evidenceList,
  intent: optionalString,
  open_questions: textList,
  project: Type.Optional(Type.Object({ cwd: optionalString, id: optionalString, name: optionalString }, objectOptions)),
  proposed_changes: textList,
  relevant_files: Type.Optional(Type.Array(relevantFile)),
  source: Type.Optional(Type.Object({
    channel: optionalString,
    kind: optionalString,
    message_id: optionalString,
    session_key: optionalString
  }, objectOptions)),
  validation: textList,
  "需求理解": optionalString,
  "相关证据": textList,
  "相关文件": Type.Optional(Type.Array(relevantFile)),
  "建议改动": textList,
  "验收标准": textList,
  "验证建议": textList,
  "未确认问题": textList
}, objectOptions));

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

function manualContextTools(actions: PiRunnerActionLayer): ToolDefinition[] {
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
      "Create an immediate, explicit human review request only when PI cannot decide a product, scope, or risk tradeoff. The question must say exactly what the human is approving.",
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
    actionTool("issue_list", "Issue List", "List runner issues through the action layer. Use scope=global for runner-wide questions and scope=project with project_id for one Project.",
      Type.Object({ limit: Type.Optional(positiveNumber), project_id: optionalString, scope: issueQueryScope, status: optionalString }, objectOptions),
      actions.listIssues),
    actionTool("issue_status_summary", "Issue Status Summary",
      "Return compact issue counts by status. For unqualified questions like how many issues are unfinished, use scope=global. Use scope=project with project_id only when the current user turn explicitly names that Project.",
      Type.Object({ project_id: optionalString, scope: issueQueryScope, status: optionalString }, objectOptions), actions.issueStatusSummary),
    actionTool("issue_execution_status", "Issue Execution Status",
      "Return compact Run and PI acceptance status for one issue without raw logs. Check completion.retry_recommended before proposing retry.",
      Type.Object({ id: positiveID }, objectOptions), actions.issueExecutionStatus),
    actionTool("issue_acceptance_request", "Issue Acceptance Request",
      "Request issue-scoped PI semantic acceptance for an ended Run. PI reads the current Provider Session and workspace facts before deciding.",
      Type.Object({ issue_id: positiveID, rationale: optionalString }, objectOptions),
      actions.requestIssueAcceptanceAction),
    actionTool("issue_read", "Issue Read", "Read one runner Issue with its full body, dependency readiness, compact Run state, recent events, and current PI decision state.",
      Type.Object({ id: positiveID }, objectOptions), actions.readIssue),
    actionTool("human_review_response", "Human Review Response",
      "Answer the current open human review. For decision/risk_acceptance, accept records the requested choice or authorization and re-runs PI acceptance, which may continue execution; it is not delivery acceptance. For acceptance, accept accepts the current delivery as-is. request_changes immediately continues the same Provider Session in a new Run/Turn. Supplying authorization, budget, credentials-ready state, installation details, or other requested information must never be treated as accepting an incomplete delivery. Never replace this with issue_status_update.",
      Type.Object({
        action: Type.Union([
          Type.Literal("accept"),
          Type.Literal("request_changes"),
          Type.Literal("reject")
        ]),
        comment: optionalString,
        issue_id: positiveID,
        review_request_id: requiredText,
        review_revision: positiveID
      }, objectOptions), actions.respondToHumanReview),
    actionTool("issue_create_proposal", "Issue Create Proposal",
      "Create a new issue. project_id identifies the destination Project.",
      Type.Object({
        description: requiredText,
        depends_on_issue_ids: Type.Optional(Type.Array(positiveID)),
        project_id: optionalString,
        rationale: optionalString,
        title: optionalString,
        context_pack: repoContextPack,
        evidence: evidenceList,
        relevant_files: Type.Optional(Type.Array(relevantFile)),
        proposed_changes: textList,
        acceptance_criteria: textList,
        validation: textList,
        open_questions: textList,
        required_skill_intents: skillIntentList,
        recommended_skill_intents: skillIntentList,
        required_mcp_capabilities: mcpCapabilityList,
        recommended_mcp_capabilities: mcpCapabilityList
      }, objectOptions), actions.createIssueProposal),
    actionTool("issue_create_batch_proposal", "Issue Create Batch Proposal",
      "Create one audited proposal containing 2-40 detailed triage issues. project_id identifies the destination Project. Use stable local refs in depends_on_refs; this tool never enqueues the created issues.",
      Type.Object({
        items: Type.Array(Type.Object({
          acceptance_criteria: Type.Array(requiredText, { minItems: 1 }),
          context_pack: repoContextPack,
          depends_on_refs: Type.Optional(Type.Array(requiredText)),
          description: requiredText,
          evidence: Type.Array(evidenceValue, { minItems: 1 }),
          open_questions: textList,
          proposed_changes: Type.Array(requiredText, { minItems: 1 }),
          recommended_mcp_capabilities: mcpCapabilityList,
          recommended_skill_intents: skillIntentList,
          ref: Type.String({ minLength: 1, maxLength: 64, pattern: "^[A-Za-z0-9][A-Za-z0-9._-]*$" }),
          relevant_files: Type.Optional(Type.Array(relevantFile)),
          required_mcp_capabilities: mcpCapabilityList,
          required_skill_intents: skillIntentList,
          title: Type.String({ minLength: 1, maxLength: 50, pattern: "\\S" }),
          validation: Type.Array(requiredText, { minItems: 1 })
        }, objectOptions), { minItems: 2, maxItems: 40 }),
        project_id: optionalString,
        rationale: optionalString
      }, objectOptions), actions.createIssueBatchProposal),
    actionTool("issue_cancel", "Issue Cancel",
      "Cancel one or more explicitly requested issues. Use this when the user says the issues will not be done or asks to move them to cancelled; active Runs are interrupted through the canonical Runner cancellation path.",
      Type.Object({
        issue_ids: Type.Array(positiveID, { minItems: 1, maxItems: 40 }),
        rationale: optionalString
      }, objectOptions), actions.cancelIssues),
    actionTool("issue_delete", "Issue Delete",
      "Permanently delete 1-40 explicit, non-running issues from one project. This is irreversible, requires user approval, and never deletes a project or repository files.",
      Type.Object({
        issue_ids: Type.Array(positiveID, { minItems: 1, maxItems: 40 }),
        reason: requiredText
      }, objectOptions), actions.deleteIssues),
    actionTool("issue_status_update", "Issue Status Update",
      "Move one or more explicit issues through the canonical Runner status contract. Supports every Issue status, validates the current transition, interrupts active providers when required, queues execution for in_progress, and routes done claims to Completion Card plus issue-scoped PI semantic acceptance.",
      Type.Object({
        error: optionalString,
        issue_ids: Type.Array(positiveID, { minItems: 1, maxItems: 40 }),
        reason: requiredText,
        status: Type.Union([
          Type.Literal("triage"),
          Type.Literal("todo"),
          Type.Literal("in_progress"),
          Type.Literal("needs_user"),
          Type.Literal("done"),
          Type.Literal("failed"),
          Type.Literal("cancelled")
        ])
      }, objectOptions), actions.updateIssueStatuses),
    issueStateDiagnoseTool(actions),
    issueStateRepairTool(actions),
    actionTool("issue_comment", "Issue Comment", "Add a low-risk agent comment to an issue.",
      Type.Object({ body: requiredText, issue_id: positiveID }, objectOptions), actions.commentIssue),
    actionTool("issue_enqueue_proposal", "Issue Enqueue Proposal",
      "Enqueue an issue when the user asks to run now; delegated Runner Chat can execute this directly.",
      Type.Object({ issue_id: positiveID, rationale: optionalString }, objectOptions), actions.enqueueIssueProposal),
    actionTool("issue_enqueue_batch_triage", "Issue Enqueue Batch Triage",
      "Batch-enqueue all matching status=triage issues in the requested/default Runner issue project when Supervisor understands the user wants a batch start; execution remains serial.",
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
      }, objectOptions), actions.scheduleIssueEnqueue),
    completionWatchCreateTool(actions),
    actionTool("issue_completion_watch_list", "Issue Completion Watch List",
      "Read active or selected persistent issue completion watches. Use watch_id to inspect one watch.",
      Type.Object({
        limit: Type.Optional(positiveNumber),
        project_id: optionalString,
        status: optionalString,
        watch_id: optionalString
      }, objectOptions), actions.listIssueCompletionWatches),
    actionTool("issue_completion_watch_cancel", "Issue Completion Watch Cancel",
      "Cancel one active persistent issue completion watch.",
      Type.Object({ reason: optionalString, watch_id: requiredText }, objectOptions), actions.cancelIssueCompletionWatch)
  ];
}

function runnerControlTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("runner_settings_read", "Runner Settings Read",
      "Read the bounded, non-secret Runner runtime settings exposed by the management API.",
      Type.Object({}, objectOptions), actions.readRunnerSettings),
    actionTool("runner_settings_update", "Runner Settings Update",
      "Update bounded Runner settings: parallel project limit and Codex CLI/App transport commands. Requires user approval and never edits arbitrary environment variables or secrets.",
      Type.Object({
        codex_app_command: optionalString,
        codex_cli_command: optionalString,
        codex_server_mode: Type.Optional(Type.Union([Type.Literal("cli"), Type.Literal("app")])),
        max_parallel_projects: Type.Optional(positiveNumber),
        reason: requiredText
      }, objectOptions), actions.updateRunnerSettings),
    actionTool("system_restart", "System Restart",
      "Request a supervised Runner service restart. Requires user approval, stops provider transports first, and is unavailable when launchd/systemd is not managing the service.",
      Type.Object({ reason: requiredText }, objectOptions), actions.restartSystem)
  ];
}

function completionWatchCreateTool(actions: PiRunnerActionLayer): ToolDefinition {
  return actionTool("issue_completion_watch_create", "Issue Completion Watch Create",
    "Create a persistent watch that will notify the target channel after all watched issues reach a terminal status.",
    Type.Object({
      condition: Type.Optional(Type.Any()),
      issue_ids: Type.Array(positiveID),
      note: optionalString,
      origin_conversation_id: optionalString,
      project_id: optionalString,
      requested_by: optionalString,
      source_event_id: optionalString,
      source_message_id: optionalString,
      target_channel: optionalString,
      target_chat_id: optionalString,
      target_message_id: optionalString,
      target_thread_id: optionalString
    }, objectOptions), actions.createIssueCompletionWatch);
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
      diagnosis_code: requiredText,
      issue_id: positiveID,
      operation: Type.Union([
        Type.Literal("comment"),
        Type.Literal("enqueue"),
        Type.Literal("move_status"),
        Type.Literal("patch_status"),
        Type.Literal("retry")
      ]),
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
    actionTool("skill_list", "Skill List", "List Codex skills metadata visible to Supervisor.",
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
      const details = await executeAction(params);
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
  return formatModelVisibleToolOutput(details, { maxChars: TOOL_RESULT_MAX_CHARS });
}
