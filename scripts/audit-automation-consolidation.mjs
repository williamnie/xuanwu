#!/usr/bin/env bun
import { auditAutomationConsolidation } from "../backend-ts/src/domain/automation/consolidationAudit.ts";

const args = parseArgs(process.argv.slice(2));
if (!args.db || !args.report) usage("--db <runner.db> and --report <report.json> are required");

const report = auditAutomationConsolidation({ dbPath: args.db, reportPath: args.report });
console.log(JSON.stringify(report, null, 2));

function parseArgs(argv) {
  const values = { db: "", report: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--db") values.db = argv[++index] || "";
    else if (arg === "--report") values.report = argv[++index] || "";
    else usage(`unknown argument: ${arg}`);
  }
  return values;
}

function usage(message) {
  console.error(message);
  console.error("usage: audit-automation-consolidation.mjs --db <runner.db> --report <report.json>");
  process.exit(2);
}
