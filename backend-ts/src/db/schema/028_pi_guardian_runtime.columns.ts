import type { Database as SQLiteDatabase } from "bun:sqlite";

export function ensureGuardianDecisionColumns(sqlite: SQLiteDatabase): void {
  addColumn(sqlite, "source_event_id", "text not null default ''");
  addColumn(sqlite, "source_event_sequence_id", "integer not null default 0");
  addColumn(sqlite, "run_group_id", "text not null default ''");
  addColumn(sqlite, "conversation_id", "text not null default ''");
  addColumn(sqlite, "risk_level", "text not null default 'low'");
  addColumn(sqlite, "requires_user", "integer not null default 0");
  addColumn(sqlite, "rationale", "text not null default ''");
  addColumn(sqlite, "evidence_json", "text not null default '[]'");
  addColumn(sqlite, "actions_json", "text not null default '[]'");
  addColumn(sqlite, "state", "text not null default 'proposed'");
  addColumn(sqlite, "lease_owner", "text not null default ''");
  addColumn(sqlite, "lease_expires_at", "text not null default ''");
  addColumn(sqlite, "cooldown_until", "text not null default ''");
  addColumn(sqlite, "pi_session_id", "text not null default ''");
  addColumn(sqlite, "raw_pi_text_ref", "text not null default ''");
}

export function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_guardian_decisions add column ${name} ${definition}`);
}

export function columns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_guardian_decisions)").all()
    .map((row: { name: string }) => row.name));
}

export function ensurePiActionGuardianColumns(sqlite: SQLiteDatabase): void {
  addPiActionColumn(sqlite, "guardian_decision_id", "text not null default ''");
  addPiActionColumn(sqlite, "idempotency_key", "text not null default ''");
  addPiActionColumn(sqlite, "lease_key", "text not null default ''");
  addPiActionColumn(sqlite, "lease_expires_at", "text not null default ''");
  addPiActionColumn(sqlite, "expected_state_json", "text not null default '{}'");
  addPiActionColumn(sqlite, "before_snapshot_json", "text not null default '{}'");
  addPiActionColumn(sqlite, "legacy_bypass_reason", "text not null default ''");
  sqlite.run(`update pi_actions set legacy_bypass_reason='pre_guardian_action'
    where guardian_decision_id='' and legacy_bypass_reason=''`);
  sqlite.run(`create unique index if not exists ux_pi_actions_idempotency_key
    on pi_actions(idempotency_key) where idempotency_key<>''`);
  sqlite.run(`create index if not exists idx_pi_actions_guardian_decision
    on pi_actions(guardian_decision_id)`);
  sqlite.run(`create index if not exists idx_pi_actions_lease_key
    on pi_actions(lease_key, status, lease_expires_at)`);
}

export function addPiActionColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (piActionColumns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_actions add column ${name} ${definition}`);
}

export function piActionColumns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_actions)").all()
    .map((row: { name: string }) => row.name));
}
