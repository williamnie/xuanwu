import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { readRunnerProviderUsage } from "./providers.ts";

const roots: string[] = [];
const NOW = new Date("2026-08-02T10:00:00+08:00");

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("Runner provider usage", () => {
  test("aggregates only the selected provider by local periods and project", async () => {
    const database = await fixtureDatabase();
    try {
      insertAttempt(database, { id: "claude-today", provider: "claude", timestamp: "2026-08-02T01:00:00Z", tokens: 30, usdMicros: 250_000 });
      insertAttempt(database, { id: "claude-old", provider: "claude", timestamp: "2026-07-20T01:00:00Z", tokens: 20, usdMicros: 100_000 });
      insertAttempt(database, { id: "codex-today", provider: "codex", timestamp: "2026-08-02T01:00:00Z", tokens: 999 });

      const report = readRunnerProviderUsage(database, "claude", NOW) as any;

      expect(report).toMatchObject({
        events_scanned: 2,
        provider: { id: "claude", scope: "runner_attempts" },
        source: "run_attempts.cost_json",
        summary: {
          all_time: { total_tokens: 50, money: { amount_micros: 350_000, currency: "USD" } },
          today: { total_tokens: 30, money: { amount_micros: 250_000, currency: "USD" } }
        }
      });
      expect(report.project_usage).toEqual([
        expect.objectContaining({ id: "demo", name: "Demo", percent: 100, usage: expect.objectContaining({ total_tokens: 50 }) })
      ]);
    } finally {
      database.close();
    }
  });

  test("ignores unavailable cost snapshots", async () => {
    const database = await fixtureDatabase();
    try {
      insertAttempt(database, { id: "empty", provider: "claude", timestamp: "2026-08-02T01:00:00Z" });

      expect(readRunnerProviderUsage(database, "claude", NOW)).toMatchObject({
        events_scanned: 0,
        summary: { today: { completeness: "unavailable", total_tokens: 0 } }
      });
    } finally {
      database.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "runner-provider-usage-"));
  roots.push(root);
  const database = await openDatabase({ stateDir: join(root, "state") });
  database.sqlite.run(`insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('demo', 'Demo', ?, 'codex', ?, ?)`, [join(root, "repo"), NOW.toISOString(), NOW.toISOString()]);
  return database;
}

function insertAttempt(database: RunnerDatabase, input: {
  id: string;
  provider: string;
  timestamp: string;
  tokens?: number;
  usdMicros?: number;
}): void {
  const issue = database.sqlite.run(`insert into issues (project_id, title, status, created_at, updated_at)
    values ('demo', ?, 'done', ?, ?)`, [input.id, input.timestamp, input.timestamp]);
  database.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, started_at, ended_at)
    values (?, ?, 1, 'done', ?, ?, ?)`, [input.id, Number(issue.lastInsertRowid), input.provider, input.timestamp, input.timestamp]);
  const cost = input.tokens === undefined ? {} : {
    money: input.usdMicros === undefined
      ? { amount_micros: null, basis: "unavailable", currency: "" }
      : { amount_micros: input.usdMicros, basis: "provider_reported", currency: "USD" },
    pricing_refs: [],
    source_refs: [`fixture:${input.id}`],
    usage: {
      cached_input_tokens: 0,
      completeness: "complete",
      input_tokens: input.tokens - 10,
      output_tokens: 10,
      reasoning_output_tokens: 0,
      total_tokens: input.tokens
    }
  };
  database.sqlite.run("update run_attempts set cost_json=? where issue_run_id=?", [JSON.stringify(cost), input.id]);
}
