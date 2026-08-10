import type { SqlMigration } from "../migrations.ts";

/** Exact, compact access path for connector diagnostics history. */
export const piActionEventConnectorTestIndexMigration: SqlMigration = {
  id: "077_pi_action_event_connector_test_index",
  sql: `
create index if not exists idx_pi_action_events_connector_test_history
  on pi_action_events(json_extract(payload_json, '$.connector_id'), id desc)
  where event_type='connector.tested' and json_valid(payload_json);
`
};
