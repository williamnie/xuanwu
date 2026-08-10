import type { SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import {
  providerSessionDetail,
  providerSessionSummary,
  type ProviderSessionDetailView,
  type ProviderSessionTurn,
  type ProviderSessionView
} from "../core/sessionView.ts";

const PROVIDER = "claude";

export function publicClaudeSessionSummary(info: SDKSessionInfo, running = false): ProviderSessionView {
  return providerSessionSummary(PROVIDER, {
    sessionRef: info.sessionId,
    name: redactSensitiveText(info.customTitle || info.summary || "Claude session"),
    preview: redactSensitiveText(info.firstPrompt || info.summary || ""),
    cwd: info.cwd || "",
    status: running ? "running" : "idle",
    isRunning: running,
    createdAt: Math.floor(info.lastModified / 1000),
    updatedAt: Math.floor(info.lastModified / 1000)
  });
}

export function publicClaudeSessionDetail(
  sessionId: string,
  info: SDKSessionInfo | undefined,
  messages: SessionMessage[],
  running = false
): ProviderSessionDetailView {
  return providerSessionDetail(PROVIDER, {
    sessionRef: sessionId,
    name: redactSensitiveText(info?.customTitle || info?.summary || "Claude session"),
    preview: redactSensitiveText(info?.firstPrompt || info?.summary || ""),
    cwd: info?.cwd || "",
    status: running ? "running" : "idle",
    isRunning: running,
    createdAt: info ? Math.floor(info.lastModified / 1000) : 0,
    updatedAt: info ? Math.floor(info.lastModified / 1000) : 0,
    model: claudeSessionModel(messages),
    turns: claudeTranscriptTurns(messages)
  });
}

export function claudeSessionModel(messages: SessionMessage[]): string {
  let model = "";
  for (const entry of messages) {
    const record = objectValue(entry);
    const message = objectValue(record.message);
    model = stringValue(message.model) || stringValue(record.model) || model;
  }
  return model;
}

export function assertClaudeSessionHistoryIdentity(
  sessionId: string,
  info: SDKSessionInfo | undefined,
  messages: SessionMessage[]
): void {
  const expected = sessionId.trim();
  if (info && info.sessionId !== expected) {
    throw new Error(`Claude session ${expected} resolved to mismatched history ${info.sessionId}`);
  }
  const mismatched = messages.find((message) => {
    const observed = stringValue(message.session_id);
    return observed !== "" && observed !== expected;
  });
  if (mismatched) {
    throw new Error(`Claude session ${expected} transcript contains mismatched history ${mismatched.session_id}`);
  }
}

export function claudeTranscriptTurns(messages: SessionMessage[]): ProviderSessionTurn[] {
  const turns: ProviderSessionTurn[] = [];
  for (const entry of messages) {
    const items = transcriptItems(entry);
    if (items.length === 0) continue;
    const startsUserTurn = entry.type === "user" && items.some((item) => item.type === "userMessage");
    if (startsUserTurn || turns.length === 0) turns.push({ id: entry.uuid || `turn-${turns.length + 1}`, items: [] });
    turns.at(-1)!.items.push(...items);
  }
  return turns;
}

function transcriptItems(entry: SessionMessage): Array<Record<string, unknown>> {
  if (entry.type === "system") return [];
  const message = objectValue(entry.message);
  const content = Array.isArray(message.content) ? message.content : message.content ? [message.content] : [];
  if (typeof message.content === "string") {
    const text = redactSensitiveText(message.content);
    return text ? [messageItem(entry.uuid, entry.type, text)] : [];
  }
  return content.flatMap((value, index) => {
    const block = objectValue(value);
    const id = stringValue(block.id) || `${entry.uuid}:${index}`;
    if (block.type === "text") {
      const text = redactSensitiveText(stringValue(block.text));
      return text ? [messageItem(id, entry.type, text)] : [];
    }
    if (block.type === "thinking") {
      const text = redactSensitiveText(stringValue(block.thinking));
      return text ? [{ id, type: "reasoning", content: [{ type: "text", text }] }] : [];
    }
    if (block.type === "tool_use") return [transcriptToolUse(id, block)];
    if (block.type === "tool_result") {
      return [{
        id: stringValue(block.tool_use_id) || id,
        type: "custom_tool_call_output",
        output: claudeTranscriptContent(block.content),
        status: block.is_error ? "failed" : "completed"
      }];
    }
    return [];
  });
}

function messageItem(id: string, type: SessionMessage["type"], text: string): Record<string, unknown> {
  if (type === "assistant") return { id, type: "agentMessage", text };
  return { id, type: "userMessage", content: [{ type: "input_text", text }] };
}

function transcriptToolUse(id: string, block: Record<string, unknown>): Record<string, unknown> {
  const name = stringValue(block.name) || "tool";
  const input = objectValue(block.input);
  if (name === "Bash") {
    return { id, type: "commandExecution", command: redactSensitiveText(stringValue(input.command)), text: "", status: "completed" };
  }
  if (name === "Edit" || name === "Write") {
    return {
      id,
      type: "fileChange",
      path: redactSensitiveText(stringValue(input.file_path)),
      text: claudeTranscriptContent(input),
      status: "completed"
    };
  }
  return { id, type: "custom_tool_call", name, input: redactRegisteredSecrets(input) };
}

export function claudeTranscriptContent(value: unknown): string {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value === "string") return redactSensitiveText(value);
  try { return redactSensitiveText(JSON.stringify(value, null, 2)); } catch { return redactSensitiveText(String(value)); }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
