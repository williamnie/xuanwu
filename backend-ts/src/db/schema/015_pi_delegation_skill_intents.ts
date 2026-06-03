import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

export const piDelegationSkillIntentsMigration: SqlMigration = {
  id: "015_pi_delegation_skill_intents",
  sql: "",
  apply(sqlite) {
    addDelegationColumn(sqlite, "allowed_skill_intents_json", "'[]'");
  }
};

function addDelegationColumn(sqlite: SQLiteDatabase, name: string, fallback: string): void {
  if (delegationColumns(sqlite).has(name)) return;
  sqlite.run(`alter table pi_delegations add column ${name} text not null default ${fallback}`);
}

function delegationColumns(sqlite: SQLiteDatabase): Set<string> {
  return new Set(sqlite.query<{ name: string }, []>("pragma table_info(pi_delegations)").all().map((row) => row.name));
}
