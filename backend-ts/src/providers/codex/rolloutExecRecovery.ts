import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { ProviderEvent } from "../types.ts";
import { normalizeCodexEvent } from "./events.ts";
import type { ThreadSummary } from "./threadLifecycle.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { codexSessionRoots, resolveCodexRolloutPath, safeCodexRolloutPath, parsedObject, elapsedMilliseconds } from "./rolloutRecoveryPaths.ts";

export const MAX_ROLLOUT_BYTES = 32 * 1024 * 1024;

export type RolloutItem = {
  payload: Record<string, unknown>;
  timestamp: string;
};

export type RolloutRecoveryOptions = {
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
  const polls = new Map<string, string>();
  const sessions = new Map<string, { call: RolloutItem; output: string[] }>();
  const output: ProviderEvent[] = [];
  for (const line of source.split(/\r?\n/)) {
    const entry = parsedObject(line);
    if (!entry || cleanString(entry.type) !== "response_item") continue;
    const item = objectValue(entry.payload);
    const itemType = cleanString(item.type);
    if (itemType === "custom_tool_call" || itemType === "function_call") {
      const callID = cleanString(item.call_id);
      if (itemType === "function_call" && cleanString(item.name) === "write_stdin" && matchesTurn(item, input.turnID)) {
        const args = parsedObject(cleanString(item.arguments));
        const sessionID = integerText(args?.session_id);
        if (callID !== "" && sessionID !== "") polls.set(callID, sessionID);
        continue;
      }
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
    const pollSessionID = polls.get(cleanString(item.call_id));
    if (pollSessionID) {
      const pending = sessions.get(pollSessionID);
      if (!pending || !matchesTurn(item, input.turnID)) continue;
      const text = cleanString(item.output);
      if (text !== "") pending.output.push(text);
      const exitCode = processExitCode(text);
      if (exitCode === undefined) continue;
      const event = recoveredExecEvent(pending.call, {
        output: { output: [{ type: "input_text", text: pending.output.join("\n") }] },
        threadID: input.threadID,
        timestamp: cleanString(entry.timestamp),
        turnID: input.turnID
      });
      if (event) output.push(event);
      sessions.delete(pollSessionID);
      continue;
    }
    const call = calls.get(cleanString(item.call_id));
    if (!call || !matchesTurn(item, input.turnID)) continue;
    const sessionID = outputSessionID(item.output);
    if (sessionID !== "" && explicitNestedExitCode(Array.isArray(item.output) ? item.output : []) === undefined) {
      sessions.set(sessionID, {
        call,
        output: outputText(item.output) === "" ? [] : [outputText(item.output)]
      });
      continue;
    }
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

export function recoveredExecEvent(
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

export function recoveredDirectCommandEvent(
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

export function directCommandExitCode(output: string): number | undefined {
  const match = output.match(/(?:^|\n)Process exited with code (-?\d+)(?:\n|$)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

export function explicitNestedExitCode(contentItems: unknown[]): number | undefined {
  const text = contentItems.map((entry) => cleanString(objectValue(entry).text)).filter(Boolean).join("\n");
  const match = text.match(/"exit_code"\s*:\s*(-?\d+)/);
  if (match) {
    const value = Number(match[1]);
    return Number.isSafeInteger(value) ? value : undefined;
  }
  const processCode = processExitCode(text);
  if (processCode !== undefined) return processCode;
  if (/\b(?:SESSION_ID=|Process running with session ID)\d+\b/.test(text)) return undefined;
  // Current Codex unified-exec output is itself a structured terminal
  // envelope. Keep this aligned with codexDynamicExecObservation so a durable
  // rollout does not lose successful commands merely because the nested JSON
  // result was rendered as text instead of echoed verbatim.
  if (/^Script completed(?:\r?\n|$)/.test(text)) return 0;
  if (/^Script (?:failed|terminated)(?:\r?\n|$)/.test(text)) return 1;
  return undefined;
}

export function processExitCode(value: string): number | undefined {
  const match = value.match(/(?:^|\n)Process exited with code (-?\d+)(?:\n|$)/);
  if (!match) return undefined;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) ? code : undefined;
}

export function outputSessionID(value: unknown): string {
  const match = outputText(value).match(/(?:^|\n)SESSION_ID=(\d+)(?:\n|$)/);
  return match?.[1] ?? "";
}

export function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((entry) => cleanString(objectValue(entry).text)).filter(Boolean).join("\n");
}

export function integerText(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  const text = cleanString(value);
  return /^\d+$/.test(text) ? text : "";
}

export function matchesTurn(item: Record<string, unknown>, expectedTurnID: string): boolean {
  const metadata = objectValue(item.internal_chat_message_metadata_passthrough);
  const observed = cleanString(metadata.turn_id);
  return observed === "" || expectedTurnID === "" || observed === expectedTurnID;
}
