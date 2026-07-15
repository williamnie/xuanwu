#!/usr/bin/env bun
import { resolve } from "node:path";
import { auditIssueEventsStorage, compareIssueEventsStorage } from "../src/xuanwu/issueEventsStorageAudit.ts";

const options = parseArguments(process.argv.slice(2));
if (!options.db) usage("--db is required");

const current = auditIssueEventsStorage(resolve(options.db), {
  duplicateLimit: options.top,
  issueLimit: options.top
});
const output = options.baseline ? {
  current,
  baseline: auditIssueEventsStorage(resolve(options.baseline), {
    duplicateLimit: options.top,
    issueLimit: options.top
  }),
  growth: undefined as ReturnType<typeof compareIssueEventsStorage> | undefined
} : { current };

if ("baseline" in output && output.baseline) {
  output.growth = compareIssueEventsStorage(output.baseline, output.current);
}
process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

type Arguments = { baseline?: string; db?: string; top?: number };

function parseArguments(args: string[]): Arguments {
  const parsed: Arguments = {};
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === "--help" || key === "-h") usage();
    const value = args[index + 1];
    if (!value || value.startsWith("--")) usage(`${key} requires a value`);
    if (key === "--db") parsed.db = value;
    else if (key === "--baseline") parsed.baseline = value;
    else if (key === "--top") parsed.top = positiveInteger(value, "--top");
    else usage(`unknown argument: ${key}`);
    index += 1;
  }
  return parsed;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 100) usage(`${label} must be from 1 to 100`);
  return parsed;
}

function usage(error?: string): never {
  if (error) process.stderr.write(`Error: ${error}\n\n`);
  process.stderr.write("Usage: bun run scripts/audit-issue-events.ts --db <readonly-snapshot.db> [--baseline <older-snapshot.db>] [--top 20]\n");
  process.exit(error ? 1 : 0);
}
