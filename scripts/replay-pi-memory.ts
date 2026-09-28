#!/usr/bin/env bun
import { writeFileSync } from "node:fs";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join, dirname } from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { command, fixtureDriver, runMemoryReplay, REPLAY_CASES } from "../backend-ts/src/xuanwu/memoryReplay.ts";
import { liveReplayDriver, ReplayBudget } from "../backend-ts/src/xuanwu/memoryReplayRuntime.ts";

const args = Bun.argv.slice(2);
let live = false; let sourceState: string | undefined; let retryFrom: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--live") live = true;
  else if (args[i] === "--pi-state-dir" && args[i + 1]) sourceState = args[++i];
  else if (args[i] === "--retry-from" && args[i + 1]) retryFrom = args[++i];
  else throw new Error("Usage: bun scripts/replay-pi-memory.ts [--live --pi-state-dir <state> [--retry-from <report.json>]]");
}
assert(!live || sourceState, "live requires explicit --pi-state-dir");
assert(!retryFrom || live, "retry only applies to live replay");
const sourceRoot = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "xuanwu-memory-replay-"));
const budget = new ReplayBudget();
if (retryFrom) {
  const previous = JSON.parse(await readFile(resolve(retryFrom), "utf8"));
  assert(previous.kind === "live" && ["failed", "needs_user"].includes(previous.status) && previous.budget.retries === 0, "only one retry of a failed live run is allowed");
  writeFileSync(join(dirname(resolve(retryFrom)), "retry-claimed.json"), JSON.stringify({ retry_root: root, claimed_at: new Date().toISOString() }), { flag: "wx", mode: 0o600 });
  const ledgerPath = join(dirname(resolve(retryFrom)), "budget-ledger.json");
  const ledger = await readFile(ledgerPath, "utf8").then(JSON.parse).catch(() => previous.budget);
  previous.budget = ledger.model_calls > previous.budget.model_calls ? ledger : previous.budget;
  budget.started = Date.parse(previous.started_at);
  assert(Number.isFinite(budget.started), "invalid original deadline");
  budget.calls = previous.budget.model_calls;
  assert(Number.isInteger(budget.calls) && budget.calls >= 0 && budget.calls < 20, "previous budget exhausted");
  budget.dispatches = previous.budget.dispatches; budget.receipts = previous.budget.receipts; budget.retries = 1;
}
const remainingMs = budget.durationMs - (Date.now() - budget.started);
assert(remainingMs > 0, "original 30 minute deadline exhausted");
const timer = setTimeout(() => budget.controller.abort(new Error("replay 30 minute deadline")), remainingMs);
budget.onDispatch = () => writeFileSync(join(root, "budget-ledger.json"), JSON.stringify(budget.report()), { mode: 0o600 });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const provenance = { head: (await command(sourceRoot, ["git", "rev-parse", "HEAD"])).stdout.trim(),
  branch: (await command(sourceRoot, ["git", "branch", "--show-current"])).stdout.trim(),
  dirty: (await command(sourceRoot, ["git", "status", "--short"])).stdout,
  tracked_diff_sha256: hash((await command(sourceRoot, ["git", "diff", "--binary", "HEAD"])).stdout),
  replay_source_sha256: Object.fromEntries(await Promise.all(["scripts/replay-pi-memory.ts", "backend-ts/src/xuanwu/memoryReplay.ts", "backend-ts/src/xuanwu/memoryReplayRuntime.ts",
    "backend-ts/src/pi/memoryExperience.ts", "backend-ts/src/pi/memoryTools.ts", "backend-ts/src/pi/memoryReflectionRuntime.ts", "backend-ts/src/pi/memoryReflectionTools.ts"
  ].map(async path => [path, hash(await readFile(join(sourceRoot, path), "utf8"))]))),
  command: ["bun", "scripts/replay-pi-memory.ts", ...args], source_execution: "Bun imports current source; no HTTP requests to a deployed Xuanwu process" };
let report: Record<string, unknown> = { root, provenance, kind: live ? "live" : "fixture", status: "running", cases: REPLAY_CASES.map(id => ({ id, status: "not_run", facts: {} })), started_at: new Date(budget.started).toISOString(), retry_from: retryFrom ?? null };
const save = async () => writeFile(join(root, "report.json"), JSON.stringify({ ...report, budget: budget.report() }, null, 2));
try {
  const selected = live ? await liveReplayDriver(resolve(sourceState!), root, budget) : { driver: fixtureDriver, identity: null };
  report.identity = selected.identity;
  const result = await runMemoryReplay(root, selected.driver, budget.controller.signal, async cases => { report.cases = cases; await save(); });
  report = { ...report, ...result };
  const failures = result.cases.filter(row => row.status === "failed").flatMap(row => [row.error ?? "",
    ...((row.facts.reflections as Array<{reason: string}> | undefined) ?? []).map(item => item.reason)]).join(" ");
  if (live && /credentials?|oauth|api.?key|quota|billing|unauthorized|requires refresh|\b(?:401|403|429)\b/i.test(failures)) {
    report.status = "needs_user";
    report.blocker = "Existing Pi authentication/quota failed during the isolated replay";
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  report.status = /auth|credential|quota|billing|refresh|401|403|429|needs_user/i.test(message) ? "needs_user" : "failed";
  // 不记录 Provider 原始错误，避免泄露 header/token；保留可操作分类。
  report.blocker = report.status === "needs_user" ? "Existing Pi authentication/quota unavailable through read-only isolated runtime" : "Replay setup failed";
  console.error(report.blocker);
} finally { clearTimeout(timer); report.finished_at = new Date().toISOString(); await save(); }
console.log(JSON.stringify({ report: join(root, "report.json"), status: report.status, kind: report.kind, calls: budget.calls }));
process.exitCode = report.status === "passed" ? 0 : 1;
