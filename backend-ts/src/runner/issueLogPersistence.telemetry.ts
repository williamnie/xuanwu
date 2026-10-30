import type { ProviderEvent } from "../providers/types.ts";
import { codexDynamicExecObservation } from "../providers/codex/dynamicExec.ts";
import { nonNegativeInteger, objectValue } from "../util/values.ts";
import { TOOL_COMMAND_BYTES, TOOL_OUTPUT_BYTES, TOOL_CWD_BYTES, TOOL_OBSERVATION_SCHEMA_VERSION, RUN_COST_OBSERVATION_SCHEMA_VERSION } from "./issueLogPersistence.model.ts";
import type { IssueLogMode } from "./issueLogPersistence.model.ts";
import { rawObject, stringValue, compactObject, boundedUtf8 } from "./issueLogPersistence.values.ts";

export function terminalCarrier(method: string): string {
  if (method === "item/agentMessage/delta") return "item/completed agentMessage";
  if (method === "item/commandExecution/outputDelta") return "item/completed commandExecution";
  if (method === "item/fileChange/outputDelta" || method === "turn/diff/updated") return "item/completed fileChange";
  if (method === "thread/tokenUsage/updated") return "turn/completed normalized cost";
  return "latest bounded sample plus terminal event";
}

export function compactLifecycleEvent(
  event: ProviderEvent,
  preserveAgentFinal: boolean,
  mode: IssueLogMode
): ProviderEvent {
  const method = event.raw?.method ?? "";
  if (method !== "item/started" && method !== "item/completed") return event;
  const raw = rawObject(event.raw?.payload);
  const item = objectValue(raw.item);
  const itemType = stringValue(item.type);
  const snapshot = compactObject({
    item_id: boundedUtf8(stringValue(item.id), 512),
    item_type: boundedUtf8(itemType, 128),
    phase: boundedUtf8(stringValue(item.phase), 128),
    process_id: boundedUtf8(stringValue(item.processId), 512),
    representation: "necessary_snapshot",
    raw_payload_omitted: true
  });
  if (method === "item/started" && ["agentMessage", "commandExecution", "fileChange", "reasoning"].includes(itemType)) {
    return { ...event, payload: snapshot, raw: { method } };
  }
  if (method === "item/completed" && itemType === "reasoning") {
    return { ...event, payload: snapshot, raw: { method } };
  }
  if (method === "item/completed" && itemType === "agentMessage") {
    return {
      ...event,
      payload: snapshot,
      raw: { method },
      ...(preserveAgentFinal ? { text: event.text || stringValue(item.text) } : { text: undefined })
    };
  }
  if (mode === "normal" && method === "item/completed") {
    const observation = terminalToolObservation(event, item);
    if (observation) return observation;
  }
  return event;
}

export function terminalToolObservation(event: ProviderEvent, item: Record<string, unknown>): ProviderEvent | undefined {
  const dynamic = codexDynamicExecObservation(item);
  if (stringValue(item.type) !== "commandExecution" && !dynamic) return undefined;
  const command = boundedUtf8(dynamic?.command || event.command || stringValue(item.command), TOOL_COMMAND_BYTES);
  if (command === "") return undefined;
  const status = dynamic?.status || event.status || stringValue(item.status) || "completed";
  const exitCode = dynamic?.exitCode ?? terminalExitCode(item.exitCode, status);
  const output = boundedUtf8(dynamic?.aggregatedOutput || commandOutput(item) || event.text || "", TOOL_OUTPUT_BYTES);
  const cwd = boundedUtf8(dynamic?.cwd || stringValue(item.cwd) || ".", TOOL_CWD_BYTES);
  const durationMs = dynamic?.durationMs ?? nonNegativeInteger(item.durationMs);
  return {
    ...event,
    command,
    payload: compactObject({
      cwd,
      duration_ms: durationMs,
      exit_code: exitCode,
      item_id: boundedUtf8(dynamic?.id || stringValue(item.id), 512),
      item_type: "commandExecution",
      output_excerpt: output,
      raw_payload_omitted: true,
      representation: "terminal_tool_observation",
      schema_version: TOOL_OBSERVATION_SCHEMA_VERSION
    }),
    raw: { method: event.raw?.method },
    status,
    text: output
  };
}

export function compactRunCostEvent(event: ProviderEvent): ProviderEvent {
  return {
    ...event,
    payload: {
      raw_payload_omitted: true,
      representation: "final_run_cost",
      schema_version: RUN_COST_OBSERVATION_SCHEMA_VERSION
    },
    raw: { method: event.raw?.method },
    text: undefined
  };
}

export function isRunCostTelemetry(event: ProviderEvent): boolean {
  return event.raw?.method === "thread/tokenUsage/updated" && Boolean(event.runEvent?.cost);
}

export function terminalExitCode(value: unknown, status: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  return ["completed", "done", "success", "succeeded"].includes(status.trim().toLowerCase()) ? 0 : 1;
}

export function commandOutput(item: Record<string, unknown>): string {
  const aggregate = stringValue(item.aggregatedOutput);
  if (aggregate !== "") return aggregate;
  return [stringValue(item.stdout), stringValue(item.stderr)].filter(Boolean).join("\n");
}

export function lifecycleItemType(event: ProviderEvent): string {
  const method = event.raw?.method ?? "";
  if (method !== "item/started" && method !== "item/completed") return "";
  return stringValue(objectValue(rawObject(event.raw?.payload).item).type);
}

export function lifecycleSnapshotType(event: ProviderEvent): string {
  const payload = objectValue(event.payload);
  const itemType = stringValue(payload.item_type);
  if (event.raw?.method === "item/completed" && itemType === "agentMessage") return "";
  return payload.representation === "necessary_snapshot" && payload.raw_payload_omitted === true
    ? itemType || "unknown" : "";
}
