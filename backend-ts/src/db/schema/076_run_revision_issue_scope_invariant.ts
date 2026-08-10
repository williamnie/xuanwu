import type { SqlMigration } from "../migrations.ts";
import { findRunRevisionIssueScopeMismatches } from "../runRevisionScopeAudit.ts";

/** Refuse the scoped-read behavior change when historical lifecycle events are cross-Issue. */
export const runRevisionIssueScopeInvariantMigration: SqlMigration = {
  id: "076_run_revision_issue_scope_invariant",
  sql: "",
  apply(sqlite) {
    const mismatches = findRunRevisionIssueScopeMismatches(sqlite);
    if (mismatches.length > 0) {
      throw new Error(`Run revision Issue scope invariant failed: ${JSON.stringify(mismatches)}`);
    }
  }
};
