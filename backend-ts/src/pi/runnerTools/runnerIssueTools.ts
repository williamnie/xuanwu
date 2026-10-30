import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiRunnerActionLayer } from "./runnerActions.ts";
import { positiveNumber, optionalString, issueQueryScope, objectOptions, positiveID, requiredText, repoContextPack, evidenceList, relevantFile, textList, skillIntentList, mcpCapabilityList, evidenceValue } from "./runnerActionToolSchemas.ts";
import { issueStateDiagnoseTool, issueStateRepairTool, completionWatchCreateTool } from "./runnerContextTools.ts";
import { actionTool } from "./runnerActionToolResult.ts";

export function issueActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
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
      "Request issue-scoped PI semantic acceptance for an ended Run in in_progress or needs_user without an open human review. If a review is open, use human_review_response. Explicit human acceptance of a needs_user delivery should be recorded through human_review_request_create(kind=acceptance) and human_review_response, not as a request for further verification. PI reads current facts before deciding; this tool does not force done or start a new Run.",
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
