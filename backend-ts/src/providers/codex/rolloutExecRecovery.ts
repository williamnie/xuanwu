import { readdir, readFile, stat } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ProviderEvent } from "../types.ts";
import { normalizeCodexEvent } from "./events.ts";
import type { ThreadSummary } from "./threadLifecycle.ts";

const MAX_ROLLOUT_BYTES = 32 * 1024 * 1024;

type RolloutItem = {
  payload: Record<string, unknown>;
  timestamp: string;
};

type RolloutRecoveryOptions = {
  codexHome?: string;
};

/**
 * app-server's live notification stream can omit nested unified-exec calls.
 * A completed non-ephemeral Codex thread still has the authoritative rollout,
 * so recover only terminal `exec -> tools.exec_command` pairs before the
 * turn/completed event reaches the Runner completion gate.
 */
export async function recoverCodexRolloutExecEvents(
  thread: ThreadSummary,
  turnID: string,
  options: RolloutRecoveryOptions = {}
): Promise<ProviderEvent[]> {
  const roots = codexSessionRoots(options.codexHome);
  const path = await resolveCodexRolloutPath(thread, roots);
  if (!safeCodexRolloutPath(path, roots)) return [];
  const info = await stat(path);
  if (!info.isFile() || info.size <= 0 || info.size > MAX_ROLLOUT_BYTES) return [];
  return parseCodexRolloutExecEvents(await readFile(path, "utf8"), {
    threadID: thread.provider_session_id,
    turnID
  });
}

export function parseCodexRolloutExecEvents(
  source: string,
  input: { threadID: string; turnID: string }
): ProviderEvent[] {
  const calls = new Map<string, RolloutItem>();
  const output: ProviderEvent[] = [];
  for (const line of source.split(/\r?\n/)) {
    const entry = parsedObject(line);
    if (!entry || cleanString(entry.type) !== "response_item") continue;
    const item = objectValue(entry.payload);
    const itemType = cleanString(item.type);
    if (itemType === "custom_tool_call" || itemType === "function_call") {
      const callID = cleanString(item.call_id);
      const supportedCall = itemType === "custom_tool_call"
        ? cleanString(item.name) === "exec"
        : cleanString(item.name) === "exec_command";
      if (
        callID !== ""
        && supportedCall
        && matchesTurn(item, input.turnID)
      ) {
        calls.set(callID, { payload: item, timestamp: cleanString(entry.timestamp) });
      }
      continue;
    }
    if (itemType !== "custom_tool_call_output" && itemType !== "function_call_output") continue;
    const call = calls.get(cleanString(item.call_id));
    if (!call || !matchesTurn(item, input.turnID)) continue;
    const event = recoveredExecEvent(call, {
      output: item,
      threadID: input.threadID,
      timestamp: cleanString(entry.timestamp),
      turnID: input.turnID
    });
    if (event) output.push(event);
  }
  return output;
}

function recoveredExecEvent(
  call: RolloutItem,
  input: {
    output: Record<string, unknown>;
    threadID: string;
    timestamp: string;
    turnID: string;
  }
): ProviderEvent | undefined {
  if (cleanString(call.payload.type) === "function_call") {
    return recoveredDirectCommandEvent(call, input);
  }
  const contentItems = Array.isArray(input.output.output) ? input.output.output : [];
  const exitCode = explicitNestedExitCode(contentItems);
  if (exitCode === undefined) return undefined;
  const durationMs = elapsedMilliseconds(call.timestamp, input.timestamp);
  const event = normalizeCodexEvent({
    method: "item/completed",
    params: {
      item: {
        arguments: cleanString(call.payload.input),
        contentItems,
        durationMs,
        exitCode,
        id: cleanString(call.payload.id) || cleanString(call.payload.call_id),
        status: "completed",
        success: true,
        tool: "exec",
        type: "dynamicToolCall"
      },
      threadId: input.threadID,
      turnId: input.turnID
    }
  });
  return event.type === "tool" ? event : undefined;
}

function recoveredDirectCommandEvent(
  call: RolloutItem,
  input: {
    output: Record<string, unknown>;
    threadID: string;
    timestamp: string;
    turnID: string;
  }
): ProviderEvent | undefined {
  const args = parsedObject(cleanString(call.payload.arguments));
  const command = cleanString(args?.cmd);
  const output = cleanString(input.output.output);
  const exitCode = directCommandExitCode(output);
  if (command === "" || exitCode === undefined) return undefined;
  return normalizeCodexEvent({
    method: "item/completed",
    params: {
      item: {
        aggregatedOutput: output,
        command,
        cwd: cleanString(args?.workdir) || ".",
        durationMs: elapsedMilliseconds(call.timestamp, input.timestamp),
        exitCode,
        id: cleanString(call.payload.id) || cleanString(call.payload.call_id),
        status: exitCode === 0 ? "completed" : "failed",
        type: "commandExecution"
      },
      threadId: input.threadID,
      turnId: input.turnID
    }
  });
}

function directCommandExitCode(output: string): number | undefined {
  const match = output.match(/(?:^|\n)Process exited with code (-?\d+)(?:\n|$)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function explicitNestedExitCode(contentItems: unknown[]): number | undefined {
  const text = contentItems.map((entry) => cleanString(objectValue(entry).text)).filter(Boolean).join("\n");
  const match = text.match(/"exit_code"\s*:\s*(-?\d+)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function matchesTurn(item: Record<string, unknown>, expectedTurnID: string): boolean {
  const metadata = objectValue(item.internal_chat_message_metadata_passthrough);
  const observed = cleanString(metadata.turn_id);
  return observed === "" || expectedTurnID === "" || observed === expectedTurnID;
}

async function resolveCodexRolloutPath(
  thread: ThreadSummary,
  roots: string[]
): Promise<string> {
  const explicit = cleanString(thread.path);
  if (safeCodexRolloutPath(explicit, roots)) return explicit;
  // thread/start 通常没有 rollout path；UUIDv7 自带时间，只查对应日期附近的受控 sessions 目录。
  const threadID = cleanString(thread.provider_session_id);
  const dateParts = uuidV7DateParts(threadID);
  if (dateParts.length === 0) return "";
  const suffix = `-${threadID}.jsonl`;
  for (const root of roots) {
    for (const parts of dateParts) {
      const directory = join(root, ...parts);
      let entries: Dirent[];
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      const matches = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix))
        .map((entry) => join(directory, entry.name))
        .sort();
      if (matches.length === 1 && safeCodexRolloutPath(matches[0]!, roots)) {
        return matches[0]!;
      }
    }
  }
  return "";
}

function codexSessionRoots(codexHome?: string): string[] {
  const explicitHome = cleanString(codexHome);
  const configuredHome = explicitHome || cleanString(process.env.CODEX_HOME);
  const values = explicitHome
    ? [join(explicitHome, "sessions")]
    : [
      configuredHome ? join(configuredHome, "sessions") : "",
      join(homedir(), ".codex", "sessions")
    ];
  return [...new Set(values.filter(Boolean).map((root) => resolve(root)))];
}

function safeCodexRolloutPath(path: string, roots: string[]): boolean {
  if (!isAbsolute(path)) return false;
  const candidate = resolve(path);
  return roots.some((root) => {
    const child = relative(root, candidate);
    return child !== "" && child !== ".." && !child.startsWith(`..${sep}`);
  });
}

function uuidV7DateParts(threadID: string): string[][] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadID)) {
    return [];
  }
  const timestamp = Number.parseInt(threadID.replaceAll("-", "").slice(0, 12), 16);
  if (!Number.isSafeInteger(timestamp)) return [];
  const output: string[][] = [];
  const seen = new Set<string>();
  for (const offset of [0, -86_400_000, 86_400_000]) {
    const date = new Date(timestamp + offset);
    const candidates = [
      [date.getFullYear(), date.getMonth() + 1, date.getDate()],
      [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
    ];
    for (const [year, month, day] of candidates) {
      const parts = [String(year), padDatePart(month), padDatePart(day)];
      const key = parts.join("/");
      if (seen.has(key)) continue;
      seen.add(key);
      output.push(parts);
    }
  }
  return output;
}

function padDatePart(value: number): string {
  return String(value).padStart(2, "0");
}

function elapsedMilliseconds(start: string, end: string): number {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return Number.isFinite(startMs) && Number.isFinite(endMs)
    ? Math.max(0, Math.round(endMs - startMs))
    : 0;
}

function parsedObject(value: string): Record<string, unknown> | undefined {
  if (value.trim() === "") return undefined;
  try {
    return objectValue(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
