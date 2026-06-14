export type FeishuIssueCommand = { task: string };

export function parseFeishuIssueCommand(text: string): FeishuIssueCommand | null {
  const match = cleanString(text).match(/^\/issue(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { task: cleanString(match[1]) };
}

export function buildFeishuIssueCommandPrompt(command: FeishuIssueCommand): string {
  const task = command.task || "(用户未提供任务描述)";
  return [
    "Feishu /issue command: enter the issue workflow now, not ordinary chat.",
    "Create a runner issue for the task below with issue_create_proposal, then call issue_enqueue_proposal by default so the executor session starts unless the user explicitly asks to wait.",
    "Reply in Chinese with the issue id, project id/name, whether the executor session started, and how to view/follow up.",
    "If one key detail is still missing, ask at most one concise clarification question.",
    `Task: ${task}`
  ].join("\n");
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
