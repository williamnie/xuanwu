import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type StructuredAssistantOutputSource = "none" | "text" | "thinking_compat";

export type StructuredAssistantOutput<T> = {
  raw: string;
  source: StructuredAssistantOutputSource;
  value: T | null;
};

export type StructuredOutputSession = Pick<AgentSession, "getLastAssistantText" | "state">;

/**
 * Structured internal profiles prefer the public assistant text. Some OpenAI-
 * compatible model adapters put the requested final JSON in a thinking block
 * instead. Only accept that compatibility path when no public text exists and
 * the caller's strict parser validates the complete payload.
 */
export function parseStructuredAssistantOutput<T>(
  session: StructuredOutputSession,
  parse: (raw: string) => T | null
): StructuredAssistantOutput<T> {
  const text = cleanString(session.getLastAssistantText());
  if (text !== "") return parsedCandidate(text, "text", parse);

  const thinkingCandidates = lastCompletedAssistantThinking(session);
  for (const thinking of thinkingCandidates) {
    const parsed = parsedCandidate(thinking, "thinking_compat", parse);
    if (parsed.value !== null) return parsed;
  }
  const raw = thinkingCandidates[0] ?? "";
  return { raw, source: raw === "" ? "none" : "thinking_compat", value: null };
}

export function structuredAssistantProviderError(session: StructuredOutputSession): string {
  const sessionError = cleanString(session.state.errorMessage);
  if (sessionError !== "") return sessionError;
  const message = [...session.state.messages].reverse().find((item) => item.role === "assistant");
  return message?.role === "assistant" ? cleanString(message.errorMessage) : "";
}

function parsedCandidate<T>(
  raw: string,
  source: Exclude<StructuredAssistantOutputSource, "none">,
  parse: (raw: string) => T | null
): StructuredAssistantOutput<T> {
  try {
    return { raw, source, value: parse(raw) };
  } catch {
    return { raw, source, value: null };
  }
}

function lastCompletedAssistantThinking(session: StructuredOutputSession): string[] {
  const message = [...session.state.messages].reverse().find((item) => item.role === "assistant");
  if (!message || message.role !== "assistant") return [];
  if (["aborted", "deferred", "error", "length", "pending", "toolUse"].includes(message.stopReason)) return [];
  return message.content
    .filter((item) => item.type === "thinking")
    .map((item) => item.type === "thinking" ? cleanString(item.thinking) : "")
    .filter(Boolean);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
