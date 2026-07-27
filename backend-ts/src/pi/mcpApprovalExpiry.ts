import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent, updatePiAction } from "../db/repositories/pi.ts";

export const MCP_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export function mcpApprovalExpiresAt(actionType: string, createdAt: string, existing = ""): string {
  if (existing.trim() !== "" || actionType !== "mcp.tool.call") return existing.trim();
  const created = Date.parse(createdAt);
  const anchor = Number.isFinite(created) ? created : Date.now();
  return new Date(anchor + MCP_APPROVAL_TTL_MS).toISOString();
}

export function expirePendingMcpApprovals(db: RunnerDatabase, now = new Date()): number {
  const timestamp = now.toISOString();
  const rows = db.sqlite.query<{ id: string }, [string]>(`
    select id from pi_actions
    where action_type='mcp.tool.call' and status='pending'
      and lease_expires_at<>'' and lease_expires_at<=?
    order by lease_expires_at asc, id asc
  `).all(timestamp);
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
      reason: "MCP approval window expired"
    });
  }
  return rows.length;
}
