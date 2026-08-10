import type { SqlMigration } from "../migrations.ts";
import { backfillImProjectSelections } from "./071_im_interaction_bindings.ts";

/**
 * Audited marker migration: rerun the idempotent Feishu → im_project_selections
 * backfill for databases that applied 071 before the backfill existed or that
 * accumulated legacy rows between releases. Insert-only; never rewrites or
 * deletes rows. Parity is asserted by the migration tests.
 */
export const imProjectSelectionsBackfillMigration: SqlMigration = {
  id: "071a_im_project_selections_backfill",
  sql: "",
  apply(sqlite) {
    backfillImProjectSelections(sqlite);
    return undefined;
  }
};
