import type { SqlMigration } from "../migrations.ts";
import { NORMALIZED_RUN_EVENT_CONTRACT } from "../../providers/types.ts";

export const ISSUE_EVENT_QUERY_INDEX_NAMES = [
  "idx_issue_events_type_id",
  "idx_issue_events_run_event_v1_id_desc"
] as const;

/** Global structured-event lookup plus the exact normalized Run Event status path. */
export const issueEventQueryIndexesMigration: SqlMigration = {
  id: "075_issue_event_query_indexes",
  sql: `
create index if not exists idx_issue_events_type_id
  on issue_events(type, id);

create index if not exists idx_issue_events_run_event_v1_id_desc
  on issue_events(id desc)
  where type='issue.log'
    and json_valid(payload)
    and json_extract(payload, '$.run_event.contract')='${NORMALIZED_RUN_EVENT_CONTRACT}';
`
};
