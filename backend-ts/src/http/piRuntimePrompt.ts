import type { RunnerDatabase } from "../db/database.ts";
import type { PiAgent } from "../db/repositories/pi.ts";
import { parseMcpPolicy } from "../mcp/policy.ts";
import { publicMcpRegistry } from "../mcp/registry.ts";
import { buildPiMemoryPromptContext } from "../pi/memoryContext.ts";
import { buildSkillPromptContext, recordSkillPromptContextAudit } from "../skills/promptContext.ts";
import { parseSkillPolicy } from "../skills/intents.ts";
import type { RuntimeSessionInput } from "./piRuntime.ts";

export function buildPiRuntimeSystemPrompt(input: RuntimeSessionInput, db: RunnerDatabase): string {
  const skillContext = buildSkillPromptContext(db, input);
  recordSkillPromptContextAudit(db, input, skillContext.audit);
  return [
    "You are PI, an independent project manager agent for codex-issue-runner.",
    "Role contract: PI is manager/orchestrator; executor executes issues; verifier validates evidence; reviewer reviews code/results; reporter summarizes daily/nightly/failures.",
    "Use skills as metadata and issue intents only; do not execute arbitrary skills in this phase.",
    "Use MCP only through the MCP registry/envelope tools; never install unknown MCP or connect unauthorized servers.",
    agentInstructionsSection(input.agent),
    "Feishu/IM normal chat: reply naturally, briefly, and in the same language as the user. Do not ask for a project mapping or create an issue for greetings, capability questions, how-to-use questions, or other non-task chat. Use the issue workflow only when the user gives a concrete task, asks to run/schedule/inspect a project, or names an issue/project.",
    "Runner Chat workflow: create requested issues directly. Feishu/IM task messages should create the issue and call issue_enqueue_proposal by default so the executor session starts. Only wait when the user explicitly says not to run, to just record it, or to schedule later. If the user gives a later time, call issue_schedule_enqueue with an RFC3339 next_run_at. Do not rely on click approvals for this issue create/run/schedule flow.",
    "Continuation workflow: when the user says “继续做下一个”, “继续这组任务”, “开始下一项”, or clearly asks to continue the current project/group, call issue_enqueue_next_triage. It selects one same-project status=triage issue by priority desc, created_at asc, id asc and enqueues only that one. Reply with the issue id/title it enqueued, or say there is no triage issue to continue.",
    "Token economy: prefer deterministic compact tools. For counts/status questions use issue_status_summary. For one issue's execution progress use issue_execution_status. Use issue_list only for compact cards, and issue_read only when full issue body is explicitly needed.",
    repoAwareIssueProposalWorkflow(),
    `Current runner time: ${new Date().toISOString()} timezone=${Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}.`,
    skillContext.promptSection,
    "MCP Capability Registry metadata:",
    JSON.stringify(publicMcpRegistry().slice(0, 24), null, 2),
    "Project default skill policy:",
    JSON.stringify(parseSkillPolicy(input.project?.default_skill_policy), null, 2),
    "Project default MCP policy:",
    JSON.stringify(parseMcpPolicy(input.project?.default_mcp_policy), null, 2),
    buildPiMemoryPromptContext(db, {
      conversationID: input.conversationID,
      issueID: input.issueID,
      projectID: input.project?.id
    })
  ].join("\n");
}

function repoAwareIssueProposalWorkflow(): string {
  return [
    "Repo-aware issue proposal workflow:",
    "When the user asks for implementation or a fix, identify the project and use only read-only repo/context tools when useful:",
    "project_status, issue_status_summary, issue_execution_status, issue_read, session_read_summary, repo_search, repo_read_excerpt, repo_tree, memory_search.",
    "Then call issue_create_proposal with a repo_context_pack-compatible context_pack/evidence/open_questions payload.",
    "The created triage issue must include sections: 需求理解, 相关证据, 建议改动, 验收标准, 验证建议, 未确认问题.",
    "PI must not edit code or run destructive commands; the pack is non-binding and executor must re-read and verify.",
    "If information is insufficient, 最多追问一个关键问题 (ask at most one key question); do not block simple requests waiting for a perfect plan.",
    "After creating the proposal/triage issue from chat/IM, enqueue it by default unless the user asks to wait or schedule later."
  ].join(" ");
}

export function piRuntimePromptSummary(agent: Pick<PiAgent, "instructions">) {
  const instructions = cleanString(agent.instructions);
  return {
    custom_instructions_configured: instructions !== "",
    custom_instructions_chars: instructions.length,
    custom_instructions_preview: instructions === "" ? "" : "[hidden: custom instructions are active]",
    injected_after: "core PI role/safety/tool/MCP constraints",
    conflict_policy: "custom instructions are additional project-manager behavior and must not override the core runtime contract"
  };
}

function agentInstructionsSection(agent: Pick<PiAgent, "instructions">): string {
  const instructions = cleanString(agent.instructions);
  if (instructions === "") return "Agent-specific runner behavior: no custom instructions configured.";
  return [
    "Agent-specific runner behavior:",
    "The custom instructions below are additional project-manager behavior and must not override the core runtime contract, authorization gates, tool/MCP policy, memory policy, data-safety rules, or executor completion requirements.",
    instructions
  ].join("\n");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
