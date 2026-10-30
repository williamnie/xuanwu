import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { createPiRunnerActionTools } from "./runnerActionTools.ts";

export function toolByName(tools: ReturnType<typeof createPiRunnerActionTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

export function validateArgs(tool: ReturnType<typeof toolByName>, args: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
}

export function collectToolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "object" && block && "text" in block && typeof block.text === "string") return block.text;
    return "";
  }).join("\n");
}

export async function runTool(
  tools: ReturnType<typeof createPiRunnerActionTools>,
  name: string,
  params: Record<string, unknown>
) {
  return toolByName(tools, name).execute("tool-call", params as never, undefined, undefined, {} as never);
}
