import type { RunnerDatabase } from "../../database.ts";
import { getContextBundle } from "../contextBundles.ts";
import { getExternalEvent } from "../externalEvents.ts";
import { getAttentionInboxItem, getIntakeRun } from "../intakeRuns.ts";
import { getImReplyDraft, getSyncOutbox } from "../imReplyOutbox.ts";
import { getIssue, type IssueRun } from "../issues.ts";
import { getActionProposal } from "./actionProposals.ts";
import type { PiActivityFilter, PiActivityScope } from "./activityTimelineTypes.ts";

type SQLValue = number | string;
type Clause = { sql: string; args: SQLValue[] };
type Window = Pick<PiActivityFilter, "since" | "until">;
const LIMIT = 500;
const NONE: Clause = { sql: "0", args: [] };
const ALL: Clause = { sql: "", args: [] };

/** 先在 SQL 中选出有限 ID，再复用详情映射；不反序列化整个历史表。 */
export function loadActivityEntities(db: RunnerDatabase, filter: PiActivityFilter) {
  const narrow = Boolean(filter.issueId || filter.conversationId || filter.proposalId || filter.inboxItemId);
  const recent = narrow || filter.source ? NONE : ALL;
  const sourced = narrow ? NONE : filter.source ? { sql: "source=?", args: [filter.source] } : ALL;
  return {
    bundles: read(db, "context_bundles", "created_at", getContextBundle, sourced, filter),
    inboxItems: read(db, "attention_inbox_items", "created_at", getAttentionInboxItem,
      filter.inboxItemId ? match("id", [filter.inboxItemId]) : sourced, filter.inboxItemId ? {} : filter),
    intakeRuns: read(db, "intake_runs", "updated_at", getIntakeRun, recent, filter),
    issues: read(db, "issues", "updated_at", getIssue,
      filter.issueId ? match("id", [filter.issueId]) : recent, filter.issueId ? {} : filter),
    proposals: read(db, "pi_action_proposals", "updated_at", getActionProposal,
      filter.proposalId ? match("id", [filter.proposalId]) : recent, filter.proposalId ? {} : filter),
    rawEvents: read(db, "external_events", "received_at", getExternalEvent, sourced, filter),
    replies: read(db, "im_reply_drafts", "updated_at", getImReplyDraft,
      filter.issueId ? match("issue_id", [filter.issueId]) : sourced, filter),
    syncOutbox: read(db, "sync_outbox", "updated_at", getSyncOutbox,
      filter.issueId ? match("issue_id", [filter.issueId]) : sourced, filter)
  };
}

export type ActivityEntities = ReturnType<typeof loadActivityEntities>;

type ActivityIssueRun = Pick<IssueRun, "id" | "provider" | "provider_session_id" | "started_at" | "ended_at" |
  "status" | "error" | "exit_reason" | "selection_reason">;

export function listActivityIssueRuns(db: RunnerDatabase, issueID: number, window: Window): ActivityIssueRun[] {
  const conditions = ["issue_id=?"];
  const args: SQLValue[] = [issueID];
  const time = "coalesce(nullif(ended_at, ''), started_at)";
  if (validDate(window.since)) { conditions.push(`julianday(${time})>=julianday(?)`); args.push(window.since!); }
  if (validDate(window.until)) { conditions.push(`julianday(${time})<=julianday(?)`); args.push(window.until!); }
  return db.sqlite.query<ActivityIssueRun, SQLValue[]>(`
    select id, provider, provider_session_id, started_at, ended_at, status, error, exit_reason, selection_reason
    from issue_runs where ${conditions.join(" and ")}
    order by ${time} desc, id desc limit ${LIMIT}
  `).all(...args);
}

/** 精确引用不受最近窗口限制；反向关联只读取与当前范围有关的有限候选。 */
export function hydrateActivityEntities(db: RunnerDatabase, rows: ActivityEntities, scope: PiActivityScope): void {
  appendExact(db, rows.rawEvents, scope.rawEventIds, getExternalEvent);
  appendExact(db, rows.bundles, scope.bundleIds, getContextBundle);
  appendExact(db, rows.intakeRuns, scope.intakeRunIds, getIntakeRun);
  appendExact(db, rows.inboxItems, scope.inboxIds, getAttentionInboxItem);
  appendExact(db, rows.proposals, scope.proposalIds, getActionProposal);
  appendExact(db, rows.issues, scope.issueIds, getIssue);

  append(rows.bundles, read(db, "context_bundles", "created_at", getContextBundle,
    jsonMatch("event_refs_json", [...scope.rawEventIds]), {}, rows.bundles));
  append(rows.intakeRuns, read(db, "intake_runs", "updated_at", getIntakeRun, match("bundle_id", [...scope.bundleIds]), {}, rows.intakeRuns));
  append(rows.inboxItems, read(db, "attention_inbox_items", "created_at", getAttentionInboxItem,
    either(match("bundle_id", [...scope.bundleIds]), match("intake_run_id", [...scope.intakeRunIds])), {}, rows.inboxItems));
  append(rows.proposals, read(db, "pi_action_proposals", "updated_at", getActionProposal,
    jsonMatch("source_item_ids_json", [...scope.inboxIds].map(id => `attention_inbox_item:${id}`)), {}, rows.proposals));
  append(rows.issues, read(db, "issues", "updated_at", getIssue, sourceReferences(scope), {}, rows.issues));
  const replyScope = either(match("approval_action_id", [...scope.actionIds]),
    match("issue_id", [...scope.issueIds]), match("external_event_id", [...scope.rawEventIds]));
  append(rows.replies, read(db, "im_reply_drafts", "updated_at", getImReplyDraft, replyScope, scope, rows.replies));
  append(rows.syncOutbox, read(db, "sync_outbox", "updated_at", getSyncOutbox,
    match("approval_action_id", [...scope.actionIds]), scope, rows.syncOutbox));
}

function read<ID extends SQLValue, T extends { id: ID }>(
  db: RunnerDatabase, table: string, time: string, getter: (db: RunnerDatabase, id: ID) => T | null,
  clause: Clause, window: Window = {}, known: T[] = []
): T[] {
  if (clause.sql === "0") return [];
  const conditions = clause.sql ? [`(${clause.sql})`] : [];
  const args = [...clause.args];
  const loaded = new Set(known.map(row => row.id));
  if (validDate(window.since)) { conditions.push(`julianday(${time})>=julianday(?)`); args.push(window.since!); }
  if (validDate(window.until)) { conditions.push(`julianday(${time})<=julianday(?)`); args.push(window.until!); }
  return db.sqlite.query<{ id: ID }, SQLValue[]>(`
    select id from ${table} ${conditions.length ? `where ${conditions.join(" and ")}` : ""}
    order by ${time} desc, id desc limit ${LIMIT}
  `).all(...args).flatMap(({ id }) => {
    if (loaded.has(id)) return [];
    const row = getter(db, id);
    return row ? [row] : [];
  });
}

function appendExact<ID extends SQLValue, T extends { id: ID }>(
  db: RunnerDatabase, rows: T[], ids: Set<ID>, getter: (db: RunnerDatabase, id: ID) => T | null
): void {
  const loaded = new Set(rows.map(row => row.id));
  for (const id of [...ids].filter(id => !loaded.has(id)).slice(0, LIMIT)) {
    const row = getter(db, id);
    if (row) rows.push(row);
  }
}

function append<T extends { id: SQLValue }>(rows: T[], candidates: T[]): void {
  const loaded = new Set(rows.map(row => row.id));
  for (const row of candidates) if (!loaded.has(row.id)) { loaded.add(row.id); rows.push(row); }
}

function match(column: string, values: SQLValue[]): Clause {
  const args = [...new Set(values)].filter(value => value !== "" && value !== 0).slice(0, LIMIT);
  return args.length ? { sql: `${column} in (${args.map(() => "?").join(",")})`, args } : NONE;
}

function jsonMatch(column: string, values: SQLValue[]): Clause {
  const candidate = match("value", values);
  if (candidate.sql === "0") return NONE;
  return {
    sql: `exists (select 1 from json_each(case when json_valid(${column}) then ${column} else '[]' end) where ${candidate.sql})`,
    args: candidate.args
  };
}

function either(...clauses: Clause[]): Clause {
  const present = clauses.filter(clause => clause.sql !== "0");
  return present.length ? { sql: present.map(clause => `(${clause.sql})`).join(" or "), args: present.flatMap(clause => clause.args) } : NONE;
}

function sourceReferences(scope: PiActivityScope): Clause {
  const refs = [
    ...[...scope.rawEventIds].map(id => `external_event:${id}`),
    ...[...scope.inboxIds].map(id => `attention_inbox_item:${id}`),
    ...[...scope.proposalIds].map(id => `proposal:${id}`),
    ...[...scope.issueIds].map(id => `issue:${id}`)
  ].slice(0, LIMIT);
  if (refs.length === 0) return NONE;
  const replaced = "replace(source_turn_id || char(10) || source_excerpt, value, char(1))";
  return {
    // 替换所有出现位置，避免首个 issue:10 遮住后面的 issue:1；边界与 textRefs 保持一致。
    sql: `(source_turn_id<>'' or source_excerpt<>'') and exists
      (select 1 from json_each(?) where instr(source_turn_id || char(10) || source_excerpt, value)>0
      and (${replaced} glob '*' || char(1) or ${replaced} glob '*' || char(1) ||
        case when value like 'proposal:%' then '[^A-Za-z0-9_.:-]*' else '[^0-9]*' end))`,
    args: [JSON.stringify(refs)]
  };
}

function validDate(value: string | undefined): boolean { return Boolean(value && Number.isFinite(Date.parse(value))); }
