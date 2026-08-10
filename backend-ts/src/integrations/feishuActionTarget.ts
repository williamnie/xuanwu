import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { readIssueDecisionProjection } from "../domain/review/humanReview.ts";
import type { FeishuNormalizedMessageEvent } from "./feishu.ts";

export type FeishuActionTarget = {
  issueID: number;
  projectID: string;
  source: "none" | "replied_notification" | "single_open_actionable_notification";
  sourceRef: string;
};

type TargetRow = {
  created_at: string;
  issue_id: number;
  project_id: string;
  ref: string;
};

export function resolveFeishuActionTarget(
  db: RunnerDatabase,
  event: FeishuNormalizedMessageEvent
): FeishuActionTarget {
  const replied = repliedNotificationTargets(db, event).filter((row) => openHumanReview(db, row.issue_id));
  const exact = uniqueIssueTargets(replied);
  if (exact.length === 1) return target(exact[0]!, "replied_notification");
  if (exact.length > 1) return emptyTarget();

  if (!looksLikeActionableReply(event.text)) return emptyTarget();

  const open = uniqueIssueTargets(openActionableNotificationTargets(db, event)
    .filter((row) => openHumanReview(db, row.issue_id)));
  return open.length === 1
    ? target(open[0]!, "single_open_actionable_notification")
    : emptyTarget();
}

function repliedNotificationTargets(db: RunnerDatabase, event: FeishuNormalizedMessageEvent): TargetRow[] {
  const refs = [cleanString(event.thread_id), cleanString(event.root_id)].filter(Boolean);
  if (refs.length === 0) return [];
  const placeholders = refs.map(() => "?").join(",");
  // provider_request_ref is the authoritative delivery receipt; legacy rows
  // whose receipt only exists in the feishu_message_id compatibility carrier
  // still match while the bounded compat window is open.
  return db.sqlite.query<TargetRow, string[]>(
    `select o.issue_id, coalesce(i.project_id, '') as project_id,
            o.provider_request_ref as ref, o.created_at
       from sync_outbox o
       left join issues i on i.id=o.issue_id
      where o.source='feishu' and o.status='sent' and o.issue_id>0
        and (o.provider_request_ref in (${placeholders}) or o.feishu_message_id in (${placeholders}))
      order by o.created_at desc, o.id desc`
  ).all(...refs, ...refs);
}

function openActionableNotificationTargets(
  db: RunnerDatabase,
  event: FeishuNormalizedMessageEvent
): TargetRow[] {
  const chatID = cleanString(event.chat_id);
  if (chatID === "") return [];
  return db.sqlite.query<TargetRow, [string]>(
    `select n.issue_id, n.project_id, n.id as ref, n.created_at
       from pi_notification_intents n
      where n.target_channel='feishu' and n.target_chat_id=?
        and n.requires_user=1 and n.state='sent' and n.issue_id>0
      order by n.created_at desc, n.id desc
      limit 32`
  ).all(chatID);
}

function openHumanReview(db: RunnerDatabase, issueID: number): boolean {
  const issue = getIssue(db, issueID);
  if (!issue || issue.status !== "needs_user") return false;
  try {
    const decision = readIssueDecisionProjection(db, issueID);
    return decision.phase === "human_review" && decision.request?.status === "open";
  } catch {
    return false;
  }
}

function uniqueIssueTargets(rows: TargetRow[]): TargetRow[] {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (!Number.isSafeInteger(row.issue_id) || row.issue_id <= 0 || seen.has(row.issue_id)) return false;
    seen.add(row.issue_id);
    return true;
  });
}

function target(row: TargetRow, source: Exclude<FeishuActionTarget["source"], "none">): FeishuActionTarget {
  return {
    issueID: row.issue_id,
    projectID: cleanString(row.project_id),
    source,
    sourceRef: cleanString(row.ref)
  };
}

function emptyTarget(): FeishuActionTarget {
  return { issueID: 0, projectID: "", source: "none", sourceRef: "" };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function looksLikeActionableReply(value: unknown): boolean {
  const text = cleanString(value);
  if (text === "" || text.length > 160) return false;
  return /(?:接受|同意|批准|通过|确认|完成|不用管|不阻塞|继续|调整|修改|拒绝|驳回|accept|approve|confirm|complete|continue|adjust|reject)/i.test(text);
}
