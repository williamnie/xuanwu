#!/usr/bin/env bun
import { openDatabase } from "../backend-ts/src/db/database.ts";
import { migrateLegacyCompletionWatches } from "../backend-ts/src/db/repositories/automationWatches.ts";

const args = parseArgs(process.argv.slice(2));
if (!args.db) fail("usage: migrate-watch-automations.mjs --db <runner.db> [--apply --actor <id> --correlation <id>]");
if (args.apply && (!args.actor || !args.correlation)) {
  fail("--apply requires --actor and --correlation");
}

const now = new Date().toISOString();
const database = await openDatabase(args.apply ? { dbPath: args.db } : { readonlyImportPath: args.db });
try {
  const result = migrateLegacyCompletionWatches(database, {
    audit: {
      actor_id: args.actor || "watch-migration-dry-run",
      actor_kind: "runner",
      correlation_id: args.correlation || `dry-run:${now}`,
      event_id: `watch-migration:${args.correlation || now}`,
      gate: {
        authority: "deterministic_policy",
        decision: "allow",
        policy_ref: "automation-watch-migration:v1"
      },
      occurred_at: now,
      reason: args.apply ? "approved legacy completion watch shadow migration" : "read-only migration preview"
    },
    dryRun: !args.apply
  });
  console.log(JSON.stringify({ applied: args.apply, database: args.db, ...result }, null, 2));
} finally {
  database.close();
}

function parseArgs(argv) {
  const values = { actor: "", apply: false, correlation: "", db: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--apply") values.apply = true;
    else if (arg === "--db") values.db = argv[++index] || "";
    else if (arg === "--actor") values.actor = argv[++index] || "";
    else if (arg === "--correlation") values.correlation = argv[++index] || "";
    else fail(`unknown argument: ${arg}`);
  }
  return values;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}
