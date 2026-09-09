import type { GetSessionMessagesOptions, SDKSessionInfo, SessionMessage } from "@anthropic-ai/claude-agent-sdk";
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

export const CLAUDE_HISTORY_MESSAGE_LIMIT = 10_000;
export const CLAUDE_HISTORY_TEXT_BYTES = 32 * 1024 * 1024;
export const CLAUDE_HISTORY_FILE_BYTES = 64 * 1024 * 1024;
const CLAUDE_HISTORY_VALUE_LIMIT = 250_000;
const CLAUDE_HISTORY_CONCURRENCY = 4;
let activeHistoryReads = 0;

export async function readBoundedClaudeSessionHistory(
  sessionId: string,
  info: SDKSessionInfo | undefined,
  readMessages: (id: string, options?: GetSessionMessagesOptions) => Promise<SessionMessage[]>
): Promise<SessionMessage[]> {
  // SDK 先解析/构建完整 parentUuid 链，最后才应用 offset/limit；不能把
  // message 分页当作 turn 分页，也不能靠重复分页降低 SDK 内部读取成本。
  if (info?.fileSize !== undefined && info.fileSize > CLAUDE_HISTORY_FILE_BYTES) {
    throw new Error("Claude history exceeds 64 MiB source limit; archive or split this session");
  }
  if (activeHistoryReads >= CLAUDE_HISTORY_CONCURRENCY) throw new Error("Claude history is busy; retry the request");
  activeHistoryReads++;
  try {
    const messages = await readMessages(sessionId, {
      ...(info?.cwd ? { dir: info.cwd } : {}),
      includeSystemMessages: false,
      limit: CLAUDE_HISTORY_MESSAGE_LIMIT + 1,
      offset: 0
    });
    assertClaudeSessionHistoryBudget(messages);
    return messages;
  } finally {
    activeHistoryReads--;
  }
}

export function assertClaudeSessionHistoryBudget(messages: SessionMessage[]): void {
  if (messages.length > CLAUDE_HISTORY_MESSAGE_LIMIT) {
    throw new Error("Claude history exceeds 10000 messages; archive or split this session");
  }
  let textBytes = 0;
  let values = 0;
  // 遍历已有对象计数，不先 JSON.stringify 复制整份大历史。深度/节点上限
  // 同时约束大量空对象、超深工具参数等低字节高对象数的输入。
  const visit = (value: unknown, depth: number): void => {
    if (++values > CLAUDE_HISTORY_VALUE_LIMIT || depth > 64) {
      throw new Error("Claude history exceeds object complexity limit; archive or split this session");
    }
    if (typeof value === "string") textBytes += Buffer.byteLength(value, "utf8");
    else if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
    } else if (value && typeof value === "object") {
      for (const key of Object.keys(value)) {
        textBytes += Buffer.byteLength(key, "utf8");
        visit((value as Record<string, unknown>)[key], depth + 1);
      }
    }
    if (textBytes > CLAUDE_HISTORY_TEXT_BYTES) {
      throw new Error("Claude history exceeds 32 MiB content limit; archive or split this session");
    }
  };
  for (const message of messages) visit(message, 0);
}

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
