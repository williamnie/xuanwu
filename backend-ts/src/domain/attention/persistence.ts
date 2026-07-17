import type { RunnerDatabase } from "../../db/database.ts";
import {
  listAttentionInboxItems,
} from "../../db/repositories/intakeRuns.ts";
import {
  listPiApprovalRequests,
  listPiGuardianAlerts
} from "../../db/repositories/pi.ts";
import {
  applyAttentionCommand,
  consolidateAttentionCandidates,
  type AttentionCommand,
  type AttentionRecord,
  type AttentionTransitionAudit,
  type AttentionTransitionResult
} from "./contracts.ts";
import {
  attentionFromApprovalRequest,
  attentionFromGuardianAlert,
  attentionFromInboxItem
} from "./legacyAdapters.ts";

type AttentionCommandEvent = {
  action: AttentionCommand["action"];
  attention_id: string;
  audit: AttentionTransitionAudit;
  created_at: string;
  event_id: string;
  revision: number;
  snoozed_until?: string;
};

// The command log only overlays user acknowledgement/snooze intent. It deliberately
// does not copy or mutate legacy business rows, so their existing authorities remain intact.
export function listPersistedAttention(db: RunnerDatabase): AttentionRecord[] {
  return consolidateAttentionCandidates(attentionCandidates(db)).map((record) => replayCommands(db, record));
}

export function getPersistedAttention(db: RunnerDatabase, id: string): AttentionRecord | null {
  return listPersistedAttention(db).find((record) => record.id === id) ?? null;
}

export function persistAttentionCommand(
  db: RunnerDatabase,
  id: string,
  command: AttentionCommand
): AttentionTransitionResult {
  const current = getPersistedAttention(db, id);
  if (!current) throw new Error(`Attention ${id} not found`);
  const result = applyAttentionCommand(current, command);
  db.sqlite.run(`insert into attention_command_events
    (event_id, attention_id, revision, action, snoozed_until, audit_json, created_at)
    values (?, ?, ?, ?, ?, ?, ?)`, [
    command.audit.event_id,
    current.id,
    result.attention.revision,
    command.action,
    command.snoozed_until ?? "",
    JSON.stringify(command.audit),
    command.audit.occurred_at
  ]);
  return result;
}

function attentionCandidates(db: RunnerDatabase) {
  const inbox = listAttentionInboxItems(db).map(attentionFromInboxItem);
  const guardian = listPiGuardianAlerts(db).map(attentionFromGuardianAlert);
  const approvals = listPiApprovalRequests(db).map(attentionFromApprovalRequest);
  return [...inbox, ...guardian, ...approvals];
}

function replayCommands(db: RunnerDatabase, initial: AttentionRecord): AttentionRecord {
  if (initial.status === "resolved" || initial.status === "dismissed") return initial;
  const events = db.sqlite.query<{
    action: string; attention_id: string; audit_json: string; created_at: string;
    event_id: string; revision: number; snoozed_until: string;
  }, [string]>(`select event_id, attention_id, revision, action, snoozed_until, audit_json, created_at
      from attention_command_events where attention_id=? order by revision asc`).all(initial.id);
  return events.reduce((record, event) => applyAttentionCommand(record, commandEvent({
    ...event,
    audit: parseAudit(event.audit_json)
  })).attention, initial);
}

function commandEvent(event: AttentionCommandEvent): AttentionCommand {
  const audit = event.audit;
  return {
    action: event.action,
    audit,
    expected_revision: event.revision - 1,
    ...(event.snoozed_until ? { snoozed_until: event.snoozed_until } : {})
  };
}

function parseAudit(value: string): AttentionTransitionAudit {
  return JSON.parse(value) as AttentionTransitionAudit;
}
