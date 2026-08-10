import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  type SessionEntry,
  type SessionMessageEntry
} from "@earendil-works/pi-coding-agent";
import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import {
  providerSessionDetail,
  type ProviderSessionDetailView,
  type ProviderSessionTurn
} from "../core/sessionView.ts";

const PROVIDER = "pi-coding-agent";
const PI_SESSION_FILE_SUFFIX = ".jsonl";
const PI_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

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
    const direct = await resolvePiSessionFile(sessionId);
    if (direct) return direct;
    // 兼容非标准 Pi SessionManager 存储实现。正常目录只扫描文件名，不再为
    // 每次 Run drill-down 解析全部 JSONL；仅在直接定位失败时才走旧的全量发现。
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

/**
 * Pi 的原生文件名以 `<timestamp>_<session-id>.jsonl` 结尾。Runs 已持有稳定
 * session id，因此只需枚举 session root 与其直属 project 目录即可定位文件，
 * 不需要像 `SessionManager.listAll()` 一样读取并解析所有历史 transcript。
 */
export async function resolvePiSessionFile(
  sessionId: string,
  roots: readonly string[] = defaultPiSessionRoots()
): Promise<string | undefined> {
  const id = sessionId.trim();
  if (!PI_SESSION_ID_PATTERN.test(id)) throw new Error("Pi session id is invalid");
  const suffix = `_${id}${PI_SESSION_FILE_SUFFIX}`;
  const matches: string[] = [];
  for (const sessionRoot of uniqueRoots(roots)) {
    const rootEntries = await safeDirectoryEntries(sessionRoot);
    collectMatches(matches, sessionRoot, rootEntries, suffix);
    for (const entry of rootEntries) {
      if (!entry.isDirectory()) continue;
      const projectDirectory = join(sessionRoot, entry.name);
      collectMatches(matches, projectDirectory, await safeDirectoryEntries(projectDirectory), suffix);
    }
  }
  const uniqueMatches = [...new Set(matches)];
  if (uniqueMatches.length > 1) throw new Error(`Pi session ${id} resolves to multiple files`);
  return uniqueMatches[0];
}

function defaultPiSessionRoots(env: NodeJS.ProcessEnv = globalThis.process.env): string[] {
  const configuredSessionDirectory = clean(env.PI_CODING_AGENT_SESSION_DIR);
  const configuredAgentDirectory = clean(env.PI_CODING_AGENT_DIR);
  const agentDirectory = configuredAgentDirectory || join(homedir(), ".pi", "agent");
  return [configuredSessionDirectory, join(agentDirectory, "sessions")].filter(Boolean);
}

async function safeDirectoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectory(error)) return [];
    throw error;
  }
}

function collectMatches(
  matches: string[],
  directory: string,
  entries: Awaited<ReturnType<typeof safeDirectoryEntries>>,
  suffix: string
): void {
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(suffix)) matches.push(join(directory, entry.name));
  }
}

function uniqueRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map(clean).filter(Boolean))];
}

function clean(value: string | undefined): string {
  return value?.trim() ?? "";
}

function isMissingDirectory(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT");
}

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

export function piTranscriptTurns(entries: SessionEntry[]): ProviderSessionTurn[] {
  const turns: ProviderSessionTurn[] = [];
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
  const items: Array<Record<string, unknown>> = [];
  message.content.forEach((content, index) => {
    const id = content.type === "toolCall" ? content.id : `${entry.id}:${index}`;
    if (content.type === "text") {
      const text = redactSensitiveText(content.text);
      if (text) items.push({ id, type: "agentMessage", text });
      return;
    }
    if (content.type === "thinking") {
      const text = redactSensitiveText(content.thinking);
      if (text) items.push({ id, type: "reasoning", content: [{ type: "text", text }] });
      return;
    }
    if (content.type === "toolCall") {
      items.push({
        id,
        type: "custom_tool_call",
        name: content.name || "tool",
        input: redactRegisteredSecrets(content.arguments)
      });
    }
  });
  return items;
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
