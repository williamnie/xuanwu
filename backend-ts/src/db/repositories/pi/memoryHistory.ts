import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../database.ts";
import { parseMemoryExperience } from "../../../pi/memoryExperience.ts";
import type { PiMemoryItem } from "./memoryItems.ts";

export type PiMemoryCorrection = { expected_revision: number; disposition: "narrow" | "disable"; reason: string };
export type PiMemoryWriteOptions = {
  reenable?: boolean;
  expectedRevision?: number;
  correction?: PiMemoryCorrection;
};
export type PiMemoryHistoryEntry = {
  memory_id: string; revision: number; operation: string; snapshot: Partial<PiMemoryItem>;
  correction: Partial<PiMemoryCorrection>; recorded_at: string;
};

export class PiMemoryWriteError extends Error {}

export function assertAutomaticMemoryCorrection(current: PiMemoryItem, next: PiMemoryItem, options: PiMemoryWriteOptions): void {
  if (next.authority !== "evidence_backed") return;
  const previous = parseMemoryExperience(current.content);
  const incoming = parseMemoryExperience(next.content);
  if (!incoming) throw new PiMemoryWriteError("automatic experience requires structured content");
  const knowledge = (value: NonNullable<typeof incoming>) => {
    const { source, verification, ...experience } = value;
    return experience;
  };
  const changed = !previous || hash(knowledge(previous)) !== hash(knowledge(incoming)) || current.kind !== next.kind;
  const correction = options.correction;
  if (!changed && !correction) return;
  if (!correction || !Number.isSafeInteger(correction.expected_revision) || !correction.reason.trim() ||
    !["narrow", "disable"].includes(correction.disposition)) {
    throw new PiMemoryWriteError("conflicting experience requires correction with expected_revision, reason and narrow/disable disposition");
  }
  if (correction.disposition === "narrow" && previous?.applies_when.trim() === incoming.applies_when.trim()) {
    throw new PiMemoryWriteError("narrow correction must change applies_when; Pi must explain the smaller scope");
  }
  if (previous && incoming.verification.evidence_refs.every((ref) => previous.verification.evidence_refs.includes(ref))) {
    throw new PiMemoryWriteError("correction requires new verified Evidence, not a repeated source or one failed task");
  }
}

// 只计算来源出现次数，不把修订、搜索、重复复盘当作成功采纳。
export function memoryWriteIdentity(item: PiMemoryItem): { source: string; content: string } {
  const experience = parseMemoryExperience(item.content);
  const source = experience ? ["experience", experience.source.work_id, experience.source.run_id]
    : [item.source_type, item.source_id, item.citation_type, item.citation_id];
  let content: unknown = item.content;
  try { content = JSON.parse(item.content); } catch { /* 兼容旧纯文本。 */ }
  return { source: hash(source), content: hash([item.kind, content]) };
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

export function recordMemoryHistory(db: RunnerDatabase, item: PiMemoryItem, operation: string, correction?: PiMemoryCorrection): void {
  db.sqlite.run(`insert into pi_memory_history
    (memory_id, revision, operation, snapshot_json, correction_json, recorded_at) values (?, ?, ?, ?, ?, ?)`,
  [item.id, item.revision, operation, JSON.stringify(item), JSON.stringify(correction || {}), item.updated_at]);
}

export function listPiMemoryHistory(db: RunnerDatabase, id: string): PiMemoryHistoryEntry[] {
  return db.sqlite.query<{
    memory_id: string; revision: number; operation: string; snapshot_json: string; correction_json: string; recorded_at: string;
  }, [string]>("select * from pi_memory_history where memory_id=? order by revision").all(id).map((row) => ({
    memory_id: row.memory_id, revision: row.revision, operation: row.operation,
    snapshot: JSON.parse(row.snapshot_json), correction: JSON.parse(row.correction_json), recorded_at: row.recorded_at
  }));
}

export function memorySuppression(db: RunnerDatabase, scope: string, scopeID: string, key: string) {
  return db.sqlite.query<{ state: string }, [string, string, string]>(
    "select state from pi_memory_suppressions where scope=? and scope_id=? and memory_key=?"
  ).get(scope, scopeID, key);
}

export function suppressMemory(db: RunnerDatabase, item: PiMemoryItem, state: "disabled" | "forgotten"): void {
  db.sqlite.run(`insert into pi_memory_suppressions (scope, scope_id, memory_key, memory_id, state, updated_at)
    values (?, ?, ?, ?, ?, ?) on conflict(scope, scope_id, memory_key) do update set
    memory_id=excluded.memory_id, state=excluded.state, updated_at=excluded.updated_at`,
  [item.scope, item.scope_id, item.memory_key, item.id, state, item.updated_at]);
}

export function clearMemorySuppression(db: RunnerDatabase, item: Pick<PiMemoryItem, "scope" | "scope_id" | "memory_key">): void {
  db.sqlite.run("delete from pi_memory_suppressions where scope=? and scope_id=? and memory_key=?",
    [item.scope, item.scope_id, item.memory_key]);
}

export function recordMemoryReceipt(db: RunnerDatabase, item: PiMemoryItem): void {
  const identity = memoryWriteIdentity(item);
  db.sqlite.run("insert or ignore into pi_memory_receipts (memory_id, source_key, content_hash, revision) values (?, ?, ?, ?)",
    [item.id, identity.source, identity.content, item.revision]);
}

export function assertMemoryRevision(current: PiMemoryItem, expected: number | undefined): void {
  if (expected !== undefined && (!Number.isSafeInteger(expected) || expected !== current.revision)) {
    throw new PiMemoryWriteError(`memory revision conflict: expected ${expected}, current ${current.revision}; read memory again`);
  }
}
