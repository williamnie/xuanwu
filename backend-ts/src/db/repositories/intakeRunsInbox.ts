import type { RunnerDatabase } from "../database.ts";
import { lastInsertID } from "./intakeRunSupport.ts";
import {
  type AttentionInboxItemInput,
  type AttentionInboxItemRecord,
  normalizeItem,
  itemInsertColumns,
  itemValues,
  getAttentionInboxItem,
  type AttentionInboxItemFilter,
  itemListQuery,
  type SQLValue,
  ITEM_COLUMNS,
  mapItem,
  type AttentionInboxItemStatus,
  requireAttentionInboxItem,
  itemStatus
} from "./intakeRunsModel.ts";

export function createAttentionInboxItem(
  db: RunnerDatabase,
  input: AttentionInboxItemInput,
  timestamp = new Date()
): AttentionInboxItemRecord {
  const record = normalizeItem(input, timestamp);
  db.sqlite.run(`insert into attention_inbox_items (${itemInsertColumns()})
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, itemValues(record));
  const saved = getAttentionInboxItem(db, lastInsertID(db));
  if (!saved) throw new Error("attention inbox item missing after write");
  return saved;
}

export function listAttentionInboxItems(
  db: RunnerDatabase,
  filter: AttentionInboxItemFilter = {}
): AttentionInboxItemRecord[] {
  const query = itemListQuery(filter);
  return db.sqlite.query<Record<string, unknown>, SQLValue[]>(
    `select ${ITEM_COLUMNS} from attention_inbox_items${query.where}
      order by created_at desc, id desc limit ?`
  ).all(...query.args).map(mapItem);
}

// including when its canonical ID belongs to a merged ignored carrier.
export const ATTENTION_INBOX_SEED_SQL = `select ${ITEM_COLUMNS} from attention_inbox_items
  where status in ('new', 'proposal_created', 'failed') or id in (
    select cast(substr(attention_id, length('xw:attention:attention_inbox_items:') + 1) as integer)
    from attention_command_events where attention_id glob 'xw:attention:attention_inbox_items:*'
  ) order by created_at desc, id desc`;

export function listAttentionInboxProjectionItems(
  db: RunnerDatabase,
  visibleOnly = false
): AttentionInboxItemRecord[] {
  return db.sqlite.query<Record<string, unknown>, []>(
    visibleOnly ? ATTENTION_INBOX_SEED_SQL
      : `select ${ITEM_COLUMNS} from attention_inbox_items order by created_at desc, id desc`
  ).all().map(mapItem);
}

// Non-matching historical payloads never cross the SQLite/JS boundary.
const CORRELATION_TRIM = "char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279)";

export const ATTENTION_RELATED_INBOX_SQL = `
  with wanted(ref) as materialized (select value from json_each(?))
  select ${ITEM_COLUMNS} from attention_inbox_items i
  where status not in ('new', 'proposal_created', 'failed') and (
    exists (select 1 from json_each(case when json_valid(i.evidence_refs_json) then i.evidence_refs_json else '[]' end) e
      where e.type='text' and trim(e.value, ${CORRELATION_TRIM}) in (select ref from wanted))
    or exists (select 1 from json_each(case when json_valid(i.schema_item_json) then i.schema_item_json else '{}' end) s
      where s.key in ('approval_id','run_id','issue_id','work_id','conversation_id') and (
        replace(s.key, '_id', '') || ':' || trim(cast(s.value as text), ${CORRELATION_TRIM}) in (select ref from wanted)
        or (s.type='real' and exists (select 1 from wanted w
          where substr(w.ref, 1, instr(w.ref, ':')-1)=replace(s.key, '_id', '')
            and cast(substr(w.ref, instr(w.ref, ':')+1) as real)=s.atom))
      ))
  ) order by created_at desc, id desc`;

export function listRelatedAttentionInboxItems(db: RunnerDatabase, correlations: string[]): AttentionInboxItemRecord[] {
  if (correlations.length === 0) return [];
  return db.sqlite.query<Record<string, unknown>, [string]>(ATTENTION_RELATED_INBOX_SQL)
    .all(JSON.stringify(correlations)).map(mapItem);
}

export function updateAttentionInboxItemStatus(
  db: RunnerDatabase,
  id: number,
  status: AttentionInboxItemStatus,
  timestamp = new Date()
): AttentionInboxItemRecord {
  requireAttentionInboxItem(db, id);
  db.sqlite.run("update attention_inbox_items set status=?, updated_at=? where id=?", [
    itemStatus(status), timestamp.toISOString(), id
  ]);
  return requireAttentionInboxItem(db, id);
}
