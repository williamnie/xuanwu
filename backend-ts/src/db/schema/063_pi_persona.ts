import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";
import { ensureDefaultPiPersona } from "../defaultPiPersona.ts";

export const piPersonaMigration: SqlMigration = {
  id: "063_pi_persona",
  sql: "",
  apply(sqlite: SQLiteDatabase): void {
    sqlite.run(`
      create table if not exists pi_persona (
        supervisor_id text primary key,
        enabled integer not null default 0 check(enabled in (0, 1)),
        personality text not null default '',
        communication_style text not null default '',
        verbosity text not null default 'adaptive' check(verbosity in ('adaptive', 'concise', 'detailed')),
        language_mode text not null default 'system' check(language_mode in ('system', 'follow_user')),
        revision integer not null default 0 check(revision >= 0),
        created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        foreign key(supervisor_id) references pi_agents(id) on delete cascade
      )
    `);
    ensureDefaultPiPersona({ readonly: false, sqlite });
  }
};
