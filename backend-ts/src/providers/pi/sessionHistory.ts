import { statSync } from "node:fs";
import {
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry
} from "@earendil-works/pi-coding-agent";
import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { providerSessionDetail, type ProviderSessionDetailView } from "../core/sessionView.ts";

const PROVIDER = "pi-coding-agent";

export type PiSessionSnapshot = {
  createdAt: number;
  cwd: string;
  entries: SessionEntry[];
  id: string;
  name: string;
  updatedAt: number;
};

export type PiSessionFunctions = {
  read(path: string): PiSessionSnapshot;
  resolve(sessionId: string): Promise<string | undefined>;
};

export const defaultPiSessionFunctions: PiSessionFunctions = {
  async resolve(sessionId) {
    const sessions = await SessionManager.listAll();
    return sessions.find((session) => session.id === sessionId)?.path;
  },
  read(path) {
    const session = SessionManager.open(path);
    const header = session.getHeader();
    const stat = statSync(path);
    return {
      id: session.getSessionId(),
      cwd: session.getCwd(),
      name: session.getSessionName() ?? "",
      entries: session.getBranch(),
      createdAt: dateSeconds(header?.timestamp, stat.birthtimeMs || stat.ctimeMs),
      updatedAt: Math.floor(stat.mtimeMs / 1000)
    };
  }
};

export function publicPiSessionDetail(snapshot: PiSessionSnapshot, running = false): ProviderSessionDetailView {
  const preview = firstUserText(snapshot.entries);
  return providerSessionDetail(PROVIDER, {
    sessionRef: snapshot.id,
    name: redactSensitiveText(snapshot.name || preview || "Pi session"),
    preview: redactSensitiveText(preview),
    cwd: snapshot.cwd,
    status: running ? "running" : "idle",
    isRunning: running,
    createdAt: snapshot.createdAt,
    updatedAt: snapshot.updatedAt,
    model: latestModel(snapshot.entries),
    turns: piTranscriptTurns(snapshot.entries)
  });
}

export function piTranscriptTurns(entries: SessionEntry[]): Array<Record<string, unknown>> {
  const turns: Array<{ id: string; items: Array<Record<string, unknown>> }> = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const items = transcriptItems(entry);
    if (items.length === 0) continue;
    if (entry.message.role === "user" || turns.length === 0) {
      turns.push({ id: entry.id || `turn-${turns.length + 1}`, items: [] });
    }
    turns.at(-1)!.items.push(...items);
  }
  return turns;
}

function transcriptItems(entry: SessionMessageEntry): Array<Record<string, unknown>> {
  const message = entry.message;
  if (message.role === "user") {
    const text = messageText(message.content);
    return text ? [{ id: entry.id, type: "userMessage", content: [{ type: "input_text", text }] }] : [];
  }
  if (message.role === "toolResult") {
    return [{
      id: message.toolCallId || entry.id,
      type: "custom_tool_call_output",
      output: messageText(message.content),
      status: message.isError ? "failed" : "completed"
    }];
  }
  if (message.role !== "assistant") return [];
  return message.content.flatMap((content, index) => {
    const id = content.type === "toolCall" ? content.id : `${entry.id}:${index}`;
    if (content.type === "text") {
      const text = redactSensitiveText(content.text);
      return text ? [{ id, type: "agentMessage", text }] : [];
    }
    if (content.type === "thinking") {
      const text = redactSensitiveText(content.thinking);
      return text ? [{ id, type: "reasoning", content: [{ type: "text", text }] }] : [];
    }
    if (content.type === "toolCall") {
      return [{ id, type: "custom_tool_call", name: content.name || "tool", input: redactRegisteredSecrets(content.arguments) }];
    }
    return [];
  });
}

function firstUserText(entries: SessionEntry[]): string {
  for (const entry of entries) {
    if (entry.type === "message" && entry.message.role === "user") return messageText(entry.message.content);
  }
  return "";
}

function latestModel(entries: SessionEntry[]): string {
  let model = "";
  for (const entry of entries) {
    if (entry.type === "model_change") model = [entry.provider, entry.modelId].filter(Boolean).join("/");
    if (entry.type === "message" && entry.message.role === "assistant") {
      model = [entry.message.provider, entry.message.model].filter(Boolean).join("/") || model;
    }
  }
  return model;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return redactSensitiveText(content);
  if (!Array.isArray(content)) return "";
  return content.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string" ? [redactSensitiveText(record.text)] : [];
  }).filter(Boolean).join("\n");
}

function dateSeconds(value: string | undefined, fallbackMs: number): number {
  const parsed = Date.parse(value ?? "");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Math.floor(fallbackMs / 1000);
}
