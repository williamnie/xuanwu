import { providerSessionDetail, providerSessionSummary, type ProviderSessionDetailView, type ProviderSessionView } from "../core/sessionView.ts";
import type { ThreadSummary } from "./threadLifecycle.ts";

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
    name: stringValue(thread.name),
    preview: stringValue(thread.preview),
    cwd: stringValue(thread.cwd),
    status: thread.status,
    isRunning: thread.isRunning === true,
    createdAt: numberValue(thread.createdAt),
    updatedAt: numberValue(thread.updatedAt),
    model: stringValue(thread.model),
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
      id: stringValue(record.id) || `turn-${index + 1}`,
      items: Array.isArray(record.items) ? record.items.filter(isRecord) : []
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function objectValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
