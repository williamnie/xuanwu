import { providerSessionDetail, providerSessionSummary, type ProviderSessionDetailView, type ProviderSessionView } from "../core/sessionView.ts";
import type { ThreadSummary } from "./threadLifecycle.ts";
import { cleanString, isRecord, numberValue, objectValue } from "../../util/values.ts";

const PROVIDER = "codex" as const;

export function publicCodexSessionSummary(thread: ThreadSummary): ProviderSessionView {
  return providerSessionSummary(PROVIDER, candidate(thread));
}

export function publicCodexSessionDetail(thread: ThreadSummary): ProviderSessionDetailView {
  return providerSessionDetail(PROVIDER, candidate(thread));
}

function candidate(thread: ThreadSummary) {
  return {
    sessionRef: thread.provider_session_id,
    name: cleanString(thread.name),
    preview: cleanString(thread.preview),
    cwd: cleanString(thread.cwd),
    status: thread.status,
    isRunning: thread.isRunning === true,
    createdAt: numberValue(thread.createdAt),
    updatedAt: numberValue(thread.updatedAt),
    model: cleanString(thread.model),
    turns: arrayValue(thread.turns),
    extensions: thread
  };
}

function arrayValue(value: unknown): Array<{ id: string; items: Array<Record<string, unknown>> }> {
  if (!Array.isArray(value)) return [];
  return value.map((turn, index) => {
    const record = objectValue(turn);
    return {
      ...record,
      id: cleanString(record.id) || `turn-${index + 1}`,
      items: Array.isArray(record.items) ? record.items.filter(isRecord) : []
    };
  });
}
