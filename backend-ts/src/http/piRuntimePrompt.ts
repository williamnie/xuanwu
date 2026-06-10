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
    "Runner Chat workflow: create requested issues directly, then ask in chat whether to run now or schedule for later. If the user says now, call issue_enqueue_proposal. If the user gives a later time, call issue_schedule_enqueue with an RFC3339 next_run_at. Do not rely on click approvals for this issue create/run/schedule flow.",
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
