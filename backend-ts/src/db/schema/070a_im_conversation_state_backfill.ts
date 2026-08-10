import type { SqlMigration } from "../migrations.ts";
import { backfillImConversationState } from "./070_im_conversation_state.ts";

/**
 * Audited marker migration: rerun the idempotent Feishu → im_conversation_state
 * backfill for databases that applied 070 before the backfill existed, or that
 * accumulated legacy rows between releases. Insert-only; never rewrites or
 * deletes rows. Row-count parity is asserted by the migration tests.
 */
export const imConversationStateBackfillMigration: SqlMigration = {
  id: "070a_im_conversation_state_backfill",
  sql: "",
  apply(sqlite) {
    backfillImConversationState(sqlite);
    return undefined;
  }
};
