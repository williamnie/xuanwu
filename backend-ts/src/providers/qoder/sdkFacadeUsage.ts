import type { ModelInfo, Query, SDKMessage, SDKResultMessage } from "@qoder-ai/qoder-agent-sdk";
import { redactSensitiveText } from "../../util/redact.ts";
import { classifyQoderFailure, type QoderFailureDetails } from "./events.ts";
import { cleanString, objectValue } from "../../util/values.ts";
import { QoderUsageProjection, QoderExecutionError } from "./sdkFacadeModel.ts";

export async function qoderUsageProjection(
  result: SDKResultMessage,
  assistantMessages: SDKMessage[],
  query: Query | undefined
): Promise<QoderUsageProjection> {
  const resultUsage = result.usage;
  const requestCredits = finiteNumber(resultUsage.credits);
  const totalCredits = finiteNumber(result.total_credits);
  const usagePromise = query && typeof query.getUsageInfo === "function" ? query.getUsageInfo() : Promise.resolve(null);
  const usageInfo = await usagePromise.catch(() => null);
  const sessionCredits = finiteNumber(usageInfo?.session?.total_credits);
  return {
    assistant_requests: assistantMessages.flatMap((message) => {
      if (message.type !== "assistant") return [];
      const usage = message.message.usage;
      if (!usage) return [];
      return [compactObject({
        billable: usage.billable,
        credits: finiteNumber(usage.credits),
        input_tokens: finiteNumber(usage.input_tokens),
        model: cleanString(message.message.model),
        original_credits: finiteNumber(usage.original_credits),
        output_tokens: finiteNumber(usage.output_tokens),
        provenance: "assistant.message.usage",
        request_id: cleanString(message.request_id) || cleanString(resultUsage.request_id)
      })];
    }),
    credits: {
      ...(requestCredits === undefined ? {} : {
        request: compactObject({
          billable: resultUsage.billable,
          original_value: finiteNumber(resultUsage.original_credits),
          provenance: "result.usage",
          value: requestCredits
        }) as QoderUsageProjection["credits"]["request"]
      }),
      ...(sessionCredits === undefined && totalCredits === undefined ? {} : {
        session: {
          completeness: "partial",
          provenance: sessionCredits === undefined ? "result.total_credits" : "query.getUsageInfo.session",
          semantics: "session_cumulative_unverified",
          value: sessionCredits ?? totalCredits!
        }
      })
    },
    model_usage: Object.fromEntries(Object.entries(result.modelUsage).map(([model, usage]) => [model, compactObject({
      cache_creation_input_tokens: finiteNumber(usage.cacheCreationInputTokens),
      cache_read_input_tokens: finiteNumber(usage.cacheReadInputTokens),
      credits: finiteNumber(usage.credits),
      input_tokens: finiteNumber(usage.inputTokens),
      output_tokens: finiteNumber(usage.outputTokens),
      web_search_requests: finiteNumber(usage.webSearchRequests)
    })])),
    money: { completeness: "unavailable", reason: "qoder_credits_are_not_currency" },
    result: {
      ...(finiteNumber(resultUsage.cache_read_input_tokens) === undefined ? {} : {
        cached_input_tokens: finiteNumber(resultUsage.cache_read_input_tokens)
      }),
      duration_ms: result.duration_ms,
      input_tokens: resultUsage.input_tokens,
      output_tokens: resultUsage.output_tokens,
      provenance: "result.usage",
      total_tokens: resultUsage.input_tokens + resultUsage.output_tokens
    }
  };
}

export function validModelInfo(value: ModelInfo): boolean {
  return cleanString(value?.value) !== "" && cleanString(value?.displayName) !== "" && value?.isEnabled !== false;
}

export function controlPrompt(signal: AbortSignal): AsyncIterable<never> {
  return {
    async *[Symbol.asyncIterator]() {
      // 不发送用户消息；控制请求完成前保持输入流打开，避免 CLI 因 EOF 提前关闭连接。
      if (signal.aborted) return;
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    }
  };
}

export function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== ""));
}

export function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function qoderException(error: unknown, sessionId: string): QoderExecutionError {
  const raw = objectValue(error);
  const message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  const code = typeof raw.code === "string" || typeof raw.code === "number" ? raw.code : undefined;
  const exitCode = typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined;
  const signal = typeof raw.signal === "string" || raw.signal === null ? raw.signal : undefined;
  const classified = exitCode !== undefined || signal !== undefined
    ? { category: "process" as const, retryable: false }
    : classifyQoderFailure(message, typeof code === "string" ? code : "", typeof code === "number" ? code : undefined);
  return qoderError(classified.category, message || "Qoder SDK failed", {
    code,
    errorClass: error instanceof Error ? error.name : undefined,
    exitCode,
    retryable: classified.retryable,
    sessionId,
    signal
  });
}

export function qoderError(
  category: QoderFailureDetails["category"],
  message: string,
  details: Partial<Omit<QoderFailureDetails, "category" | "message">> = {}
): QoderExecutionError {
  return new QoderExecutionError({ category, message, retryable: false, ...details });
}

export function required(value: unknown, label: string): string {
  const text = cleanString(value);
  if (!text) throw qoderError("configuration", `${label} is required`);
  return text;
}
