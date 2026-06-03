import type { SqlMigration } from "../migrations.ts";

export const piDelegationEnvelopeMigration: SqlMigration = {
  id: "012_pi_delegation_envelope",
  sql: "",
  apply(sqlite) {
    addDelegationColumn(sqlite, "scope_json", "'{}'");
    addDelegationColumn(sqlite, "starts_at", "''");
    addDelegationColumn(sqlite, "expires_at", "''");
    addDelegationColumn(sqlite, "allowed_actions_json", "'[]'");
    addDelegationColumn(sqlite, "forbidden_actions_json", "'[]'");
    addDelegationColumn(sqlite, "audit_source", "''");
    ensureDelegationStatusDefault(sqlite);
    sqlite.run(`
      create index if not exists idx_pi_delegations_active
        on pi_delegations(status, next_heartbeat_at, project_id)
    `);
    sqlite.run(`
      create index if not exists idx_pi_delegations_window
        on pi_delegations(project_id, status, starts_at, expires_at)
    `);
  }
};

function addDelegationColumn(sqlite: Parameters<NonNullable<SqlMigration["apply"]>>[0], name: string, fallback: string): void {
  if (delegationColumns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_delegations add column ${name} text not null default ${fallback}`);
}

function delegationColumns(sqlite: Parameters<NonNullable<SqlMigration["apply"]>>[0]): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_delegations)").all().map((row) => row.name));
}

function ensureDelegationStatusDefault(sqlite: Parameters<NonNullable<SqlMigration["apply"]>>[0]): void {
  if (columnDefault(sqlite, "status") === "'active'") return;
  sqlite.run("drop table if exists pi_delegations_012_rebuild");
  sqlite.run(`
    create table pi_delegations_012_rebuild (
      id text primary key,
      project_id text not null default '',
      title text not null default '',
      status text not null default 'active',
      intent_json text not null default '{}',
      authorization_json text not null default '{}',
      scope_json text not null default '{}',
      starts_at text not null default '',
      expires_at text not null default '',
      allowed_actions_json text not null default '[]',
      forbidden_actions_json text not null default '[]',
      audit_source text not null default '',
      next_heartbeat_at text not null default '',
      last_heartbeat_at text not null default '',
      created_at text not null,
      updated_at text not null
    )
  `);
  sqlite.run(`
    insert into pi_delegations_012_rebuild
    select id, project_id, title, coalesce(nullif(status, ''), 'active'), intent_json,
      authorization_json, scope_json, starts_at, expires_at, allowed_actions_json,
      forbidden_actions_json, audit_source, next_heartbeat_at, last_heartbeat_at,
      created_at, updated_at
    from pi_delegations
  `);
  sqlite.run("drop table pi_delegations");
  sqlite.run("alter table pi_delegations_012_rebuild rename to pi_delegations");
}

function columnDefault(sqlite: Parameters<NonNullable<SqlMigration["apply"]>>[0], name: string): string {
  const row = sqlite.query<{ dflt_value: string | null }, [string]>(
    "select dflt_value from pragma_table_info('pi_delegations') where name=?"
  ).get(name);
  return row?.dflt_value ?? "";
}
