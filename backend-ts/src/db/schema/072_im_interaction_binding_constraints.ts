import type { Database as SQLiteDatabase } from "bun:sqlite";
import type { SqlMigration } from "../migrations.ts";

/** Add fail-closed actor/action columns for databases that already applied 071. */
export const imInteractionBindingConstraintsMigration: SqlMigration = {
  id: "072_im_interaction_binding_constraints",
  sql: "",
  apply(sqlite) {
    addColumn(sqlite, "actions_json", "text not null default '[]'");
    addColumn(sqlite, "actor_id", "text not null default ''");
    addColumn(sqlite, "actor_open_id", "text not null default ''");
    return undefined;
  }
};

function addColumn(sqlite: SQLiteDatabase, name: string, definition: string): void {
  const exists = sqlite.query<{ count: number }, [string]>(
    "select count(*) as count from pragma_table_info('im_interaction_bindings') where name=?"
  ).get(name)?.count === 1;
  if (!exists) sqlite.run(`alter table im_interaction_bindings add column ${name} ${definition}`);
}
