import type { RunnerDatabase } from "../database.ts";
import {
  createAttentionInboxItem,
  getAttentionInboxItem,
  listAttentionInboxItems,
  type AttentionInboxItemInput,
  type AttentionInboxItemRecord
} from "./intakeRuns.ts";
import {
  cleanString,
  confidence,
  objectArray,
  positiveInteger,
  requiredString,
  requiredStringList,
  stringList
} from "./intakeRunSupport.ts";

type SQLValue = number | string;

export function upsertAttentionInboxItemByEvidence(
  db: RunnerDatabase,
  input: AttentionInboxItemInput,
  timestamp = new Date()
): AttentionInboxItemRecord {
  const existing = findAttentionInboxItemByEvidence(db, input);
  if (!existing) return createAttentionInboxItem(db, input, timestamp);
  updateAttentionInboxItem(db, existing.id, input, timestamp);
  const updated = getAttentionInboxItem(db, existing.id);
  if (!updated) throw new Error(`attention inbox item not found after update: ${existing.id}`);
  return updated;
}

function findAttentionInboxItemByEvidence(
  db: RunnerDatabase,
  input: AttentionInboxItemInput
): AttentionInboxItemRecord | null {
  const source = requiredString(input.source, "source");
  const key = evidenceKey(input.evidence_refs);
  const primaryIntent = requiredString(input.primary_intent, "primary_intent");
  return listAttentionInboxItems(db, { limit: 500, source })
    .find((item) => item.primary_intent === primaryIntent && evidenceKey(item.evidence_refs) === key) ?? null;
}

function updateAttentionInboxItem(
  db: RunnerDatabase,
  id: number,
  input: AttentionInboxItemInput,
  timestamp: Date
): void {
  const row = normalizedUpdate(input, timestamp);
  db.sqlite.run(`update attention_inbox_items set bundle_id=?, intake_run_id=?,
    title=?, summary=?, primary_intent=?, secondary_intents_json=?,
    suggested_actions_json=?, confidence=?, urgency=?, evidence_refs_json=?,
    actor_refs_json=?, target_hints_json=?, schema_item_json=?, updated_at=?
    where id=?`, [...row, id]);
}

function normalizedUpdate(input: AttentionInboxItemInput, timestamp: Date): SQLValue[] {
  return [
    positiveInteger(input.bundle_id, "bundle_id"),
    positiveInteger(input.intake_run_id, "intake_run_id"),
    requiredString(input.title, "title"),
    requiredString(input.summary, "summary"),
    requiredString(input.primary_intent, "primary_intent"),
    JSON.stringify(stringList(input.secondary_intents)),
    JSON.stringify(stringList(input.suggested_actions)),
    confidence(input.confidence),
    cleanString(input.urgency),
    JSON.stringify(requiredStringList(input.evidence_refs, "evidence_refs")),
    JSON.stringify(stringList(input.actor_refs)),
    JSON.stringify(objectArray(input.target_hints)),
    JSON.stringify(input.schema_item && typeof input.schema_item === "object" && !Array.isArray(input.schema_item)
      ? input.schema_item
      : {}),
    timestamp.toISOString()
  ];
}

function evidenceKey(refs: unknown): string {
  return requiredStringList(refs, "evidence_refs").sort().join("\n");
}
