import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { registerSecretForRedaction } from "../security/redactionRegistry.ts";
import { buildRuntimeObservability, primeRuntimeObservability } from "./runtimeObservability.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { force: true, recursive: true });
});

describe("runtime observability", () => {
  test("correlates one Work through Run, Workflow, Provider and Automation without scanning raw logs", async () => {
    const db = await fixtureDatabase();
    const secret = "fixture-diagnostic-secret";
    registerSecretForRedaction(secret);
    try {
      insertTraceFixture(db, secret);

      const snapshot = buildRuntimeObservability(db, new Date("2026-07-18T06:00:00.000Z"));
      const text = JSON.stringify(snapshot);
      const dimensions = snapshot.dimensions as Record<string, Record<string, unknown>>;
      const trace = ((snapshot.trace_correlation as { items: Array<Record<string, unknown>> }).items)[0];
      const event = ((snapshot.structured_events as { items: Array<Record<string, unknown>> }).items)[0];

      expect(snapshot).toMatchObject({
        schema_version: "xuanwu.runtime-observability.v1",
        generated_at: "2026-07-18T06:00:00.000Z",
        query_contract: {
          event_payload_source: "event_summary_projection",
          provider_session_scan: false,
          raw_log_scan: false
        },
        cost: {
          attempts: 1,
          usage: { known_attempts: 1, total_tokens: 120 },
          money: { by_currency: [{ amount_micros: 2500, attempts: 1, currency: "USD" }], known_attempts: 1 }
        }
      });
      expect(dimensions.work).toMatchObject({ total: 1, statuses: { in_progress: 1 } });
      expect(dimensions.run).toMatchObject({ total: 1, attempts: 1, statuses: { in_progress: 1 } });
      expect(dimensions.automation).toMatchObject({ total: 1, linked_runs: 1, statuses: { running: 1 } });
      expect((dimensions.provider.items as Array<Record<string, unknown>>)[0]).toMatchObject({
        provider: "codex",
        attempts: 1,
        known_usage_attempts: 1,
        total_tokens: 120,
        money_by_currency: [{ amount_micros: 2500, attempts: 1, currency: "USD" }]
      });
      expect(trace).toMatchObject({
        trace_id: "xw:work:issues:1",
        work: { id: "xw:work:issues:1", issue_id: 1 },
        run: { id: "xw:run:issue_runs:run-1", attempts: 1 },
        workflow: { ref: "workflow:fixture@1" },
        provider: { id: "codex", invocation_ref: "run-1" },
        automation: { id: "automation:fixture", run_id: "automation-run:fixture" },
        cost: { usage_completeness: "complete", total_tokens: 120 }
      });
      expect(event).toMatchObject({
        event_id: "issue_events:1",
        event_type: "run.progress",
        trace: { work_id: "xw:work:issues:1", run_id: "xw:run:issue_runs:run-1" },
        fields: { authorization: "[redacted]", path: "[redacted-path]" }
      });
      expect(text).not.toContain(secret);
      expect(text).not.toContain("raw-only-event-must-not-appear");
      expect(text).not.toContain("/Users/alice");
    } finally {
      db.close();
    }
  });

  test("caches the polling snapshot while explicit report timestamps stay fresh", async () => {
    const db = await fixtureDatabase();
    try {
      const initial = buildRuntimeObservability(db);
      db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
        values ('cached', 'Cached', '/tmp/cached', '2026-07-18T05:00:00Z', '2026-07-18T05:00:00Z')`);
      db.sqlite.run(`insert into issues (project_id, title, status, created_at, updated_at)
        values ('cached', 'New Work', 'todo', '2026-07-18T05:00:00Z', '2026-07-18T05:00:00Z')`);

      const cached = buildRuntimeObservability(db);
      const fresh = buildRuntimeObservability(db, new Date("2026-07-18T06:00:00.000Z"));
      const total = (value: Record<string, unknown>) =>
        Number(((value.dimensions as Record<string, any>).work as Record<string, unknown>).total);

      expect(total(initial)).toBe(0);
      expect(total(cached)).toBe(0);
      expect(total(fresh)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("primes the polling snapshot through the isolated reader worker", async () => {
    const db = await fixtureDatabase();
    try {
      await primeRuntimeObservability(db);
      db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
        values ('after-prime', 'After prime', '/tmp/after-prime', '2026-07-18T05:00:00Z', '2026-07-18T05:00:00Z')`);
      db.sqlite.run(`insert into issues (project_id, title, status, created_at, updated_at)
        values ('after-prime', 'New Work', 'todo', '2026-07-18T05:00:00Z', '2026-07-18T05:00:00Z')`);

      const cached = buildRuntimeObservability(db);
      const total = Number(((cached.dimensions as Record<string, any>).work as Record<string, unknown>).total);

      expect(total).toBe(0);
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-observability-"));
  roots.push(root);
  return await openDatabase({ dbPath: join(root, "runner.sqlite") });
}

function insertTraceFixture(db: RunnerDatabase, secret: string): void {
  db.sqlite.run(`insert into projects (id, name, cwd, created_at, updated_at)
    values ('demo', 'Demo', '/tmp/demo-observability', '2026-07-18T05:00:00Z', '2026-07-18T05:00:00Z')`);
  db.sqlite.run(`insert into issues (id, project_id, title, status, created_at, updated_at)
    values (1, 'demo', 'Trace fixture', 'in_progress', '2026-07-18T05:00:00Z', '2026-07-18T05:30:00Z')`);
  db.sqlite.run(`insert into works (id, project_id, type, title, goal, status, acceptance_json,
      provenance_json, workflow_ref, created_at, updated_at)
    values ('xw:work:issues:1', 'demo', 'engineering_task', 'Trace fixture', 'Trace one Work', 'in_progress',
      '{}', '{}', 'workflow:fixture@1', '2026-07-18T05:00:00Z', '2026-07-18T05:30:00Z')`);
  db.sqlite.run(`insert into issue_runs (id, issue_id, attempt, status, provider, provider_session_id, started_at)
    values ('run-1', 1, 1, 'in_progress', 'codex', 'thread-fixture', '2026-07-18T05:05:00Z')`);
  db.sqlite.run("update run_attempts set cost_json=? where issue_run_id='run-1'", [JSON.stringify({
    money: { amount_micros: 2500, basis: "provider_reported", currency: "USD" },
    pricing_refs: [],
    source_refs: ["issue_events:1"],
    usage: {
      cached_input_tokens: 20,
      completeness: "complete",
      input_tokens: 80,
      output_tokens: 40,
      reasoning_output_tokens: 10,
      total_tokens: 120
    }
  })]);
  db.sqlite.run(`insert into automation_definitions
    (id, scope_kind, scope_id, name, workflow_ref, permission_policy_ref, mode, status,
      idempotency_namespace, active_trigger_version, revision, created_at, updated_at)
    values ('automation:fixture', 'project', 'demo', 'Fixture automation', 'workflow:fixture@1',
      'project-policy:demo', 'execute_allowed', 'active', 'fixture', 1, 0,
      '2026-07-18T05:00:00Z', '2026-07-18T05:00:00Z')`);
  db.sqlite.run(`insert into automation_runs
    (run_id, automation_id, trigger_version, idempotency_key, status, requested_at,
      summary_json, created_at, attempt_count, max_attempts, lease_token, lease_expires_at)
    values ('automation-run:fixture', 'automation:fixture', 1, 'fixture:1', 'running',
      '2026-07-18T05:04:00Z', '{}', '2026-07-18T05:04:00Z', 1, 3, 'lease-fixture', '2026-07-18T07:00:00Z')`);
  db.sqlite.run(`insert into automation_execution_links
    (automation_run_id, automation_id, workflow_ref, issue_id, work_id, run_id, created_at, updated_at)
    values ('automation-run:fixture', 'automation:fixture', 'workflow:fixture@1', 1,
      'xw:work:issues:1', 'xw:run:issue_runs:run-1', '2026-07-18T05:05:00Z', '2026-07-18T05:05:00Z')`);
  db.sqlite.run(`insert into issue_events (id, issue_id, type, payload, created_at)
    values (1, 1, 'issue.log', ?, '2026-07-18T05:10:00Z')`, [
      JSON.stringify({ text: `raw-only-event-must-not-appear ${secret}` })
    ]);
  db.sqlite.run(`insert into event_summary_projection
    (source, source_event_id, issue_id, project_id, run_id, event_type, raw_method, policy_id,
      retention_tier, summary, summary_payload, source_payload_bytes, source_sha256,
      summary_sha256, event_created_at, projected_at)
    values ('issue_events', 1, 1, 'demo', 'run-1', 'run.progress', 'thread/started',
      'fixture-policy', 'summary', ?, ?, 10, 'source-hash', 'summary-hash',
      '2026-07-18T05:10:00Z', '2026-07-18T05:11:00Z')`, [
      `provider token is ${secret}`,
      JSON.stringify({ authorization: secret, path: "/Users/alice/private/file" })
    ]);
}
