import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent, updatePiAction } from "../db/repositories/pi.ts";

export const PI_ACTION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
export const MCP_APPROVAL_TTL_MS = PI_ACTION_APPROVAL_TTL_MS;

export function piActionApprovalExpiresAt(createdAt: string, existing = ""): string {
  if (existing.trim() !== "") return existing.trim();
  const created = Date.parse(createdAt);
  const anchor = Number.isFinite(created) ? created : Date.now();
  return new Date(anchor + PI_ACTION_APPROVAL_TTL_MS).toISOString();
}

export function mcpApprovalExpiresAt(actionType: string, createdAt: string, existing = ""): string {
  return actionType === "mcp.tool.call" ? piActionApprovalExpiresAt(createdAt, existing) : existing.trim();
}

export function expirePendingPiActionApprovals(db: RunnerDatabase, now = new Date()): number {
  return expirePendingApprovals(db, now);
}

export function expirePendingMcpApprovals(db: RunnerDatabase, now = new Date()): number {
  return expirePendingApprovals(db, now, "mcp.tool.call");
}

function expirePendingApprovals(
  db: RunnerDatabase,
  now: Date,
  actionType = ""
): number {
  const timestamp = now.toISOString();
  const rows = actionType === ""
    ? db.sqlite.query<{ id: string }, [string]>(`
    select id from pi_actions
    where status='pending' and lease_expires_at<>'' and lease_expires_at<=?
    order by lease_expires_at asc, id asc
  `).all(timestamp)
    : db.sqlite.query<{ id: string }, [string, string]>(`
      select id from pi_actions
      where status='pending' and action_type=?
        and lease_expires_at<>'' and lease_expires_at<=?
      order by lease_expires_at asc, id asc
    `).all(actionType, timestamp);
  for (const row of rows) {
    const expired = updatePiAction(db, row.id, {
      decided_by: "system:approval_ttl",
      result_json: JSON.stringify({ action_id: row.id, reason: "approval_ttl_expired", status: "rejected" }),
      status: "rejected"
    });
    createPiActionEvent(db, {
      action_id: expired.id,
      actor: "system:approval_ttl",
      conversation_id: expired.conversation_id,
      decision: "reject",
      delegation_id: expired.delegation_id,
      event_type: "approval_expired",
      heartbeat_id: expired.heartbeat_id,
      issue_id: expired.issue_id,
      project_id: expired.project_id,
      reason: "PI action approval window expired"
    });
  }
  return rows.length;
}
