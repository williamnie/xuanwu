import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

type CountRow = { count: number };
type ProposalRow = { actions_json: string; id: string; source_item_ids_json: string; status: string };

export const PI_DECISION_CONSOLIDATION_CONTRACT = "xw.pi-decision-consolidation.v1" as const;

export function auditPiDecisionConsolidation(input: { dbPath: string; reportPath: string }): Record<string, unknown> {
  const dbPath = resolve(required(input.dbPath, "dbPath"));
  const reportPath = resolve(required(input.reportPath, "reportPath"));
  if (dbPath === reportPath) throw new Error("database and report paths must be different");
  const sqlite = new Database(dbPath, { readonly: true, strict: true });
  try {
    const counts = {
      active_internal_actions: count(sqlite, `select count(*) as count from pi_actions
        where status in ('candidate','pending','approved','changes_requested','snoozed')`),
      active_provider_approvals: count(sqlite, `select count(*) as count from pi_approval_requests
        where status in ('pending','delivered','resolve_failed')`),
      actions: count(sqlite, "select count(*) as count from pi_actions"),
      action_events: count(sqlite, "select count(*) as count from pi_action_events"),
      approvals: count(sqlite, "select count(*) as count from pi_approval_requests"),
      proposed_action_proposals: count(sqlite, "select count(*) as count from pi_action_proposals where status='proposed'"),
      proposals: count(sqlite, "select count(*) as count from pi_action_proposals")
    };
    const gaps = {
      actions_without_audit_events: count(sqlite, `select count(*) as count from pi_actions a
        where not exists (select 1 from pi_action_events e where e.action_id=a.id)`),
      approved_proposal_actions_without_action_link: approvedProposalActionLinkGaps(sqlite),
      proposals_without_attention_source: proposalSourceGaps(sqlite)
    };
    const dataBlockers = [
      counts.active_internal_actions > 0 ? `${counts.active_internal_actions} active internal Action rows remain` : "",
      counts.active_provider_approvals > 0 ? `${counts.active_provider_approvals} active provider Approval rows remain` : "",
      counts.proposed_action_proposals > 0 ? `${counts.proposed_action_proposals} undecided Proposal rows remain` : "",
      gaps.actions_without_audit_events > 0 ? `${gaps.actions_without_audit_events} Action rows have no audit event` : "",
      gaps.approved_proposal_actions_without_action_link > 0 ? `${gaps.approved_proposal_actions_without_action_link} approved Proposal actions lack canonical Action links` : "",
      gaps.proposals_without_attention_source > 0 ? `${gaps.proposals_without_attention_source} Proposals lack a readable Attention source` : ""
    ].filter(Boolean);
    const report = {
      contract: PI_DECISION_CONSOLIDATION_CONTRACT,
      counts,
      data_gate_passed: dataBlockers.length === 0,
      db_path: dbPath,
      delete_gate: {
        blockers: [
          ...dataBlockers,
          "one formal release of zero legacy mutation-route consumers is required",
          "fresh backup, isolated restore, retained rollback artifact, and exact non-LLM G7 approval are required",
          "physical table/index deletion remains owned by P11.09"
        ],
        destructive_delete_authorized: false
      },
      gaps,
      generated_at: new Date().toISOString(),
      mapping: {
        internal_action: "pi_actions -> unified Attention approval_required projection; pi_action_events remains audit authority",
        proposal: "pi_action_proposals -> related proposal ref; approved execution writes one pi_actions chain",
        provider_approval: "pi_approval_requests -> unified Attention approval_required projection; provider protocol remains acknowledgement authority"
      },
      operation: "attention.consolidation-audit",
      quick_check: scalarText(sqlite, "pragma quick_check")
    };
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  } finally {
    sqlite.close();
  }
}

function approvedProposalActionLinkGaps(sqlite: Database): number {
  let gaps = 0;
  for (const proposal of proposals(sqlite).filter((row) => row.status === "approved")) {
    for (const value of parseArray(proposal.actions_json)) {
      const action = objectValue(value);
      const linked = cleanString(action.pi_action_id);
      if (linked === "" || count(sqlite, "select count(*) as count from pi_actions where id=?", [linked]) === 0) gaps += 1;
    }
  }
  return gaps;
}

function proposalSourceGaps(sqlite: Database): number {
  let gaps = 0;
  for (const proposal of proposals(sqlite)) {
    const readable = parseArray(proposal.source_item_ids_json).some((value) => {
      const id = inboxItemID(cleanString(value));
      return id > 0 && count(sqlite, "select count(*) as count from attention_inbox_items where id=?", [id]) > 0;
    });
    if (!readable) gaps += 1;
  }
  return gaps;
}

function proposals(sqlite: Database): ProposalRow[] {
  return sqlite.query<ProposalRow, []>(
    "select id, source_item_ids_json, actions_json, status from pi_action_proposals"
  ).all();
}

function count(sqlite: Database, sql: string, params: Array<string | number> = []): number {
  return sqlite.query<CountRow, Array<string | number>>(sql).get(...params)?.count ?? 0;
}

function scalarText(sqlite: Database, sql: string): string {
  const row = sqlite.query<Record<string, unknown>, []>(sql).get();
  return row ? cleanString(Object.values(row)[0]) : "";
}

function inboxItemID(value: string): number {
  const match = /^(?:attention_inbox_item:)?(\d+)$/.exec(value.trim());
  const id = Number(match?.[1] ?? 0);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

function parseArray(value: string): unknown[] {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function required(value: string, name: string): string {
  const text = value?.trim() ?? "";
  if (text === "") throw new Error(`${name} is required`);
  return text;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : String(value ?? "").trim();
}
