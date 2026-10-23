import type { RunnerDatabase } from "../db/database.ts";
import { listIssueBackedWorks, workIDToIssueID } from "../domain/work/issueAdapter.ts";
import { readIssueDecisionProjection, type HumanReviewRequest } from "../domain/review/humanReview.ts";
import type { WorkLedgerEntry } from "../domain/work/contracts.ts";
import { HttpError } from "./errors.ts";

export const COMMAND_CENTER_INBOX_CONTRACT = "xw.command-center.inbox.v1";
const INBOX_SOURCES = ["human_review", "preparing", "failed_work", "attention"] as const;
export type InboxSource = typeof INBOX_SOURCES[number];
export type InboxItem = {
  key: string;
  source: InboxSource;
  actionable: boolean;
  occurred_at: string;
  work_id: string | null;
  attention_id: string | null;
  project_id: string | null;
  work?: WorkLedgerEntry;
  request?: HumanReviewRequest;
  review_request_id?: string;
  review_revision?: number;
  attention?: Record<string, unknown>;
};
export type InboxReaders = Record<InboxSource, () => InboxItem[]>;
type Cursor = { version: typeof COMMAND_CENTER_INBOX_CONTRACT; group: number; occurred_at: string; key: string };

export function commandCenterInboxReaders(db: RunnerDatabase, readAttention: () => InboxItem[]): InboxReaders {
  // Both classes share one authoritative read and one replay per needs_user task.
  let needsUser: InboxItem[] | undefined;
  const taskRequests = () => needsUser ??= listInboxWorks(db, "needs_user").map(work => {
    const decision = readIssueDecisionProjection(db, workIDToIssueID(work.id));
    const request = decision.owner === "human" && decision.request?.status === "open" ? decision.request : null;
    const source = request ? "human_review" : "preparing";
    return {
      ...workItem(work, source),
      key: `${source}:${request?.id ?? work.id}`,
      occurred_at: request?.created_at ?? work.updated_at,
      ...(request ? { request, review_request_id: request.id, review_revision: request.revision } : {})
    };
  });
  return {
    human_review: () => taskRequests().filter(item => item.source === "human_review"),
    preparing: () => taskRequests().filter(item => item.source === "preparing"),
    failed_work: () => listInboxWorks(db, "failed").map(work => workItem(work, "failed_work")),
    attention: readAttention
  };
}

function listInboxWorks(db: RunnerDatabase, status: "needs_user" | "failed"): WorkLedgerEntry[] {
  const works: WorkLedgerEntry[] = [];
  // The shared Work serializer's event batch accepts at most 100 task IDs.
  // These are local database batches, not HTTP fan-out or a display cap.
  for (let offset = 0; ; offset += 100) {
    const page = listIssueBackedWorks(db, { statuses: [status], limit: 100, offset, sort: "updated_at", sortOrder: "desc" });
    works.push(...page);
    if (page.length < 100) return works;
  }
}

function workItem(work: WorkLedgerEntry, source: InboxSource): InboxItem {
  return {
    key: `${source}:${work.id}`, source, actionable: source !== "preparing",
    occurred_at: work.updated_at, work_id: work.id, attention_id: null,
    project_id: work.owner.project_id || null, work
  };
}

export function buildCommandCenterInbox(request: Request, readers: InboxReaders) {
  const { limit, cursor } = inboxInput(request);
  const counts = Object.fromEntries(INBOX_SOURCES.map(source => [source, 0])) as Record<InboxSource, number>;
  const failedSources: InboxSource[] = [];
  const all: InboxItem[] = [];
  for (const source of INBOX_SOURCES) {
    try {
      const items = readers[source]();
      // A bad source must be explicit; never disguise an invalid timestamp as an empty queue.
      if (items.some(item => item.source !== source || !Number.isFinite(Date.parse(item.occurred_at)))) {
        throw new Error("invalid inbox source projection");
      }
      counts[source] = items.length;
      all.push(...items);
    } catch {
      failedSources.push(source);
    }
  }
  all.sort(compare);
  const remaining = cursor ? all.filter(item => compare(position(item), cursor) > 0) : all;
  const items = remaining.slice(0, limit);
  const last = items.at(-1);
  return {
    contract: COMMAND_CENTER_INBOX_CONTRACT,
    items,
    next_cursor: remaining.length > limit && last ? Buffer.from(JSON.stringify(position(last))).toString("base64url") : null,
    counts, total: all.length, complete: failedSources.length === 0, failed_sources: failedSources
  };
}

function position(item: InboxItem): Cursor {
  return { version: COMMAND_CENTER_INBOX_CONTRACT, group: item.source === "preparing" ? 1 : 0, occurred_at: item.occurred_at, key: item.key };
}
function compare(left: InboxItem | Cursor, right: InboxItem | Cursor): number {
  const a = "group" in left ? left : position(left);
  const b = "group" in right ? right : position(right);
  return a.group - b.group || Date.parse(b.occurred_at) - Date.parse(a.occurred_at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
}
function inboxInput(request: Request): { limit: number; cursor?: Cursor } {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!["limit", "cursor"].includes(key) || params.getAll(key).length !== 1) throw new HttpError(400, "Inbox accepts one limit and one cursor only");
  }
  const value = params.get("limit") ?? "20";
  if (!/^[1-9]\d?$/.test(value) || Number(value) > 50) throw new HttpError(400, "limit must be an integer from 1 to 50");
  if (!params.has("cursor")) return { limit: Number(value) };
  const raw = params.get("cursor")!;
  try {
    if (!raw || raw.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
    const decoded = Buffer.from(raw, "base64url");
    if (decoded.toString("base64url") !== raw) throw new Error();
    const cursor = JSON.parse(decoded.toString("utf8")) as Cursor;
    if (!cursor || Object.keys(cursor).sort().join() !== "group,key,occurred_at,version"
      || cursor.version !== COMMAND_CENTER_INBOX_CONTRACT || ![0, 1].includes(cursor.group)
      || typeof cursor.occurred_at !== "string" || !Number.isFinite(Date.parse(cursor.occurred_at))
      || typeof cursor.key !== "string" || cursor.key.length > 512
      || !/^(human_review|preparing|failed_work|attention):.+$/.test(cursor.key)
      || (cursor.key.startsWith("preparing:") ? 1 : 0) !== cursor.group) throw new Error();
    return { limit: Number(value), cursor };
  } catch { throw new HttpError(400, "invalid or unsupported inbox cursor"); }
}
