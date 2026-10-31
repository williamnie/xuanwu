import { redactSensitiveText } from "../../util/redact.ts";
import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { normalizedRunEvent } from "../runEvents.ts";
import type { ProviderEvent, SessionRef } from "../types.ts";
import { arrayValue, cleanString, objectValue } from "../../util/values.ts";
import { PROVIDER, type ClaudeSdkStreamState, RAW_LIMIT } from "./sdkStream.ts";

export function progressRunEvent(method: string, session?: SessionRef) {
  return normalizedRunEvent({ kind: "progress", method, outcome: "running", provider: PROVIDER, session });
}

export function sessionRef(state: ClaudeSdkStreamState): SessionRef | undefined {
  if (state.sessionId === "") return undefined;
  return {
    provider: PROVIDER,
    sessionId: state.sessionId,
    ...(state.turnId === "" ? {} : { turnId: state.turnId })
  };
}

export function event(input: Omit<ProviderEvent, "provider"> & { method: string }): ProviderEvent {
  const { method: _method, ...rest } = input;
  return { provider: PROVIDER, ...rest };
}

export function resultError(record: Record<string, unknown>): string {
  const errors = arrayValue(record.errors).map(safeText).filter(Boolean);
  return errors.join("; ") || safeText(record.result) || `Claude SDK result failed: ${cleanString(record.subtype) || "unknown"}`;
}

export function toolSummary(block: Record<string, unknown>): string {
  const name = cleanString(block.name) || "tool";
  const input = rawSummary(objectValue(block.input));
  return input === "{}" ? name : `${name} ${input}`;
}

export function contentText(value: unknown): string {
  if (typeof value === "string") return safeText(value);
  return arrayValue(value).map((item) => {
    const record = objectValue(item);
    return safeText(record.text || record.content);
  }).filter(Boolean).join("\n");
}

export function rawSummary(value: unknown): string {
  let text = "";
  try {
    text = JSON.stringify(redactRegisteredSecrets(value));
  } catch {
    text = String(value);
  }
  const redacted = redactSensitiveText(text);
  return redacted.length <= RAW_LIMIT ? redacted : `${redacted.slice(0, RAW_LIMIT)}…`;
}

export function safeText(value: unknown): string {
  return redactSensitiveText(typeof value === "string" ? value : "");
}

export function tokenValue(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function sumKnown(...values: Array<number | null>): number | null {
  return values.every((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

export function usdMicros(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 1_000_000);
}
