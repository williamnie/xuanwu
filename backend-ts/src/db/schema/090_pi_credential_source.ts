import type { SqlMigration } from "../migrations.ts";
export const piCredentialSourceMigration: SqlMigration = {
  id: "090_pi_credential_source",
  sql: "alter table pi_agents add column credential_source text not null default 'stored' check (credential_source in ('stored', 'codex_login'));"
};
