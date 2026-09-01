import type { RunnerDatabase } from "../../db/database.ts";
import {
  listAttentionInboxItems,
} from "../../db/repositories/intakeRuns.ts";
import {
  listActionProposals,
  listRecentAttentionPiActions,
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
  attentionFromInboxItem,
  attentionFromPiAction
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

type PersistedAttentionOptions = { actionLimit?: number; now?: Date };
const ATTENTION_ACTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_ATTENTION_ACTION_LIMIT = 25;

// The command log only overlays user acknowledgement/snooze intent. It deliberately
// does not copy or mutate legacy business rows, so their existing authorities remain intact.
export function listPersistedAttention(
  db: RunnerDatabase,
  options: PersistedAttentionOptions = {}
): AttentionRecord[] {
  return consolidateAttentionCandidates(attentionCandidates(db, options)).map((record) => replayCommands(db, record));
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

function attentionCandidates(db: RunnerDatabase, options: PersistedAttentionOptions) {
  const proposalRefs = proposalRefsByInboxID(db);
  const inbox = listAttentionInboxItems(db).map((item) => {
    const candidate = attentionFromInboxItem(item);
    return {
      ...candidate,
      related_refs: [...(candidate.related_refs ?? []), ...(proposalRefs.get(item.id) ?? [])]
    };
  });
  const guardian = listPiGuardianAlerts(db).map(attentionFromGuardianAlert);
  const approvals = listPiApprovalRequests(db).map(attentionFromApprovalRequest);
  const now = options.now ?? new Date();
  const actions = listRecentAttentionPiActions(db, {
    limit: options.actionLimit ?? DEFAULT_ATTENTION_ACTION_LIMIT,
    updatedAfter: new Date(now.getTime() - ATTENTION_ACTION_WINDOW_MS).toISOString()
  })
    .map((action) => attentionFromPiAction(action, proposalRefsFromAction(action)));
  return [...inbox, ...guardian, ...approvals, ...actions];
}

function proposalRefsByInboxID(db: RunnerDatabase): Map<number, string[]> {
  const refs = new Map<number, string[]>();
  for (const proposal of listActionProposals(db)) {
    for (const source of proposal.source_item_ids) {
      const id = inboxItemID(source);
      if (id <= 0) continue;
      refs.set(id, [...new Set([...(refs.get(id) ?? []), `proposal:${proposal.id}`])]);
    }
  }
  return refs;
}

function proposalRefsFromAction(action: { idempotency_key: string; payload_json: string }): string[] {
  const refs = new Set<string>();
  const payload = parseObject(action.payload_json);
  const proposalID = cleanString(payload.proposal_id);
  if (proposalID) refs.add(`proposal:${proposalID}`);
  const match = /^action-proposal:(.+):[^:]+$/.exec(action.idempotency_key);
  if (match?.[1]) refs.add(`proposal:${match[1]}`);
  return [...refs];
}

function inboxItemID(value: string): number {
  const match = /^(?:attention_inbox_item:)?(\d+)$/.exec(value.trim());
  const id = Number(match?.[1] ?? 0);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
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

function commandEvent(event: Omit<AttentionCommandEvent, "action"> & { action: string }): AttentionCommand {
  const audit = event.audit;
  return {
    action: attentionCommandAction(event.action),
    audit,
    expected_revision: event.revision - 1,
    ...(event.snoozed_until ? { snoozed_until: event.snoozed_until } : {})
  };
}

function attentionCommandAction(value: string): AttentionCommand["action"] {
  if (["acknowledge", "snooze", "resolve", "dismiss", "escalate"].includes(value)) {
    return value as AttentionCommand["action"];
  }
  throw new Error(`unsupported persisted Attention action ${value}`);
}

function parseAudit(value: string): AttentionTransitionAudit {
  return JSON.parse(value) as AttentionTransitionAudit;
}
