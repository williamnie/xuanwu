import { Type } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { PiRunnerActionLayer } from "./runnerActions.ts";
import { objectOptions, optionalString, positiveNumber, requiredText, positiveID, skillIntentList } from "./runnerActionToolSchemas.ts";
import { actionTool } from "./runnerActionToolResult.ts";

export function runnerControlTools(actions: PiRunnerActionLayer): ToolDefinition[] {
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

export function completionWatchCreateTool(actions: PiRunnerActionLayer): ToolDefinition {
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

export function issueStateDiagnoseTool(actions: PiRunnerActionLayer): ToolDefinition {
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

export function issueStateRepairTool(actions: PiRunnerActionLayer): ToolDefinition {
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

export function projectActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
  return [
    actionTool("project_status", "Project Status", "Read a project status snapshot through the action layer.",
      Type.Object({ project_id: optionalString }, objectOptions), actions.projectStatus),
    actionTool("project_list", "Project List", "List runner projects through the action layer.",
      Type.Object({}, objectOptions), actions.listProjects)
  ];
}

export function sessionActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
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

export function skillActionTools(actions: PiRunnerActionLayer): ToolDefinition[] {
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
