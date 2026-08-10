import type { SqlMigration } from "../migrations.ts";

/** Durable idempotency for canonical IM envelopes stored in sync_outbox.payload_json. */
export const imOutboundDedupeMigration: SqlMigration = {
  id: "074_im_outbound_dedupe",
  sql: `
create unique index if not exists ux_sync_outbox_im_dedupe
  on sync_outbox(source, operation_kind, dedupe_key)
  where operation_kind='im_reply' and dedupe_key<>'';
`
};
