import type { ProviderRunResult, SessionRef } from "../types.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import { type QoderQueryResult, type QoderSdkFacade } from "./sdkFacade.ts";
import { type QoderRuntimeProbe } from "./runtime.ts";
import { type QoderSessionFunctions } from "./sessionHistory.ts";
import { cleanString } from "../../util/values.ts";

export type QoderExecutorProviderOptions = {
  approvalTimeoutMs?: number;
  facade?: QoderSdkFacade;
  invocationIdFactory?: () => string;
  readiness?: QoderRuntimeProbe;
  sessionIdFactory?: () => string;
  sessionFunctions?: Partial<QoderSessionFunctions>;
};

export type ActiveInvocation = {
  aliases: Set<string>;
  invocationRef: string;
  interrupted: boolean;
  messageRef: string;
  sessionObserved: boolean;
  sessionRef: string;
  terminalProjected: boolean;
};

export const QODER_STATIC_MODEL_SUGGESTIONS = ["auto", "ultimate", "performance", "efficient", "lite"] as const;

export function qoderModelView(model: import("@qoder-ai/qoder-agent-sdk").ModelInfo): Record<string, unknown> {
  const id = cleanString(model.value);
  const efforts = Array.isArray(model.efforts) ? model.efforts.map(cleanString).filter(Boolean) : [];
  return {
    displayName: cleanString(model.displayName) || id,
    id,
    model: id,
    isDefault: model.isDefault === true,
    source: "qoder_account_live",
    verified: true,
    supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
    ...(cleanString(model.defaultEffort) ? { defaultReasoningEffort: cleanString(model.defaultEffort) } : {}),
    ...(model.priceFactor === undefined ? {} : { creditsMultiplier: model.priceFactor })
  };
}

export function redactModelError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactSensitiveText(message).slice(0, 240);
}

export function qoderRunResult(outcome: QoderQueryResult): ProviderRunResult {
  const sessionId = required(outcome.sessionId, "Qoder result session id");
  const messageRef = required(outcome.messageRef, "Qoder result message ref");
  return {
    runId: required(outcome.invocationRef, "Qoder invocation ref"),
    session: { provider: "qoder", sessionId, turnId: messageRef }
  };
}

export function requiredSession(result: ProviderRunResult): SessionRef {
  if (!result.session) throw new Error("Qoder execution completed without a session ref");
  return result.session;
}

export function required(value: unknown, label: string): string {
  const text = cleanString(value);
  if (!text) throw new Error(`${label} is required`);
  return text;
}

export function numericCursor(value: string | undefined): number {
  const cursor = Number(value);
  return Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
}

export function normalizeLimit(value: number | undefined): number {
  if (!Number.isSafeInteger(value) || (value ?? 0) <= 0) return 50;
  return Math.min(value!, 100);
}
