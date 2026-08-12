import {
  getSessionInfo as sdkGetSessionInfo,
  getSessionMessages as sdkGetSessionMessages,
  listSessions as sdkListSessions,
  type GetSessionInfoOptions,
  type GetSessionMessagesOptions,
  type ListSessionsOptions,
  type SDKSessionInfo,
  type SessionMessage
} from "@qoder-ai/qoder-agent-sdk";
import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import {
  providerSessionDetail,
  providerSessionSummary,
  type ProviderSessionDetailView,
  type ProviderSessionTurn,
  type ProviderSessionView
} from "../core/sessionView.ts";

const PROVIDER = "qoder" as const;
export const QODER_HISTORY_PAGE_SIZE = 100;
export const QODER_HISTORY_MESSAGE_LIMIT = 500;

export type QoderSessionFunctions = {
  getSessionInfo(sessionId: string, options?: GetSessionInfoOptions): Promise<SDKSessionInfo | undefined>;
  getSessionMessages(sessionId: string, options?: GetSessionMessagesOptions): Promise<SessionMessage[]>;
  listSessions(options?: ListSessionsOptions): Promise<SDKSessionInfo[]>;
};

export const defaultQoderSessionFunctions: QoderSessionFunctions = {
  getSessionInfo: sdkGetSessionInfo,
  getSessionMessages: sdkGetSessionMessages,
  listSessions: sdkListSessions
};

export type QoderHistoryPage = {
  messages: SessionMessage[];
  truncated: boolean;
};

export async function readQoderSessionHistory(
  functions: QoderSessionFunctions,
  sessionId: string,
  cwd = ""
): Promise<QoderHistoryPage> {
  const messages: SessionMessage[] = [];
  while (messages.length < QODER_HISTORY_MESSAGE_LIMIT) {
    const limit = Math.min(QODER_HISTORY_PAGE_SIZE, QODER_HISTORY_MESSAGE_LIMIT - messages.length);
    const page = await functions.getSessionMessages(sessionId, {
      ...(cwd.trim() ? { dir: cwd.trim() } : {}),
      includeSystemMessages: true,
      limit,
      offset: messages.length
    });
    if (!Array.isArray(page)) throw new Error(`Qoder session ${sessionId} returned malformed history`);
    messages.push(...page.slice(0, limit));
    if (page.length < limit) return { messages, truncated: false };
  }
  return { messages, truncated: true };
}

export function publicQoderSessionSummary(info: SDKSessionInfo, running = false): ProviderSessionView {
  return providerSessionSummary(PROVIDER, {
    sessionRef: info.sessionId,
    name: redactSensitiveText(info.customTitle || info.summary || info.firstPrompt || "Qoder session"),
    preview: redactSensitiveText(info.firstPrompt || info.summary || ""),
    cwd: info.cwd || "",
    status: running ? "running" : "idle",
    isRunning: running,
    createdAt: millisecondsToSeconds(info.createdAt ?? info.lastModified),
    updatedAt: millisecondsToSeconds(info.lastModified),
    extensions: sessionInfoExtensions(info)
  });
}

export function publicQoderSessionDetail(
  sessionId: string,
  info: SDKSessionInfo | undefined,
  messages: SessionMessage[],
  options: {
    extensions?: Record<string, unknown>;
    running?: boolean;
    truncated?: boolean;
  } = {}
): ProviderSessionDetailView {
  return providerSessionDetail(PROVIDER, {
    sessionRef: sessionId,
    name: redactSensitiveText(info?.customTitle || info?.summary || info?.firstPrompt || "Qoder session"),
    preview: redactSensitiveText(info?.firstPrompt || info?.summary || firstUserText(messages)),
    cwd: info?.cwd || "",
    status: options.running ? "running" : "idle",
    isRunning: options.running === true,
    createdAt: millisecondsToSeconds(info?.createdAt ?? info?.lastModified),
    updatedAt: millisecondsToSeconds(info?.lastModified),
    model: latestModel(messages),
    turns: qoderTranscriptTurns(messages),
    extensions: {
      ...sessionInfoExtensions(info),
      ...qoderHistoryExtensions(messages),
      history: {
        loaded_messages: messages.length,
        limit: QODER_HISTORY_MESSAGE_LIMIT,
        truncated: options.truncated === true
      },
      ...(options.extensions ?? {})
    }
  });
}

export function assertQoderSessionHistoryIdentity(
  sessionId: string,
  info: SDKSessionInfo | undefined,
  messages: SessionMessage[]
): void {
  const expected = sessionId.trim();
  if (info && info.sessionId.trim() !== expected) {
    throw new Error(`Qoder session ${expected} resolved to mismatched history ${info.sessionId}`);
  }
  for (const message of messages) {
    const observed = stringValue(recordValue(message).session_id);
    if (observed && observed !== expected) {
      throw new Error(`Qoder session ${expected} transcript contains mismatched history ${observed}`);
    }
  }
}

export function qoderTranscriptTurns(messages: SessionMessage[]): ProviderSessionTurn[] {
  const turns: ProviderSessionTurn[] = [];
  messages.forEach((entry, entryIndex) => {
    const raw = recordValue(entry);
    const items = transcriptItems(raw, entryIndex);
    if (items.length === 0) return;
    const startsUserTurn = stringValue(raw.type) === "user" && items.some((item) => item.type === "userMessage");
    if (startsUserTurn || turns.length === 0) {
      turns.push({ id: stringValue(raw.uuid) || `turn-${turns.length + 1}`, items: [] });
    }
    turns.at(-1)!.items.push(...items);
  });
  return turns;
}

function transcriptItems(entry: Record<string, unknown>, entryIndex: number): Array<Record<string, unknown>> {
  const type = stringValue(entry.type);
  const message = recordValue(entry.message);
  const content = typeof message.content === "string"
    ? [{ type: "text", text: message.content }]
    : Array.isArray(message.content) ? message.content : [];
  const items = content.flatMap((value, index) => contentItem(entry, recordValue(value), `${entryID(entry, entryIndex)}:${index}`));
  if (type === "user" && entry.tool_use_result !== undefined && !items.some((item) => item.type === "custom_tool_call_output")) {
    items.push(toolResultItem(entryID(entry, entryIndex), entry.tool_use_result));
  }
  if (type === "system") {
    const system = systemItem(entry, entryIndex);
    return system ? [system] : [];
  }
  if (items.length > 0) return items;
  if (type === "user" || type === "assistant") return [unknownItem(entry, entryIndex)];
  return Object.keys(entry).length > 0 ? [unknownItem(entry, entryIndex)] : [];
}

function contentItem(
  entry: Record<string, unknown>,
  block: Record<string, unknown>,
  fallbackID: string
): Array<Record<string, unknown>> {
  const entryType = stringValue(entry.type);
  const blockType = stringValue(block.type);
  const id = stringValue(block.id) || stringValue(block.tool_use_id) || fallbackID;
  const agentID = stringValue(entry.parent_agent_id);
  if (blockType === "text") {
    const text = redactSensitiveText(stringValue(block.text));
    if (!text) return [];
    return [entryType === "assistant"
      ? compactObject({ id, type: "agentMessage", text, subagent_id: agentID })
      : { id, type: "userMessage", content: [{ type: "input_text", text }] }];
  }
  if (["thinking", "reasoning"].includes(blockType)) {
    const text = redactSensitiveText(firstNonEmpty(stringValue(block.thinking), stringValue(block.text), historyText(block.content)));
    return text ? [{ id, type: "reasoning", content: [{ type: "text", text }] }] : [];
  }
  if (blockType === "tool_use") return [toolUseItem(id, block)];
  if (["tool_result", "tool_use_result"].includes(blockType)) return [toolResultItem(id, block.content ?? block)];
  return [unknownItem({ ...block, parent_type: entryType }, 0, id)];
}

function toolUseItem(id: string, block: Record<string, unknown>): Record<string, unknown> {
  const name = stringValue(block.name) || "tool";
  const input = recordValue(redactRegisteredSecrets(recordValue(block.input)));
  if (name === "Bash") {
    return {
      id,
      type: "commandExecution",
      command: redactSensitiveText(firstNonEmpty(stringValue(input.command), stringValue(input.cmd))),
      cwd: redactSensitiveText(stringValue(input.cwd)),
      text: "",
      status: "completed"
    };
  }
  if (["Edit", "Write", "NotebookEdit"].includes(name)) {
    return {
      id,
      type: "fileChange",
      path: redactSensitiveText(firstNonEmpty(stringValue(input.file_path), stringValue(input.path), stringValue(input.notebook_path))),
      text: safeHistoryJSON(input),
      status: "completed"
    };
  }
  if (["Agent", "Task"].includes(name)) {
    return {
      id,
      type: "subagent",
      name,
      input,
      status: "running"
    };
  }
  return { id, type: "custom_tool_call", name, input };
}

function toolResultItem(id: string, value: unknown): Record<string, unknown> {
  const record = recordValue(value);
  return {
    id: stringValue(record.tool_use_id) || id,
    type: "custom_tool_call_output",
    output: historyText(record.content ?? value),
    status: record.is_error === true ? "failed" : "completed"
  };
}

function systemItem(entry: Record<string, unknown>, entryIndex: number): Record<string, unknown> | null {
  const subtype = stringValue(entry.subtype);
  const id = entryID(entry, entryIndex);
  if (subtype.startsWith("task_")) {
    return compactObject({
      id,
      type: "subagent",
      name: firstNonEmpty(stringValue(entry.subagent_type), "Qoder subagent"),
      task_id: stringValue(entry.task_id),
      status: firstNonEmpty(stringValue(entry.status), stringValue(recordValue(entry.patch).status), "running"),
      text: redactSensitiveText(firstNonEmpty(stringValue(entry.summary), stringValue(entry.description), stringValue(recordValue(entry.patch).error))),
      usage: redactRegisteredSecrets(recordValue(entry.usage))
    });
  }
  if (subtype === "permission_denied") {
    return compactObject({
      id,
      type: "permission",
      name: stringValue(entry.tool_name),
      status: "denied",
      text: redactSensitiveText(firstNonEmpty(stringValue(entry.message), stringValue(entry.decision_reason))),
      tool_use_id: stringValue(entry.tool_use_id)
    });
  }
  if (["init", "status", "session_state_changed", "session_title_changed"].includes(subtype)) return null;
  return unknownItem(entry, entryIndex);
}

function unknownItem(entry: Record<string, unknown>, entryIndex: number, explicitID = ""): Record<string, unknown> {
  return {
    id: explicitID || entryID(entry, entryIndex),
    type: "qoderNative",
    native_type: stringValue(entry.type) || "unknown",
    native_subtype: stringValue(entry.subtype),
    text: safeHistoryJSON(entry)
  };
}

function qoderHistoryExtensions(messages: SessionMessage[]): Record<string, unknown> {
  const total = { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0 };
  let last: Record<string, number> = {};
  let qodercliVersion = "";
  let protocolVersion = "";
  let requestCredits = 0;
  let requestCreditCount = 0;
  let sessionCredits: number | undefined;
  let lastRequestCredits: number | undefined;
  for (const entry of messages) {
    const raw = recordValue(entry);
    qodercliVersion = stringValue(raw.qodercli_version) || qodercliVersion;
    protocolVersion = stringValue(raw.protocol_version) || protocolVersion;
    const usage = recordValue(recordValue(raw.message).usage);
    const resultUsage = recordValue(raw.usage);
    const assistantCredits = finiteNumber(usage.credits);
    if (assistantCredits !== undefined) {
      requestCredits += assistantCredits;
      requestCreditCount += 1;
      lastRequestCredits = assistantCredits;
    }
    if (stringValue(raw.type) === "result") {
      sessionCredits = finiteNumber(raw.total_credits) ?? sessionCredits;
      lastRequestCredits = finiteNumber(resultUsage.credits) ?? lastRequestCredits;
    }
    if (Object.keys(usage).length === 0) continue;
    last = tokenNumbers(usage);
    total.input_tokens += last.input_tokens ?? 0;
    total.output_tokens += last.output_tokens ?? 0;
    total.cache_read_input_tokens += last.cache_read_input_tokens ?? 0;
    total.total_tokens += (last.input_tokens ?? 0) + (last.output_tokens ?? 0);
  }
  const hasUsage = total.total_tokens > 0 || total.cache_read_input_tokens > 0;
  return compactObject({
    cli_version: qodercliVersion,
    credits: requestCreditCount > 0 || sessionCredits !== undefined || lastRequestCredits !== undefined ? {
      ...(lastRequestCredits === undefined ? {} : {
        last_request: { value: lastRequestCredits, provenance: "result_or_assistant_request_usage" }
      }),
      ...(requestCreditCount === 0 ? {} : {
        observed_requests: {
          count: requestCreditCount,
          value: requestCredits,
          provenance: "assistant.message.usage.credits"
        }
      }),
      ...(sessionCredits === undefined ? {} : {
        session: {
          completeness: "partial",
          provenance: "result.total_credits",
          semantics: "session_cumulative_unverified",
          value: sessionCredits
        }
      }),
      money: { completeness: "unavailable", reason: "qoder_credits_are_not_currency" }
    } : undefined,
    protocol_version: protocolVersion,
    token_usage: hasUsage ? {
      total_token_usage: total,
      last_token_usage: {
        ...last,
        total_tokens: (last.input_tokens ?? 0) + (last.output_tokens ?? 0)
      }
    } : undefined
  });
}

function sessionInfoExtensions(info: SDKSessionInfo | undefined): Record<string, unknown> {
  if (!info) return {};
  return compactObject({
    file_size: finiteNumber(info.fileSize),
    git_branch: info.gitBranch,
    tag: info.tag
  });
}

function latestModel(messages: SessionMessage[]): string {
  let model = "";
  for (const entry of messages) {
    const raw = recordValue(entry);
    model = stringValue(recordValue(raw.message).model) || stringValue(raw.model) || model;
  }
  return model;
}

function firstUserText(messages: SessionMessage[]): string {
  for (const entry of messages) {
    const raw = recordValue(entry);
    if (stringValue(raw.type) !== "user") continue;
    const text = historyText(recordValue(raw.message).content);
    if (text) return text;
  }
  return "";
}

function historyText(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const record = recordValue(item);
      return firstNonEmpty(stringValue(record.text), historyText(record.content));
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") return safeHistoryJSON(value);
  return value === undefined || value === null ? "" : redactSensitiveText(String(value));
}

function safeHistoryJSON(value: unknown): string {
  try {
    return redactSensitiveText(JSON.stringify(redactRegisteredSecrets(value), null, 2));
  } catch {
    return redactSensitiveText(String(value));
  }
}

function entryID(entry: Record<string, unknown>, index: number): string {
  return stringValue(entry.uuid) || `qoder-history-${index + 1}`;
}

function tokenNumbers(value: Record<string, unknown>): Record<string, number> {
  return compactObject({
    input_tokens: finiteNumber(value.input_tokens),
    output_tokens: finiteNumber(value.output_tokens),
    cache_read_input_tokens: finiteNumber(value.cache_read_input_tokens)
  }) as Record<string, number>;
}

function millisecondsToSeconds(value: unknown): number {
  const number = finiteNumber(value);
  return number === undefined ? 0 : Math.floor(number / 1000);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "")?.trim() ?? "";
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}
