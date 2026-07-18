import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

type ProposalRow = {
  actions_json: string;
  id: string;
  skill_run_id: string;
  source_item_ids_json: string;
  status: string;
};

type ActionRow = {
  conversation_id: string;
  id: string;
  issue_id: number;
  project_id: string;
  result_json: string;
  status: string;
};

type EventRow = { action_id: string; event_type: string; payload_json: string };
type JsonObject = Record<string, unknown>;

const MIGRATED_EVENT = "action_proposal.migrated";
const MAPPED_EVENT = "action_proposal.action_mapped";

export const consolidatePiDecisionLayersMigration: SqlMigration = {
  id: "052_consolidate_pi_decision_layers",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    const existing = migratedEventKeys(sqlite);
    const proposals = sqlite.query<ProposalRow, []>(
      `select id, skill_run_id, source_item_ids_json, actions_json, status
       from pi_action_proposals order by created_at, id`
    ).all();
    for (const proposal of proposals) migrateProposal(sqlite, proposal, existing);
  }
};

function migrateProposal(sqlite: SQLiteDatabase, proposal: ProposalRow, existing: Set<string>): void {
  const parent = actionByID(sqlite, proposal.skill_run_id);
  if (parent) appendMappingEvent(sqlite, parent, proposal, MIGRATED_EVENT, "", existing);

  const actions = parseArray(proposal.actions_json);
  let changed = false;
  const mapped = actions.map((value) => {
    const candidate = objectValue(value);
    const actionID = cleanString(candidate.id);
    const child = linkedAction(sqlite, proposal.id, actionID, cleanString(candidate.pi_action_id));
    if (!child) return value;
    appendMappingEvent(sqlite, child, proposal, MAPPED_EVENT, actionID, existing);
    const next = { ...candidate };
    if (cleanString(next.pi_action_id) === "") {
      next.pi_action_id = child.id;
      changed = true;
    }
    if (cleanString(next.execution_status) === "") {
      next.execution_status = child.status;
      changed = true;
    }
    const result = objectValue(parseJSON(child.result_json));
    if (next.result === undefined && Object.keys(result).length > 0) {
      next.result = result;
      changed = true;
    }
    if (next.error === undefined && cleanString(result.error) !== "") {
      next.error = cleanString(result.error);
      changed = true;
    }
    return next;
  });
  if (changed) {
    sqlite.run(
      `update pi_action_proposals set actions_json=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') where id=?`,
      [JSON.stringify(mapped), proposal.id]
    );
  }
}

function linkedAction(
  sqlite: SQLiteDatabase,
  proposalID: string,
  proposalActionID: string,
  storedActionID: string
): ActionRow | null {
  if (storedActionID !== "") {
    const stored = actionByID(sqlite, storedActionID);
    if (stored) return stored;
  }
  if (proposalActionID === "") return null;
  return sqlite.query<ActionRow, [string]>(
    `select id, project_id, issue_id, conversation_id, status, result_json
     from pi_actions where idempotency_key=? order by created_at, id limit 1`
  ).get(`action-proposal:${proposalID}:${proposalActionID}`) ?? null;
}

function actionByID(sqlite: SQLiteDatabase, id: string): ActionRow | null {
  if (cleanString(id) === "") return null;
  return sqlite.query<ActionRow, [string]>(
    `select id, project_id, issue_id, conversation_id, status, result_json
     from pi_actions where id=?`
  ).get(id) ?? null;
}

function appendMappingEvent(
  sqlite: SQLiteDatabase,
  action: ActionRow,
  proposal: ProposalRow,
  eventType: string,
  proposalActionID: string,
  existing: Set<string>
): void {
  const key = eventKey(action.id, proposal.id, eventType, proposalActionID);
  if (existing.has(key)) return;
  const payload = {
    action_count: parseArray(proposal.actions_json).length,
    migration: "052_consolidate_pi_decision_layers",
    proposal_action_id: proposalActionID,
    proposal_id: proposal.id,
    proposal_ref: `proposal:${proposal.id}`,
    source_item_ids: parseArray(proposal.source_item_ids_json),
    status: proposal.status
  };
  sqlite.run(
    `insert into pi_action_events
      (action_id, project_id, issue_id, conversation_id, event_type, actor, decision,
       reason, payload_json, result_json, error, delegation_id, heartbeat_id, created_at)
     values (?, ?, ?, ?, ?, 'migration', ?, ?, ?, '{}', '', '', '',
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`,
    [
      action.id,
      action.project_id,
      action.issue_id,
      action.conversation_id,
      eventType,
      proposal.status,
      `mapped proposal ${proposal.id} to canonical Action audit`,
      JSON.stringify(payload)
    ]
  );
  existing.add(key);
}

function migratedEventKeys(sqlite: SQLiteDatabase): Set<string> {
  const rows = sqlite.query<EventRow, []>(
    `select action_id, event_type, payload_json from pi_action_events
     where event_type in ('${MIGRATED_EVENT}', '${MAPPED_EVENT}')`
  ).all();
  return new Set(rows.map((row) => {
    const payload = objectValue(parseJSON(row.payload_json));
    return eventKey(
      row.action_id,
      cleanString(payload.proposal_id),
      row.event_type,
      cleanString(payload.proposal_action_id)
    );
  }));
}

function eventKey(actionID: string, proposalID: string, eventType: string, proposalActionID: string): string {
  return `${actionID}\u0000${proposalID}\u0000${eventType}\u0000${proposalActionID}`;
}

function parseArray(value: string): unknown[] {
  const parsed = parseJSON(value);
  return Array.isArray(parsed) ? parsed : [];
}

function parseJSON(value: string): unknown {
  try { return JSON.parse(value || "null"); } catch { return null; }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
