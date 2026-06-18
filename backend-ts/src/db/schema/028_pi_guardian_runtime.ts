import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const piGuardianRuntimeMigration: SqlMigration = {
  id: "028_pi_guardian_runtime",
  sql: `
create table if not exists pi_guardian_event_inbox (
  sequence_id integer primary key autoincrement,
  id text not null unique,
  source text not null default '',
  source_event_id text not null default '',
  source_sequence integer not null default 0,
  event_type text not null,
  project_id text not null default '',
  issue_id integer not null default 0,
  run_group_id text not null default '',
  conversation_id text not null default '',
  severity text not null default 'info',
  normalized_payload_json text not null default '{}',
  redaction_profile text not null default 'prompt',
  status text not null default 'pending',
  lease_owner text not null default '',
  lease_expires_at text not null default '',
  consumed_at text not null default '',
  idempotency_key text not null,
  error text not null default '',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists ux_pi_guardian_event_id
  on pi_guardian_event_inbox(id);

create unique index if not exists ux_pi_guardian_event_source
  on pi_guardian_event_inbox(source, source_event_id, idempotency_key);

create index if not exists idx_pi_guardian_event_pending
  on pi_guardian_event_inbox(status, severity, sequence_id);

create index if not exists idx_pi_guardian_event_issue
  on pi_guardian_event_inbox(project_id, issue_id, sequence_id desc);

create index if not exists idx_pi_guardian_event_group
  on pi_guardian_event_inbox(run_group_id, sequence_id desc);

create table if not exists pi_guardian_decisions (
  id text primary key,
  idempotency_key text not null,
  source_event_id text not null default '',
  source_event_sequence_id integer not null default 0,
  decision_kind text not null,
  authority text not null default 'policy',
  project_id text not null default '',
  issue_id integer not null default 0,
  run_group_id text not null default '',
  conversation_id text not null default '',
  decision text not null,
  risk_level text not null default 'low',
  requires_user integer not null default 0,
  rationale text not null default '',
  evidence_json text not null default '[]',
  actions_json text not null default '[]',
  state text not null default 'proposed', -- proposed | approved | deferred | executing | completed | failed | skipped | superseded
  lease_owner text not null default '',
  lease_expires_at text not null default '',
  cooldown_until text not null default '',
  pi_session_id text not null default '',
  raw_pi_text_ref text not null default '',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists ux_pi_guardian_decisions_key
  on pi_guardian_decisions(idempotency_key);

create table if not exists pi_recovery_attempts (
  id text primary key, idempotency_key text not null, source_decision_id text not null default '',
  project_id text not null default '', issue_id integer not null, run_id text not null default '',
  session_id text not null default '', provider_session_id text not null default '',
  provider_turn_id text not null default '', expected_provider_turn_id text not null default '',
  result_provider_turn_id text not null default '', run_group_id text not null default '',
  diagnosis_code text not null, action_type text not null,
  status text not null default 'planned', executing_started_at text not null default '',
  hard_timeout_at text not null default '', progress_detected integer not null default 0,
  progress_reasons_json text not null default '[]', ignored_reasons_json text not null default '[]',
  budget_window_started_at text not null, before_snapshot_json text not null default '{}',
  after_snapshot_json text not null default '{}', error text not null default '',
  created_at text not null, updated_at text not null
);
create unique index if not exists ux_pi_recovery_attempts_key on pi_recovery_attempts(idempotency_key);
create index if not exists idx_pi_recovery_attempts_issue_window on pi_recovery_attempts(issue_id, created_at, action_type, status);
create index if not exists idx_pi_recovery_attempts_session_window on pi_recovery_attempts(session_id, created_at, action_type, status);
create index if not exists idx_pi_recovery_attempts_project_window on pi_recovery_attempts(project_id, created_at, action_type, status);
create index if not exists idx_pi_recovery_attempts_decision on pi_recovery_attempts(source_decision_id);

create index if not exists idx_pi_guardian_decisions_issue
  on pi_guardian_decisions(project_id, issue_id, decision_kind, state, created_at desc);

create index if not exists idx_pi_guardian_decisions_group
  on pi_guardian_decisions(run_group_id, decision_kind, state, created_at desc);

create table if not exists pi_run_groups (
  id text primary key,
  project_id text not null,
  origin_conversation_id text not null default '',
  source_message_id text not null default '',
  source_action_id text not null default '',
  source_event_id text not null default '',
  source_event_sequence_id integer not null default 0,
  user_phrase text not null default '',
  expected_issue_count integer not null default 0,
  status text not null default 'active',
  digest_policy_json text not null default '{}',
  deadline_at text not null default '',
  max_interval_minutes integer not null default 120,
  last_digest_at text not null default '',
  digest_flush_sequence integer not null default 0,
  completed_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_run_groups_project_status
  on pi_run_groups(project_id, status, created_at desc);

create index if not exists idx_pi_run_groups_deadline
  on pi_run_groups(status, deadline_at);

create table if not exists pi_run_group_items (
  run_group_id text not null,
  issue_id integer not null,
  position integer not null default 0,
  issue_title_snapshot text not null default '',
  enqueue_action_id text not null default '',
  enqueue_status text not null default 'pending',
  status text not null default 'active',
  final_issue_status text not null default '',
  report_status text not null default 'active',
  report_bucket text not null default 'active',
  report_reason text not null default '',
  last_intent_id text not null default '',
  joined_at text not null,
  reportable_at text not null default '',
  completed_at text not null default '',
  updated_at text not null,
  primary key (run_group_id, issue_id),
  foreign key(run_group_id) references pi_run_groups(id) on delete cascade,
  foreign key(issue_id) references issues(id) on delete cascade
);

create index if not exists idx_pi_run_group_items_issue
  on pi_run_group_items(issue_id, run_group_id);

create index if not exists idx_pi_run_group_items_status
  on pi_run_group_items(run_group_id, status, report_status, final_issue_status, enqueue_status);

create table if not exists pi_notification_preferences (
  id text primary key,
  project_id text not null default '',
  conversation_id text not null default '',
  run_group_id text not null default '',
  scope text not null,
  policy_kind text not null default 'user_preference',
  mode text not null default 'normal',
  notify_on_json text not null default '[]',
  digest_policy_json text not null default '{}',
  source_message_id text not null default '',
  source_event_id text not null default '',
  source_event_sequence_id integer not null default 0,
  confirmation_text text not null default '',
  effective_after_sequence integer not null default 0,
  effective_after_time text not null default '',
  version integer not null default 1,
  status text not null default 'active',
  expires_at text not null default '',
  created_at text not null,
  updated_at text not null
);

create index if not exists idx_pi_notification_preferences_scope
  on pi_notification_preferences(scope, project_id, conversation_id, run_group_id, status, version desc);

create index if not exists idx_pi_notification_preferences_effective
  on pi_notification_preferences(status, effective_after_sequence, expires_at);

create table if not exists pi_notification_intents (
  id text primary key,
  source_event_id text not null default '',
  source_event_sequence_id integer not null default 0,
  source_event_type text not null default '',
  idempotency_key text not null,
  project_id text not null default '',
  issue_id integer not null default 0,
  run_group_id text not null default '',
  conversation_id text not null default '',
  target_channel text not null default '',
  target_chat_id text not null default '',
  target_thread_id text not null default '',
  target_message_id text not null default '',
  kind text not null,
  severity text not null default 'info',
  requires_user integer not null default 0,
  decision text not null default 'aggregate',
  state text not null default 'pending',
  summary text not null default '',
  payload_json text not null default '{}',
  preference_id text not null default '',
  flush_reason text not null default '',
  flush_sequence integer not null default 0,
  flush_bucket text not null default '',
  flush_after_at text not null default '',
  ready_at text not null default '',
  sent_outbox_id integer not null default 0,
  sent_at text not null default '',
  ack_required integer not null default 0,
  ack_status text not null default '',
  ack_deadline_at text not null default '',
  ack_retry_count integer not null default 0,
  next_ack_retry_at text not null default '',
  error text not null default '',
  created_at text not null,
  updated_at text not null
);

create unique index if not exists ux_pi_notification_intent_key
  on pi_notification_intents(idempotency_key);

create index if not exists idx_pi_notification_intents_flush
  on pi_notification_intents(state, decision, flush_after_at, severity);

create index if not exists idx_pi_notification_intents_group
  on pi_notification_intents(run_group_id, state, created_at);

create index if not exists idx_pi_notification_intents_issue
  on pi_notification_intents(issue_id, kind, state, created_at desc);
`,
  apply(sqlite) {
    sqlite.run(this.sql);
    ensureGuardianDecisionColumns(sqlite);
    ensurePiActionGuardianColumns(sqlite);
  }
};

function ensureGuardianDecisionColumns(sqlite: SQLiteDatabase): void {
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

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (columns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_guardian_decisions add column ${name} ${definition}`);
}

function columns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_guardian_decisions)").all()
    .map((row: { name: string }) => row.name));
}

function ensurePiActionGuardianColumns(sqlite: SQLiteDatabase): void {
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

function addPiActionColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  if (piActionColumns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_actions add column ${name} ${definition}`);
}

function piActionColumns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_actions)").all()
    .map((row: { name: string }) => row.name));
}
