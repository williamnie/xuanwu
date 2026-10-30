import { redactRegisteredSecrets } from "../../security/redactionRegistry.ts";
import { normalizedRunEvent, providerRunCost, unknownRunEvent } from "../runEvents.ts";
import type { ProviderEvent, SessionRef } from "../types.ts";
import { arrayValue, cleanString, numberValue, objectValue } from "../../util/values.ts";
import { type ClaudeSdkStreamState, PROVIDER } from "./sdkStream.ts";
import { sessionRef, safeText, event, progressRunEvent, toolSummary, contentText, resultError, tokenValue, sumKnown, usdMicros } from "./sdkStreamValues.ts";

export function assistantEvents(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent[] {
  const message = objectValue(record.message);
  const partialTextSeen = state.partialTextSeen;
  state.partialTextSeen = false;
  return arrayValue(message.content).flatMap((item) => {
    const block = objectValue(item);
    const session = sessionRef(state);
    if (block.type === "text") {
      const text = safeText(block.text);
      // includePartialMessages emits the same assistant text once as deltas and
      // again as the completed message. Keep the stream incremental without
      // buffering or rendering the completed copy twice.
      return text === "" || partialTextSeen ? [] : [event({
        method,
        raw,
        runEvent: progressRunEvent(method, session),
        session,
        text,
        type: "text"
      })];
    }
    if (block.type === "tool_use") {
      return [event({
        command: toolSummary(block),
        method,
        payload: redactRegisteredSecrets(block.input),
        raw,
        runEvent: progressRunEvent(method, session),
        session,
        status: "started",
        type: "tool"
      })];
    }
    return [];
  });
}

export function toolResultEvents(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent[] {
  const message = objectValue(record.message);
  return arrayValue(message.content).flatMap((item) => {
    const block = objectValue(item);
    if (block.type !== "tool_result") return [];
    const session = sessionRef(state);
    return [event({
      method,
      payload: redactRegisteredSecrets(block.content),
      raw,
      runEvent: progressRunEvent(method, session),
      session,
      status: block.is_error === true ? "failed" : "completed",
      text: contentText(block.content),
      type: "tool_result"
    })];
  });
}

export function partialEvents(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent[] {
  const delta = objectValue(objectValue(record.event).delta);
  const text = safeText(delta.text);
  if (text === "") return [];
  state.partialTextSeen = true;
  const session = sessionRef(state);
  return [event({
    method,
    raw,
    runEvent: progressRunEvent(method, session),
    session,
    status: "streaming",
    text,
    type: "text_delta"
  })];
}

export function resultEvent(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent {
  state.terminal = true;
  const failed = record.is_error === true || cleanString(record.subtype) !== "success";
  state.completed = !failed;
  const session = sessionRef(state);
  const error = failed ? resultError(record) : "";
  const status = cleanString(record.terminal_reason) || cleanString(record.stop_reason) || (failed ? "failed" : "completed");
  const cost = resultCost(record, method, session);
  return event({
    ...(failed ? { error } : { text: safeText(record.result) }),
    method,
    raw,
    runEvent: normalizedRunEvent({
      ...(cost ? { cost } : {}),
      kind: failed ? "error" : "completed",
      metadata: {
        duration_api_ms: numberValue(record.duration_api_ms),
        duration_ms: numberValue(record.duration_ms),
        num_turns: numberValue(record.num_turns),
        result_subtype: cleanString(record.subtype),
        terminal_reason: cleanString(record.terminal_reason)
      },
      method,
      outcome: failed ? "failed" : "succeeded",
      provider: PROVIDER,
      session
    }),
    session,
    status,
    type: failed ? "error" : "done"
  });
}

export function resultCost(record: Record<string, unknown>, method: string, session: SessionRef | undefined) {
  const usage = objectValue(record.usage);
  const uncached = tokenValue(usage.input_tokens);
  const cached = tokenValue(usage.cache_read_input_tokens);
  const cacheCreation = tokenValue(usage.cache_creation_input_tokens);
  const output = tokenValue(usage.output_tokens);
  const input = sumKnown(uncached, cached, cacheCreation);
  return providerRunCost({
    amountMicros: usdMicros(record.total_cost_usd),
    currency: "USD",
    sourceRef: ["provider-event", PROVIDER, method, session?.sessionId || "no-session", session?.turnId || "no-turn"].join(":"),
    usage: {
      cached_input_tokens: cached,
      input_tokens: input,
      output_tokens: output,
      reasoning_output_tokens: null,
      total_tokens: input === null || output === null ? null : input + output
    }
  });
}

export function unknownEvent(
  record: Record<string, unknown>,
  state: ClaudeSdkStreamState,
  raw: ProviderEvent["raw"],
  method: string
): ProviderEvent {
  const session = sessionRef(state);
  return event({
    method,
    payload: raw?.payload,
    raw,
    runEvent: unknownRunEvent(PROVIDER, method, session),
    session,
    status: "diagnostic",
    text: `Unsupported Claude SDK event preserved: ${method}`,
    type: "unknown"
  });
}
