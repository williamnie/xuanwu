import { type TSchema } from "@earendil-works/pi-ai";
import type { AgentToolResult, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { formatModelVisibleToolOutput } from "../../security/promptInjectionDefense.ts";
import { ActionToolName, ActionExecutor, TOOL_RESULT_MAX_CHARS } from "./runnerActionToolSchemas.ts";

export function actionTool<TParams extends TSchema>(
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

export function toolResult(details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: boundedToolResultText(details) }],
    details
  };
}

export function boundedToolResultText(details: unknown): string {
  return formatModelVisibleToolOutput(details, { maxChars: TOOL_RESULT_MAX_CHARS });
}
