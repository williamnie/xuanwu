import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../db/database.ts";
import { consolidateAttentionCandidates } from "../domain/attention/contracts.ts";
import { attentionFromInboxItem, attentionFromGuardianAlert } from "../domain/attention/legacyAdapters.ts";
import { listPersistedAttention } from "../domain/attention/persistence.ts";
import type { AttentionRecord } from "../domain/attention/contracts.ts";
import { workDiagnostics } from "./workApi.ts";
import { listIssueBackedWorks } from "../domain/work/issueAdapter.ts";
import { redactAuditText } from "../db/repositories/pi/auditRedaction.ts";
import { listOpenHumanReviewRequests } from "../domain/review/humanReview.ts";
import { getIssueAsWork, issueIDToWorkID } from "../domain/work/issueAdapter.ts";
import { getAttentionInboxItem } from "../db/repositories/intakeRuns.ts";
import { makeDomainID, parseDomainID } from "../xuanwu/coreDomainContracts.ts";
import { listActionProposals, getActionProposal, getPiAction, getPiGuardianAlert } from "../db/repositories/pi.ts";
import type { ReadApiContext } from "./readApiContext.ts";
import type { Router } from "./router.ts";
import { HttpError, json } from "./errors.ts";

type Projections = {
  visible: (db: RunnerDatabase, item: AttentionRecord) => boolean;
  attention: (db: RunnerDatabase, item: AttentionRecord) => Record<string, unknown>;
  decisions: (db: RunnerDatabase, item: AttentionRecord) => Array<Record<string, unknown>>;
};
type Seed = { key: string; source: string; updated_at: string; work_id: string; work_ids?: string[]; revision: number; attention?: AttentionRecord; decision_ref?: string; issue_id?: number; failure_reason?: string; review?: ReturnType<typeof listOpenHumanReviewRequests>[number] };

export function registerInboxRoute(router: Router, context: ReadApiContext, projections: Projections): void {
  router.get("/api/command-center/task-glance", request => {
    const db = context.readDatabase ?? context.database;
    const params = new URL(request.url).searchParams;
    const start = new Date(params.get("day_start") || new Date().toISOString().slice(0,10)).getTime();
    const end = params.get("day_end") ? new Date(params.get("day_end")!).getTime() : start + 86400000;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 172800000) return json({ message: "invalid day range" }, { status: 400 });
    const active = workDiagnostics(db, listIssueBackedWorks(db, { statuses: ["todo", "in_progress"], limit: 5, sort: "updated_at", sortOrder: "desc" }), context);
    const completed = db.sqlite.query<{ id: number; completed_at: string }, [string,string]>(`select i.id, strftime('%Y-%m-%dT%H:%M:%fZ', max(julianday(e.created_at))) as completed_at from issues i join issue_events e on e.issue_id=i.id
      where i.status='done' and e.type='issue.status_changed' and json_valid(e.payload) and json_extract(e.payload, '$.status')='done'
      group by i.id having max(julianday(e.created_at))>=julianday(?) and max(julianday(e.created_at))<julianday(?) order by completed_at desc, i.id desc limit 5`).all(new Date(start).toISOString(), new Date(end).toISOString());
    const unknown = db.sqlite.query<{ count: number }, []>(`select count(*) as count from issues i where i.status='done' and not exists(select 1 from issue_events e where e.issue_id=i.id and e.type='issue.status_changed' and json_valid(e.payload) and json_extract(e.payload,'$.status')='done')`).get()?.count || 0;
    return json({ active, completed_today: completed.map(row => ({ work: getIssueAsWork(db,row.id), completed_at: row.completed_at })), completion_time_unknown: unknown });
  });
  router.get("/api/command-center/inbox", request => {
    try { return json(readCompleteInbox(context.readDatabase ?? context.database, request, projections)); }
    catch (error) { if (error instanceof HttpError) return json({ message: error.message, code: error.status === 409 ? "inbox_changed" : "inbox_unavailable" }, { status: error.status });throw error; }
  });
}
export function readCompleteInbox(db: RunnerDatabase, request: Request, projections: Projections): Record<string, unknown> {
  const params = new URL(request.url).searchParams;
  const pageSize = Number(params.get("page_size") || 50);
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new HttpError(400, "page_size must be 1-100");
  const workId = params.get("work_id") || "";
  if (workId && !/^xw:work:issues:[1-9]\d*$/.test(workId)) throw new HttpError(400, "invalid work_id");
  const openReviews = listOpenHumanReviewRequests(db);
  const proposed = new Set(listActionProposals(db, { status: "proposed" }).map(proposal => `proposal:${proposal.id}`));
  const byKey = new Map<string, Seed>();
  const add = (seed: Seed) => {
    if (workId && seed.work_id !== workId && !seed.work_ids?.includes(workId)) return;
    const current = byKey.get(seed.key);
    if (!current || current.updated_at < seed.updated_at) byKey.set(seed.key, seed);
  };
  for (const item of listPersistedAttention(db, { complete: true })) {
    if (!["open","waiting"].includes(item.status)) continue;
    if (item.snoozed_until && Date.parse(item.snoozed_until) > Date.now()) continue;
    const refs: string[] = [];
    for (const source of item.source_refs) {
      if (source.authority === "pi_action_proposals" && proposed.has(`proposal:${source.local_id}`)) refs.push(`proposal:${source.local_id}`);
      if (source.authority === "pi_approval_requests" && ["pending", "delivered", "resolve_failed"].includes(source.source_state)) refs.push(`approval:${source.local_id}`);
      if (source.authority === "pi_actions" && ["candidate", "pending", "changes_requested", "snoozed"].includes(source.source_state)) refs.push(`pi_action:${source.local_id}`);
    }
    const linkedWork = attentionWorkID(db, item);
    for (const ref of new Set(refs)) {
      const [kind, ...localParts] = ref.split(":");const localID = localParts.join(":");
      const authority = kind === "approval" ? "pi_approval_requests" : kind === "pi_action" ? "pi_actions" : "pi_action_proposals";
      const source = item.source_refs.find(source => source.authority === authority && source.local_id === localID);
      if (!source) continue;
      const singular = { ...item, id: makeDomainID("attention", source.authority, source.local_id), source_refs: [source], related_refs: kind === "proposal" ? [ref] : [] };
      if (!projections.visible(db,singular)) continue;
      const workIDs = kind === "proposal" ? proposalWorkIDs(db,localID) : [attentionWorkID(db,singular)].filter(Boolean);
      add({ key: `attention:${ref}`, source: "attention", updated_at: singular.updated_at, work_id: workIDs.length === 1 ? workIDs[0]! : "", work_ids: workIDs, revision: singular.revision, attention: singular, decision_ref: ref });
    }
    for (const source of item.source_refs) {
      if (source.authority !== "attention_inbox_items" && source.authority !== "pi_guardian_alerts") continue;
      if (source.resolution !== "active") continue;
      const native = source.authority === "attention_inbox_items" ? getAttentionInboxItem(db, Number(source.local_id)) : getPiGuardianAlert(db, source.local_id);
      if (!native) continue;
      const candidate = source.authority === "attention_inbox_items" ? attentionFromInboxItem(native as Parameters<typeof attentionFromInboxItem>[0]) : attentionFromGuardianAlert(native as Parameters<typeof attentionFromGuardianAlert>[0]);
      if (candidate.type === "approval_required" && item.related_refs.some(ref => proposed.has(ref))) continue;
      const base = consolidateAttentionCandidates([candidate])[0]!;
      const singular = { ...base, revision: item.revision, priority: item.priority, ...(item.status === "acknowledged" ? { status: item.status } : {}), ...(item.snoozed_until ? { snoozed_until: item.snoozed_until } : {}) };
      if (!projections.visible(db,singular)) continue;
      add({ key: `attention:${source.authority}:${source.local_id}`, source: "attention", updated_at: singular.updated_at, work_id: linkedWork, revision: singular.revision, attention: singular });
    }
  }
  for (const review of openReviews) add({ key: `human_review:${review.request.id}`, source: "human_review", work_id: issueIDToWorkID(review.request.issue_id), revision: review.request.revision, updated_at: review.request.created_at, review });
  const reviewIssueIDs = new Set(openReviews.map(review => review.request.issue_id));
  const issueRows = db.sqlite.query<{ id: number; status: string; updated_at: string; error: string }, []>("select id, status, updated_at, error from issues where status in ('failed','needs_user') order by updated_at desc, id desc").all();
  for (const issue of issueRows) {
    if (issue.status === "needs_user" && reviewIssueIDs.has(issue.id)) continue;
    const source = issue.status === "failed" ? "failed_work" : "assistant_waiting";
    add({ key: `${source}:${issue.id}`, source, work_id: issueIDToWorkID(issue.id), issue_id: issue.id, failure_reason: redactAuditText(issue.error || ''), updated_at: issue.updated_at, revision: 0 });
  }
  const seeds = [...byKey.values()].sort((a,b) => b.updated_at.localeCompare(a.updated_at) || a.key.localeCompare(b.key));
  const fingerprint = createHash("sha256").update(JSON.stringify({ workId, seeds: seeds.map(seed => [seed.key, seed.updated_at, seed.revision]) })).digest("hex");
  const offset = parseCursor(params.get("cursor") || "", fingerprint);
  const selected = seeds.slice(offset, offset + pageSize);
  const items = selected.map(seed => {
    if (seed.source === "human_review") return { key: seed.key, source: seed.source, work_id: seed.work_id, request: seed.review!.request, title: seed.review!.title, project_id: seed.review!.project_id, updated_at: seed.updated_at };
    if (seed.attention) return { key: seed.key, source: seed.source, work_id: seed.work_id, work_ids: seed.work_ids || [seed.work_id].filter(Boolean), attention_id: seed.attention.id, attention: projections.attention(db, seed.attention), decision: seed.decision_ref ? projections.decisions(db, seed.attention).find(decision => decision.ref === seed.decision_ref) ?? null : null, updated_at: seed.updated_at };
    return { key: seed.key, source: seed.source, work_id: seed.work_id, work: getIssueAsWork(db, seed.issue_id!), failure_reason: seed.failure_reason, updated_at: seed.updated_at };
  });
  const nextOffset = offset + selected.length;
  return { contract: "xuanwu.inbox.v1", complete: true, items, total: seeds.length, has_more: nextOffset < seeds.length, next_cursor: nextOffset < seeds.length ? Buffer.from(JSON.stringify({ version: 1, fingerprint, offset: nextOffset })).toString("base64url") : "", page_size: pageSize };
}
function parseCursor(value: string, fingerprint: string): number {
  if (!value) return 0;
  try {
    if (value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof cursor.fingerprint !== "string" || cursor.version !== 1 || !Number.isSafeInteger(cursor.offset) || Number(cursor.offset) < 0 || Object.keys(cursor).length !== 3) throw new Error();
    if (cursor.fingerprint !== fingerprint) throw new HttpError(409, "待处理内容已变化，请刷新列表");
    return Number(cursor.offset);
  } catch (error) { if (error instanceof HttpError) throw error;throw new HttpError(400, "invalid inbox cursor"); }
}
function attentionWorkID(db: RunnerDatabase, item: AttentionRecord): string {
  const refs = [...item.related_refs, ...item.source_refs.flatMap(source => source.correlation_refs)];
  for (const ref of refs) {
    const issue = /^issue:([1-9]\d*)$/.exec(ref);
    if (issue) return issueIDToWorkID(Number(issue[1]));
    const work = /^(?:work:)?(xw:work:issues:[1-9]\d*)$/.exec(ref);
    if (work) return work[1]!;
    const run = parseDomainID(ref.replace(/^run:/, ""));
    if (run?.kind === "run" && run.authority === "issue_runs") { const row = db.sqlite.query<{ issue_id: number }, [string]>("select issue_id from issue_runs where id=?").get(run.local_id);if (row) return issueIDToWorkID(row.issue_id); }
  }
  const source = item.source_refs.find(source => source.authority === "pi_actions");
  const action = source ? getPiAction(db,source.local_id) : null;
  if (action) {
    if (action.issue_id > 0) return issueIDToWorkID(action.issue_id);
    if (action.action_type.startsWith("issue.")) try { const payload = JSON.parse(action.payload_json);if (Number.isSafeInteger(payload.issue_id) && payload.issue_id > 0) return issueIDToWorkID(payload.issue_id); } catch { /* malformed payload remains an unscoped request */ }
  }
  return "";
}

function proposalWorkIDs(db: RunnerDatabase, id: string): string[] {
  const proposal = getActionProposal(db,id);const ids = new Set<string>();
  for (const action of proposal?.actions || []) {
    const payload = action.payload && typeof action.payload === "object" && !Array.isArray(action.payload) ? action.payload as Record<string, unknown> : {};
    if (typeof payload.work_id === "string" && /^xw:work:issues:[1-9]\d*$/.test(payload.work_id)) ids.add(payload.work_id);
    if (action.type.startsWith("issue.") && typeof payload.issue_id === "number" && Number.isSafeInteger(payload.issue_id) && payload.issue_id > 0) ids.add(issueIDToWorkID(payload.issue_id));
  }
  return [...ids].sort();
}
