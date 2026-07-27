import type { RunnerDatabase } from "../db/database.ts";
import {
  deletePiMemoryItem,
  getPiMemoryItem,
  updatePiMemoryItem
} from "../db/repositories/pi.ts";

export type PiMemoryBatchAction = "disable" | "enable" | "forget" | "pin";
export type PiMemoryBatchInput = { action: PiMemoryBatchAction; ids: string[] };

export function applyPiMemoryBatchAction(db: RunnerDatabase, input: PiMemoryBatchInput) {
  const ids = uniqueIDs(input.ids);
  if (input.action === "forget") return forgetBatch(db, ids);
  const updated = ids.flatMap((id) => updateBatchItem(db, id, input.action));
  return { action: input.action, skipped: ids.filter((id) => !updated.includes(id)), updated };
}

function updateBatchItem(db: RunnerDatabase, id: string, action: Exclude<PiMemoryBatchAction, "forget">): string[] {
  try {
    if (!getPiMemoryItem(db, id)) return [];
    if (action === "pin") updatePiMemoryItem(db, id, { pinned: 1 });
    else updatePiMemoryItem(db, id, { disabled: action === "disable" ? 1 : 0 });
    return [id];
  } catch {
    return [];
  }
}

function forgetBatch(db: RunnerDatabase, ids: string[]) {
  const forgotten = ids.filter((id) => deletePiMemoryItem(db, id));
  return { action: "forget" as const, forgotten, skipped: ids.filter((id) => !forgotten.includes(id)) };
}

function uniqueIDs(ids: string[]): string[] {
  return [...new Set(ids.map(clean).filter(Boolean))];
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
