import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { readIssueDecisionProjection } from "../domain/review/humanReview.ts";

export type ImActionTarget = {
  issueID: number;
  projectID: string;
  source: "none" | "replied_notification" | "single_open_actionable_notification";
  sourceRef: string;
};

type TargetRow = { created_at: string; issue_id: number; project_id: string; ref: string };

export function resolveImActionTarget(db: RunnerDatabase, input: {
  connectorId: string;
  conversationId: string;
  repliedMessageId?: string;
  text: string;
}): ImActionTarget {
  const replyRef = clean(input.repliedMessageId);
  if (replyRef) {
    const rows = db.sqlite.query<TargetRow, [string, string]>(
      `select o.issue_id, coalesce(i.project_id, '') as project_id,
              o.provider_request_ref as ref, o.created_at
         from sync_outbox o left join issues i on i.id=o.issue_id
        where o.source=? and o.status='sent' and o.issue_id>0 and o.provider_request_ref=?
        order by o.created_at desc, o.id desc`
    ).all(clean(input.connectorId), replyRef);
    const exact = uniqueOpen(db, rows);
    if (exact.length === 1) return target(exact[0]!, "replied_notification");
    if (exact.length > 1) return empty();
  }
  if (!looksActionable(input.text)) return empty();
  const open = uniqueOpen(db, db.sqlite.query<TargetRow, [string, string]>(
    `select n.issue_id, n.project_id, n.id as ref, n.created_at
       from pi_notification_intents n
      where n.target_channel=? and n.target_chat_id=? and n.requires_user=1
        and n.state='sent' and n.issue_id>0
      order by n.created_at desc, n.id desc limit 32`
  ).all(clean(input.connectorId), clean(input.conversationId)));
  return open.length === 1 ? target(open[0]!, "single_open_actionable_notification") : empty();
}

function uniqueOpen(db: RunnerDatabase, rows: TargetRow[]): TargetRow[] {
  const seen = new Set<number>();
  return rows.filter((row) => {
    if (!Number.isSafeInteger(row.issue_id) || row.issue_id <= 0 || seen.has(row.issue_id)) return false;
    seen.add(row.issue_id);
    const issue = getIssue(db, row.issue_id);
    if (!issue || issue.status !== "needs_user") return false;
    try {
      return readIssueDecisionProjection(db, row.issue_id).phase === "human_review" &&
        readIssueDecisionProjection(db, row.issue_id).request?.status === "open";
    } catch {
      return false;
    }
  });
}

function target(row: TargetRow, source: Exclude<ImActionTarget["source"], "none">): ImActionTarget {
  return { issueID: row.issue_id, projectID: clean(row.project_id), source, sourceRef: clean(row.ref) };
}

function empty(): ImActionTarget {
  return { issueID: 0, projectID: "", source: "none", sourceRef: "" };
}

function looksActionable(value: string): boolean {
  const text = clean(value);
  return text.length > 0 && text.length <= 160 && /(?:接受|同意|批准|通过|确认|完成|不用管|不阻塞|继续|调整|修改|拒绝|驳回|accept|approve|confirm|complete|continue|adjust|reject)/i.test(text);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
