import { getSessionInfo as sdkGetSessionInfo, getSessionMessages as sdkGetSessionMessages, listSessions as sdkListSessions, type GetSessionInfoOptions, type GetSessionMessagesOptions, type ListSessionsOptions, type SDKSessionInfo, type SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { redactSensitiveText } from "../../util/redact.ts";
import { providerSessionDetail, providerSessionSummary, type ProviderSessionDetailView, type ProviderSessionTurn, type ProviderSessionView } from "../core/sessionView.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { transcriptItems } from "./sessionHistoryItems.ts";
import { millisecondsToSeconds, sessionInfoExtensions, firstUserText, latestModel, qoderHistoryExtensions } from "./sessionHistoryMetadata.ts";

export const PROVIDER = "qoder" as const;

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
    const observed = cleanString(objectValue(message).session_id);
    if (observed && observed !== expected) {
      throw new Error(`Qoder session ${expected} transcript contains mismatched history ${observed}`);
    }
  }
}

export function qoderTranscriptTurns(messages: SessionMessage[]): ProviderSessionTurn[] {
  const turns: ProviderSessionTurn[] = [];
  messages.forEach((entry, entryIndex) => {
    const raw = objectValue(entry);
    const items = transcriptItems(raw, entryIndex);
    if (items.length === 0) return;
    const startsUserTurn = cleanString(raw.type) === "user" && items.some((item) => item.type === "userMessage");
    if (startsUserTurn || turns.length === 0) {
      turns.push({ id: cleanString(raw.uuid) || `turn-${turns.length + 1}`, items: [] });
    }
    turns.at(-1)!.items.push(...items);
  });
  return turns;
}
