import type { RunnerDatabase } from "../db/database.ts";
import { createProjectStatusSnapshot } from "./projectSnapshot.ts";
import { listPiMemoryItems, type PiMemoryItem } from "../db/repositories/pi.ts";
import { containsSensitiveMemoryContent } from "./memoryPolicy.ts";
import type { HeartbeatSignals } from "./heartbeatTypes.ts";
import { iso } from "./heartbeatOrchestratorSupport.ts";

export function collectProjectHeartbeatSignals(db: RunnerDatabase, projectID: string, now: Date): HeartbeatSignals {
  const snapshot = createProjectStatusSnapshot(db, projectID);
  const nowText = iso(now);
  return {
    cron: cronSignals(db, projectID, nowText),
    delegations: delegationSignals(db, projectID, nowText),
    issues: { status_counts: snapshot.issue_status_counts, total: snapshot.total_issues },
    memory: memorySignals(db, projectID),
    memory_items: memoryItems(db, projectID),
    pi_conversations: conversationSignals(db, projectID),
    project: snapshot,
    provider_health: providerHealth(db, projectID),
    usage_cost: usageCost()
  };
}

function cronSignals(db: RunnerDatabase, projectID: string, nowText: string) {
  return {
    active: countRows(db, "select count(*) as count from cron_tasks where project_id=? and status='active'", [projectID]),
    due: countRows(db, "select count(*) as count from cron_tasks where project_id=? and status='active' and next_run_at<>'' and next_run_at<=?", [projectID, nowText]),
    total: countRows(db, "select count(*) as count from cron_tasks where project_id=?", [projectID])
  };
}

function delegationSignals(db: RunnerDatabase, projectID: string, nowText: string) {
  return {
    active: countRows(db, "select count(*) as count from pi_delegations where project_id=? and status='active'", [projectID]),
    due: countRows(db, "select count(*) as count from pi_delegations where project_id=? and status='active' and (next_heartbeat_at='' or next_heartbeat_at<=?)", [projectID, nowText])
  };
}

function memorySignals(db: RunnerDatabase, projectID: string) {
  return {
    active: countRows(db, "select count(*) as count from pi_memory_items where scope='project' and scope_id=? and disabled=0", [projectID]),
    pinned: countRows(db, "select count(*) as count from pi_memory_items where scope='project' and scope_id=? and disabled=0 and pinned=1", [projectID])
  };
}

function memoryItems(db: RunnerDatabase, projectID: string) {
  const items = [
    ...listPiMemoryItems(db, { disabled: 0, scope: "project", scopeId: projectID }),
    ...listPiMemoryItems(db, { disabled: 0, scope: "global" })
  ].filter((item) => !containsSensitiveMemoryContent(item.content));
  return items.slice(0, 8).map(memorySummary);
}

function memorySummary(item: PiMemoryItem) {
  return {
    confidence: item.confidence,
    content: item.content,
    kind: item.kind,
    scope: item.scope,
    scope_id: item.scope_id
  };
}

function conversationSignals(db: RunnerDatabase, projectID: string) {
  return {
    active: countRows(db, "select count(*) as count from pi_conversations where project_id=? and status='active'", [projectID]),
    total: countRows(db, "select count(*) as count from pi_conversations where project_id=?", [projectID])
  };
}

function providerHealth(db: RunnerDatabase, projectID: string) {
  const row = db.sqlite.query<{ provider: string }, [string]>("select provider from projects where id=?").get(projectID);
  return { provider: row?.provider ?? "", status: row?.provider ? "configured" : "missing" };
}

function usageCost() {
  return { status: "not_configured", total_tokens: 0 };
}

function countRows(db: RunnerDatabase, sql: string, params: string[]): number {
  return db.sqlite.query<{ count: number }, string[]>(sql).get(...params)?.count ?? 0;
}
