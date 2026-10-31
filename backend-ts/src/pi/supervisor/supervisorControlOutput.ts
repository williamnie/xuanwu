import { type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatModelVisibleToolOutput } from "../../security/promptInjectionDefense.ts";
import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { WORK_WRITE_AUTHORITY } from "../../http/work/workApi.ts";
import { RUN_WRITE_AUTHORITY } from "../../http/work/runApi.ts";
import { createIssueCompletionProjection } from "../runnerTools/issueToolViews.ts";
import { SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS, SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS } from "./supervisorControlContracts.ts";
import { MutationActionType, SupervisorControlToolName, ToolExecutor } from "./supervisorControlTools.ts";

export function retryPreconditionFailure(
  db: RunnerDatabase,
  issueID: number,
  actionType: MutationActionType
): string | undefined {
  if (actionType !== "work.retry" && actionType !== "run.retry") return undefined;
  const issue = getIssue(db, issueID);
  if (!issue) return undefined;
  const completion = createIssueCompletionProjection(db, issue, listIssueRuns(db, issue.id).at(-1));
  return completion.state === "acceptance_pending"
    ? "the Run is terminal and PI semantic acceptance is pending; do not retry the executor"
    : undefined;
}

export function withBudget(authority: string, value: Record<string, unknown>): Record<string, unknown> {
  const output = {
    authority,
    observed_at: new Date().toISOString(),
    output_budget: {
      max_chars: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
      max_tokens_estimate: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
    },
    ...value
  };
  const serialized = JSON.stringify(output);
  if (serialized.length <= SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS) return output;
  let preview = serialized.slice(0, SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS - 1000);
  let bounded = truncatedProjection(authority, serialized.length, preview);
  while (JSON.stringify(bounded).length > SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS && preview.length > 0) {
    preview = preview.slice(0, Math.max(0, preview.length - 256));
    bounded = truncatedProjection(authority, serialized.length, preview);
  }
  return bounded;
}

export function truncatedProjection(authority: string, originalChars: number, preview: string): Record<string, unknown> {
  return {
    authority,
    observed_at: new Date().toISOString(),
    original_chars: originalChars,
    output_budget: {
      max_chars: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
      max_tokens_estimate: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
    },
    preview,
    truncated: true
  };
}

export function domainAuthority(domain: string): string {
  if (domain === "work") return WORK_WRITE_AUTHORITY;
  if (domain === "run") return RUN_WRITE_AUTHORITY;
  return "unknown";
}

export function controlTool<TParams extends TSchema>(
  name: SupervisorControlToolName,
  label: string,
  description: string,
  parameters: TParams,
  executeAction: ToolExecutor<TParams>
): ToolDefinition<TParams> {
  return {
    name,
    label,
    description,
    parameters,
    async execute(_toolCallID, params) {
      const details = await executeAction(params);
      return toolResult(details);
    }
  };
}

export function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{
      type: "text",
      text: formatModelVisibleToolOutput(details, { maxChars: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS })
    }],
    details
  };
}
