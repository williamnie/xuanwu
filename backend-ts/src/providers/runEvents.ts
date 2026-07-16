import { emptyRunCost, type CostUsage, type RunCost } from "../domain/run/contracts.ts";
import {
  NORMALIZED_RUN_EVENT_CONTRACT,
  type ExecutorProviderId,
  type NormalizedRunEvent,
  type NormalizedRunEventKind,
  type NormalizedRunEventOutcome,
  type ProviderMetadataValue,
  type SessionRef
} from "./types.ts";

type RunEventInput = {
  cost?: RunCost;
  kind: NormalizedRunEventKind;
  metadata?: Record<string, ProviderMetadataValue | null | undefined>;
  method: string;
  outcome: NormalizedRunEventOutcome;
  provider: ExecutorProviderId;
  retryable?: boolean;
  session?: SessionRef;
  terminal?: boolean;
};

type ProviderCostInput = {
  amountMicros?: number | null;
  currency?: string;
  sourceRef: string;
  usage?: Partial<Record<keyof Omit<CostUsage, "completeness">, unknown>>;
};

export function normalizedRunEvent(input: RunEventInput): NormalizedRunEvent {
  const method = clean(input.method) || "unknown";
  const metadata = compactMetadata({
    ...input.metadata,
    provider_session_id: input.session?.sessionId,
    provider_turn_id: input.session?.turnId
  });
  return {
    contract: NORMALIZED_RUN_EVENT_CONTRACT,
    ...(input.cost ? { cost: input.cost } : {}),
    kind: input.kind,
    metadata,
    outcome: input.outcome,
    provider: input.provider,
    ...(input.retryable === undefined ? {} : { retryable: input.retryable }),
    source: { method, ref: providerEventSourceRef(input.provider, method, input.session) },
    terminal: input.terminal ?? terminalOutcome(input.outcome)
  };
}

export function unknownRunEvent(
  provider: ExecutorProviderId,
  method: string,
  session?: SessionRef
): NormalizedRunEvent {
  return {
    ...normalizedRunEvent({ kind: "unknown", method, outcome: "unknown", provider, session, terminal: false }),
    unknown: { policy: "preserve", reason: "unsupported_provider_event" }
  };
}

export function providerRunCost(input: ProviderCostInput): RunCost | undefined {
  const usage = normalizedUsage(input.usage);
  const amount = nonNegativeSafeInteger(input.amountMicros);
  const currency = amount === null ? "" : clean(input.currency).toUpperCase();
  const moneyKnown = amount !== null && currency !== "";
  const sourceRef = clean(input.sourceRef);
  if ((usage.completeness === "unavailable" && !moneyKnown) || sourceRef === "") return undefined;
  return {
    money: moneyKnown
      ? { amount_micros: amount, basis: "provider_reported", currency }
      : emptyRunCost().money,
    pricing_refs: [],
    source_refs: [sourceRef],
    usage
  };
}

export function providerEventSourceRef(provider: ExecutorProviderId, method: string, session?: SessionRef): string {
  return [
    "provider-event",
    provider,
    clean(method) || "unknown",
    clean(session?.sessionId) || "no-session",
    clean(session?.turnId) || "no-turn"
  ].join(":");
}

export function validateNormalizedRunEvent(event: NormalizedRunEvent): string[] {
  const errors: string[] = [];
  if (event.contract !== NORMALIZED_RUN_EVENT_CONTRACT) errors.push("contract version is invalid");
  if (clean(event.source.method) === "" || clean(event.source.ref) === "") errors.push("source is required");
  if (event.kind === "unknown" && event.unknown?.policy !== "preserve") errors.push("unknown events must be preserved");
  if (event.kind !== "unknown" && event.unknown) errors.push("known events cannot carry unknown policy");
  if (event.terminal !== terminalOutcome(event.outcome)) errors.push("terminal flag does not match outcome");
  if (event.kind === "completed" && event.outcome !== "succeeded") errors.push("completed event must map to succeeded");
  if (event.kind === "error" && !["failed", "cancelled", "interrupted"].includes(event.outcome)) {
    errors.push("error event must map to a terminal failure outcome");
  }
  return errors;
}

function normalizedUsage(
  input: Partial<Record<keyof Omit<CostUsage, "completeness">, unknown>> | undefined
): CostUsage {
  const usage = {
    cached_input_tokens: tokenCount(input?.cached_input_tokens),
    input_tokens: tokenCount(input?.input_tokens),
    output_tokens: tokenCount(input?.output_tokens),
    reasoning_output_tokens: tokenCount(input?.reasoning_output_tokens),
    total_tokens: tokenCount(input?.total_tokens)
  };
  if (usage.cached_input_tokens !== null && usage.input_tokens !== null && usage.cached_input_tokens > usage.input_tokens) {
    usage.cached_input_tokens = null;
  }
  if (usage.reasoning_output_tokens !== null && usage.output_tokens !== null && usage.reasoning_output_tokens > usage.output_tokens) {
    usage.reasoning_output_tokens = null;
  }
  if (usage.total_tokens !== null && usage.input_tokens !== null && usage.output_tokens !== null &&
      usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
    usage.total_tokens = null;
  }
  const values = Object.values(usage);
  const completeness = values.every((value) => value === null)
    ? "unavailable"
    : values.every((value) => value !== null) ? "complete" : "partial";
  return { ...usage, completeness };
}

function compactMetadata(
  input: Record<string, ProviderMetadataValue | null | undefined>
): Record<string, ProviderMetadataValue> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => {
    if (value === undefined || value === null) return false;
    return typeof value !== "string" || value.trim() !== "";
  })) as Record<string, ProviderMetadataValue>;
}

function terminalOutcome(outcome: NormalizedRunEventOutcome): boolean {
  return ["succeeded", "failed", "cancelled", "interrupted"].includes(outcome);
}

function tokenCount(value: unknown): number | null {
  return nonNegativeSafeInteger(value);
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
