import type { RunnerDatabase } from "../../database.ts";
import {
  cleanString,
  jsonArray,
  objectArray,
  requiredString,
  stringList,
  type JsonObject
} from "../intakeRunSupport.ts";
import { optionalString, requiredString as requiredRowString } from "./common.ts";
import {
  normalizeActionProposalActions,
  normalizedConfidence,
  type ActionProposalAction
} from "./actionProposalValidation.ts";

export type ActionProposalStatus = "approved" | "proposed" | "rejected";

export type ActionProposalInput = {
  actions: unknown[];
  approved_by?: string;
  confidence?: number;
  decided_by?: string;
  decision_reason?: string;
  evidence_refs?: unknown[];
  id?: string;
  skill_run_id: string;
  source_item_ids: unknown[];
  status?: string;
  summary: string;
  target_hints?: unknown[];
};

export type ActionProposalRecord = {
  actions: ActionProposalAction[];
  actions_json: string;
  approved_by: string;
  confidence: number;
  created_at: string;
  decided_by: string;
  decision_reason: string;
  evidence_refs: string[];
  evidence_refs_json: string;
  id: string;
  skill_run_id: string;
  source_item_ids: string[];
  source_item_ids_json: string;
  status: ActionProposalStatus;
  summary: string;
  target_hints: JsonObject[];
  target_hints_json: string;
  updated_at: string;
};

export type ActionProposalFilter = {
  skillRunId?: string;
  sourceItemId?: string;
  status?: string;
};

const TABLE = "pi_action_proposals";
const COLUMNS = `id, skill_run_id, source_item_ids_json, summary, actions_json,
  evidence_refs_json, target_hints_json, confidence, status, decision_reason,
  decided_by, approved_by, created_at, updated_at`;

export function createActionProposal(
  db: RunnerDatabase,
  input: ActionProposalInput,
  timestamp = new Date()
): ActionProposalRecord {
  const record = normalizeCreate(input, timestamp);
  const existing = getActionProposal(db, record.id);
  if (existing) return existing;
  db.sqlite.run(`insert into ${TABLE} (${COLUMNS}) values (${placeholders(14)})`, [
    record.id, record.skill_run_id, record.source_item_ids_json, record.summary,
    record.actions_json, record.evidence_refs_json, record.target_hints_json,
    record.confidence, record.status, record.decision_reason, record.decided_by,
    record.approved_by, record.created_at, record.updated_at
  ]);
  return requireActionProposal(db, record.id);
}

export function getActionProposal(db: RunnerDatabase, id: string): ActionProposalRecord | null {
  const key = cleanString(id);
  if (key === "") return null;
  const row = db.sqlite.query<Record<string, unknown>, [string]>(
    `select ${COLUMNS} from ${TABLE} where id=?`
  ).get(key);
  return row ? mapActionProposal(row) : null;
}

export function listActionProposals(
  db: RunnerDatabase,
  filter: ActionProposalFilter = {}
): ActionProposalRecord[] {
  const query = listQuery(filter);
  const records = db.sqlite.query<Record<string, unknown>, string[]>(
    `select ${COLUMNS} from ${TABLE}${query.where} order by created_at desc, id desc`
  ).all(...query.args).map(mapActionProposal);
  const sourceItemID = cleanString(filter.sourceItemId);
  return sourceItemID === "" ? records : records.filter((item) => item.source_item_ids.includes(sourceItemID));
}

export function approveActionProposal(
  db: RunnerDatabase,
  id: string,
  actor = "user"
): ActionProposalRecord {
  return updateProposalDecision(db, id, "approved", cleanString(actor) || "user", "approved_by");
}

export function rejectActionProposal(
  db: RunnerDatabase,
  id: string,
  actor = "user",
  reason = ""
): ActionProposalRecord {
  return updateProposalDecision(db, id, "rejected", cleanString(actor) || "user", "decided_by", reason);
}

function normalizeCreate(input: ActionProposalInput, timestamp: Date): ActionProposalRecord {
  const evidenceRefs = stringList(input.evidence_refs);
  const targetHints = objectArray(input.target_hints);
  const actions = normalizeActionProposalActions(input.actions, { evidenceRefs, targetHints });
  return {
    actions,
    actions_json: JSON.stringify(actions),
    approved_by: cleanString(input.approved_by),
    confidence: normalizedConfidence(input.confidence),
    created_at: timestamp.toISOString(),
    decided_by: cleanString(input.decided_by),
    decision_reason: cleanString(input.decision_reason),
    evidence_refs: evidenceRefs,
    evidence_refs_json: JSON.stringify(evidenceRefs),
    id: proposalID(input.id),
    skill_run_id: requiredString(input.skill_run_id, "skill_run_id"),
    source_item_ids: sourceItemIDs(input.source_item_ids),
    source_item_ids_json: JSON.stringify(sourceItemIDs(input.source_item_ids)),
    status: proposalStatus(input.status),
    summary: requiredString(input.summary, "summary"),
    target_hints: targetHints,
    target_hints_json: JSON.stringify(targetHints),
    updated_at: timestamp.toISOString()
  };
}

function updateProposalDecision(
  db: RunnerDatabase,
  id: string,
  status: ActionProposalStatus,
  actor: string,
  actorColumn: "approved_by" | "decided_by",
  reason = ""
): ActionProposalRecord {
  const current = requireActionProposal(db, id);
  const patch = actorColumn === "approved_by" ? "approved_by=?" : "decided_by=?";
  db.sqlite.run(`update ${TABLE} set status=?, ${patch}, decision_reason=?, updated_at=? where id=?`, [
    status, actor, cleanString(reason), new Date().toISOString(), current.id
  ]);
  return requireActionProposal(db, current.id);
}

function mapActionProposal(row: Record<string, unknown>): ActionProposalRecord {
  const actions = normalizeActionProposalActions(jsonArray(row.actions_json));
  return {
    actions,
    actions_json: optionalString(row.actions_json) || "[]",
    approved_by: optionalString(row.approved_by),
    confidence: normalizedConfidence(row.confidence),
    created_at: requiredRowString(row.created_at, "pi_action_proposals.created_at"),
    decided_by: optionalString(row.decided_by),
    decision_reason: optionalString(row.decision_reason),
    evidence_refs: stringList(jsonArray(row.evidence_refs_json)),
    evidence_refs_json: optionalString(row.evidence_refs_json) || "[]",
    id: requiredRowString(row.id, "pi_action_proposals.id"),
    skill_run_id: optionalString(row.skill_run_id),
    source_item_ids: stringList(jsonArray(row.source_item_ids_json)),
    source_item_ids_json: optionalString(row.source_item_ids_json) || "[]",
    status: proposalStatus(row.status),
    summary: optionalString(row.summary),
    target_hints: objectArray(jsonArray(row.target_hints_json)),
    target_hints_json: optionalString(row.target_hints_json) || "[]",
    updated_at: requiredRowString(row.updated_at, "pi_action_proposals.updated_at")
  };
}

function listQuery(filter: ActionProposalFilter): { args: string[]; where: string } {
  const clauses: string[] = [];
  const args: string[] = [];
  addClause(clauses, args, "status=?", filter.status);
  addClause(clauses, args, "skill_run_id=?", filter.skillRunId);
  return { args, where: clauses.length > 0 ? ` where ${clauses.join(" and ")}` : "" };
}

function addClause(clauses: string[], args: string[], clause: string, value: unknown): void {
  const text = cleanString(value);
  if (text === "") return;
  clauses.push(clause);
  args.push(text);
}

function requireActionProposal(db: RunnerDatabase, id: string): ActionProposalRecord {
  const proposal = getActionProposal(db, id);
  if (!proposal) throw new Error("action proposal not found");
  return proposal;
}

function proposalStatus(value: unknown): ActionProposalStatus {
  const status = cleanString(value);
  return status === "approved" || status === "rejected" ? status : "proposed";
}

function proposalID(value: unknown): string {
  const id = cleanString(value);
  return id || `action-proposal-${crypto.randomUUID()}`;
}

function sourceItemIDs(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : [];
  const items = [...new Set(raw.map(sourceItemID).filter(Boolean))];
  if (items.length === 0) throw new Error("source_item_ids is required");
  return items;
}

function sourceItemID(value: unknown): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return cleanString(value);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
