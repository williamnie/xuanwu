#!/usr/bin/env bun
/**
 * Inbox replay tooling (ADR-XW-0098 TD-1 §10).
 *
 *   bun scripts/inbox-replay.ts convert --input <zhuque dingtalk jsonl> --self-id <id> [--self-name <name>] --out <dir>
 *   bun scripts/inbox-replay.ts sheet   --dir <dir>          # (re)write labels.md, keeping filled labels
 *   bun scripts/inbox-replay.ts collect --dir <dir>          # parse labels.md → labels.jsonl + summary
 *
 * All outputs contain private messages: keep <dir> outside the repository.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateSourceEventLine, type SourceEventLine } from "../src/pi/inbox/sourceEvent.ts";
import { convertZhuqueRows, type ZhuqueSourceRow } from "../src/pi/inbox/replay/zhuqueExport.ts";
import { cutReplaySegments } from "../src/pi/inbox/replay/segments.ts";
import { parseLabelSheet, renderLabelSheet, type SegmentLabel } from "../src/pi/inbox/replay/labelSheet.ts";

const EVENTS_FILE = "events.jsonl";
const SHEET_FILE = "labels.md";
const LABELS_FILE = "labels.jsonl";
const REPO_ROOT = resolve(import.meta.dir, "../..");

function main(argv: string[]): void {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === "convert") return convert(args);
  if (command === "sheet") return sheet(args);
  if (command === "collect") return collect(args);
  fail("usage: inbox-replay.ts convert|sheet|collect (see file header)");
}

function convert(args: Map<string, string[]>): void {
  const input = required(args, "input");
  const out = outputDir(required(args, "out"));
  const rows = readJsonl(input) as ZhuqueSourceRow[];
  const { events, skipped } = convertZhuqueRows(rows, {
    selfIds: args.get("self-id") ?? [],
    selfNames: args.get("self-name") ?? []
  });
  for (const event of events) {
    const check = validateSourceEventLine(event);
    if (!check.ok) fail(`converted event ${event.id} is invalid: ${check.reason}`);
  }
  writeFileSync(join(out, EVENTS_FILE), events.map((event) => JSON.stringify(event)).join("\n") + "\n", { mode: 0o600 });
  const chats = new Set(events.map((event) => event.chat.key));
  const self = events.filter((event) => event.is_self).length;
  console.log(`events: ${events.length} (self ${self}, others ${events.length - self}), chats: ${chats.size}, skipped: ${skipped.length}`);
  for (const item of skipped) console.log(`  skipped ${item.external_id || "(no id)"}: ${item.reason}`);
  console.log(`wrote ${join(out, EVENTS_FILE)}`);
  sheet(new Map([["dir", [out]]]));
}

function sheet(args: Map<string, string[]>): void {
  const dir = outputDir(required(args, "dir"));
  const segments = cutReplaySegments(readEvents(dir));
  const sheetPath = join(dir, SHEET_FILE);
  const existing = new Map<string, SegmentLabel>();
  if (existsSync(sheetPath)) {
    for (const label of parseLabelSheet(readFileSync(sheetPath, "utf8"), segments).labels) existing.set(label.segment_id, label);
  }
  writeFileSync(sheetPath, renderLabelSheet(segments, { existing }), { mode: 0o600 });
  console.log(`segments: ${segments.length}, already labelled: ${existing.size}`);
  console.log(`edit ${sheetPath}, then run: bun scripts/inbox-replay.ts collect --dir ${dir}`);
}

function collect(args: Map<string, string[]>): void {
  const dir = outputDir(required(args, "dir"));
  const segments = cutReplaySegments(readEvents(dir));
  const parsed = parseLabelSheet(readFileSync(join(dir, SHEET_FILE), "utf8"), segments);
  writeFileSync(join(dir, LABELS_FILE), parsed.labels.map((label) => JSON.stringify(label)).join("\n") + "\n", { mode: 0o600 });
  const counts = new Map<string, number>();
  for (const label of parsed.labels) counts.set(label.conclusion, (counts.get(label.conclusion) ?? 0) + 1);
  console.log(`labelled ${parsed.labels.length}/${segments.length}, unlabelled ${parsed.unlabeled.length}, errors ${parsed.errors.length}`);
  for (const [conclusion, count] of [...counts].sort()) console.log(`  ${conclusion}: ${count}`);
  for (const error of parsed.errors) console.log(`  error ${error.segment_id}: ${error.message}`);
  console.log(`wrote ${join(dir, LABELS_FILE)}`);
  if (parsed.errors.length > 0) process.exitCode = 1;
}

function readEvents(dir: string): SourceEventLine[] {
  return readJsonl(join(dir, EVENTS_FILE)).map((line, index) => {
    const check = validateSourceEventLine(line);
    if (!check.ok) fail(`${EVENTS_FILE} line ${index + 1}: ${check.reason}`);
    return check.event;
  });
}

function readJsonl(path: string): unknown[] {
  return readFileSync(path, "utf8").split("\n").filter((line) => line.trim() !== "").map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      return fail(`${path} line ${index + 1}: not JSON`);
    }
  });
}

function outputDir(path: string): string {
  const dir = resolve(path);
  if (dir === REPO_ROOT || dir.startsWith(`${REPO_ROOT}/`)) fail(`refusing to write private replay data inside the repository: ${dir}`);
  mkdirSync(dir, { mode: 0o700, recursive: true });
  return dir;
}

function parseArgs(argv: string[]): Map<string, string[]> {
  const args = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!flag.startsWith("--")) fail(`unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) fail(`missing value for ${flag}`);
    args.set(flag.slice(2), [...(args.get(flag.slice(2)) ?? []), value]);
    index++;
  }
  return args;
}

function required(args: Map<string, string[]>, name: string): string {
  const value = args.get(name)?.[0];
  if (!value) fail(`--${name} is required`);
  return value;
}

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

main(process.argv.slice(2));
