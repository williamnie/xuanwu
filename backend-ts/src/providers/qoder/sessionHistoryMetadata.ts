import { type SDKSessionInfo, type SessionMessage } from "@qoder-ai/qoder-agent-sdk";
import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { cleanString, objectValue } from "../../util/values.ts";

export function qoderHistoryExtensions(messages: SessionMessage[]): Record<string, unknown> {
  const total = { input_tokens: 0, output_tokens: 0, total_tokens: 0, cache_read_input_tokens: 0 };
  let last: Record<string, number> = {};
  let qodercliVersion = "";
  let protocolVersion = "";
  let requestCredits = 0;
  let requestCreditCount = 0;
  let sessionCredits: number | undefined;
  let lastRequestCredits: number | undefined;
  for (const entry of messages) {
    const raw = objectValue(entry);
    qodercliVersion = cleanString(raw.qodercli_version) || qodercliVersion;
    protocolVersion = cleanString(raw.protocol_version) || protocolVersion;
    const usage = objectValue(objectValue(raw.message).usage);
    const resultUsage = objectValue(raw.usage);
    const assistantCredits = finiteNumber(usage.credits);
    if (assistantCredits !== undefined) {
      requestCredits += assistantCredits;
      requestCreditCount += 1;
      lastRequestCredits = assistantCredits;
    }
    if (cleanString(raw.type) === "result") {
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

export function sessionInfoExtensions(info: SDKSessionInfo | undefined): Record<string, unknown> {
  if (!info) return {};
  return compactObject({
    file_size: finiteNumber(info.fileSize),
    git_branch: info.gitBranch,
    tag: info.tag
  });
}

export function latestModel(messages: SessionMessage[]): string {
  let model = "";
  for (const entry of messages) {
    const raw = objectValue(entry);
    model = cleanString(objectValue(raw.message).model) || cleanString(raw.model) || model;
  }
  return model;
}

export function firstUserText(messages: SessionMessage[]): string {
  for (const entry of messages) {
    const raw = objectValue(entry);
    if (cleanString(raw.type) !== "user") continue;
    const text = historyText(objectValue(raw.message).content);
    if (text) return text;
  }
  return "";
}

export function historyText(value: unknown): string {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) {
    return value.map((item) => {
      const record = objectValue(item);
      return firstNonEmpty(cleanString(record.text), historyText(record.content));
    }).filter(Boolean).join("\n");
  }
  if (value && typeof value === "object") return safeHistoryJSON(value);
  return value === undefined || value === null ? "" : redactSensitiveText(String(value));
}

export function safeHistoryJSON(value: unknown): string {
  try {
    return redactSensitiveText(JSON.stringify(redactRegisteredSecrets(value), null, 2));
  } catch {
    return redactSensitiveText(String(value));
  }
}

export function entryID(entry: Record<string, unknown>, index: number): string {
  return cleanString(entry.uuid) || `qoder-history-${index + 1}`;
}

export function tokenNumbers(value: Record<string, unknown>): Record<string, number> {
  return compactObject({
    input_tokens: finiteNumber(value.input_tokens),
    output_tokens: finiteNumber(value.output_tokens),
    cache_read_input_tokens: finiteNumber(value.cache_read_input_tokens)
  }) as Record<string, number>;
}

export function millisecondsToSeconds(value: unknown): number {
  const number = finiteNumber(value);
  return number === undefined ? 0 : Math.floor(number / 1000);
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function firstNonEmpty(...values: string[]): string {
  return values.find((value) => value.trim() !== "")?.trim() ?? "";
}

export function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== "")) as T;
}
