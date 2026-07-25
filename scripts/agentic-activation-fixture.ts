#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CONTRACT = "xw.agentic-activation.fixture.v1";
const PROJECT_ID = "codex-issue-runner";
const SOURCE_MARKER = "agentic-activation:issue-777";
const SCENARIOS = ["success", "retryable_failure", "needs_user"] as const;
const DEFAULT_ARTIFACT_DIR = ".runner/artifacts/agentic-activation/issue-777";

type Scenario = typeof SCENARIOS[number];
type Json = Record<string, any>;
type Client = { request(path: string, init?: RequestInit): Promise<{ body: any; status: number }> };

export type FixtureManifest = {
  contract: typeof CONTRACT;
  created_at: string;
  cycle: number;
  fixture_key: string;
  issue_ids: Record<Scenario, number>;
  issues: Array<{
    id: number;
    scenario: Scenario;
    status: string;
    event_ids: number[];
  }>;
  project_id: typeof PROJECT_ID;
  source_marker: typeof SOURCE_MARKER;
  state_dir: string;
};

type Options = {
  addr: string;
  artifactDir: string;
  command: string;
  cycle: number;
  db: string;
  manifest: string;
  scenario: Scenario | "";
  stateDir: string;
  token: string;
  tokenFile: string;
};

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const client = httpClient(options.addr, token(options));
  if (options.command === "exercise") {
    const report = await exercise(options, client);
    console.log(JSON.stringify(report, null, 2));
    if (report.result !== "passed") process.exitCode = 1;
    return;
  }
  if (options.command === "baseline") return print(await collectBaseline(options, client));
  if (options.command === "create") {
    const manifest = await createFixture(client, options.cycle, options.stateDir);
    writeJson(options.manifest, manifest);
    return print(manifest);
  }
  if (options.command === "inspect") return print(await inspectFixture(client, readManifest(options.manifest)));
  if (options.command === "reset") return print(await resetFixture(client, readManifest(options.manifest)));
  if (options.command === "rollback-dry-run") {
    return print(await rollbackFixtureConfig(client, readManifest(options.manifest), false));
  }
  if (options.command === "rollback-apply") {
    return print(await rollbackFixtureConfig(client, readManifest(options.manifest), true));
  }
  if (options.command === "scenario") {
    if (!options.scenario) throw new Error("--scenario is required");
    const result = runScenario(options.scenario, options.stateDir);
    print(result);
    process.exitCode = result.exit_code;
    return;
  }
  throw new Error(`unknown command: ${options.command}`);
}

export async function createFixture(client: Client, cycle: number, stateDir: string): Promise<FixtureManifest> {
  if (!Number.isSafeInteger(cycle) || cycle < 1) throw new Error("cycle must be a positive integer");
  const fixtureKey = `${SOURCE_MARKER}:cycle-${cycle}:${Date.now()}`;
  const issues: FixtureManifest["issues"] = [];
  for (const [index, scenario] of SCENARIOS.entries()) {
    const response = await client.request("/api/issues", {
      method: "POST",
      body: JSON.stringify({
        project_id: PROJECT_ID,
        title: `[AGENTIC-FIXTURE issue-777 cycle-${cycle}] ${scenario}`,
        description: scenarioDescription(scenario, fixtureKey, stateDir),
        status: "triage",
        priority: 777_100 + cycle * 10 + index,
        source_session_id: SOURCE_MARKER,
        source_turn_id: fixtureKey,
        source_excerpt: `${CONTRACT}:${scenario}`
      })
    });
    expectStatus(response, 201, `create ${scenario}`);
    const id = positiveInteger(response.body?.id, `created ${scenario} id`);
    issues.push({ id, scenario, status: String(response.body?.status ?? ""), event_ids: [] });
  }
  const manifest: FixtureManifest = {
    contract: CONTRACT,
    created_at: new Date().toISOString(),
    cycle,
    fixture_key: fixtureKey,
    issue_ids: Object.fromEntries(issues.map((item) => [item.scenario, item.id])) as Record<Scenario, number>,
    issues,
    project_id: PROJECT_ID,
    source_marker: SOURCE_MARKER,
    state_dir: resolve(stateDir)
  };
  return await inspectFixture(client, manifest);
}

export async function inspectFixture(client: Client, manifest: FixtureManifest): Promise<FixtureManifest> {
  assertManifest(manifest);
  const inspected: FixtureManifest["issues"] = [];
  for (const item of manifest.issues) {
    const [issue, events, runs] = await Promise.all([
      client.request(`/api/issues/${item.id}`),
      client.request(`/api/issues/${item.id}/events`),
      client.request(`/api/issues/${item.id}/runs`)
    ]);
    expectStatus(issue, 200, `inspect issue ${item.id}`);
    expectStatus(events, 200, `inspect events ${item.id}`);
    expectStatus(runs, 200, `inspect runs ${item.id}`);
    if (issue.body?.project_id !== PROJECT_ID || issue.body?.source_session_id !== SOURCE_MARKER) {
      throw new Error(`fixture issue ${item.id} escaped its project/source scope`);
    }
    if (issue.body?.status !== "triage") throw new Error(`fixture issue ${item.id} is not triage`);
    const eventList = arrayBody(events.body);
    const runList = arrayBody(runs.body);
    if (runList.length !== 0) throw new Error(`fixture issue ${item.id} unexpectedly has Runs`);
    if (!eventList.some((event) => event?.type === "issue.created")) {
      throw new Error(`fixture issue ${item.id} has no traceable issue.created event`);
    }
    inspected.push({
      id: item.id,
      scenario: item.scenario,
      status: String(issue.body.status),
      event_ids: eventList.map((event) => Number(event?.id)).filter(Number.isSafeInteger)
    });
  }
  return { ...manifest, issues: inspected };
}

export async function resetFixture(client: Client, manifest: FixtureManifest): Promise<Json> {
  const inspected = await inspectFixture(client, manifest);
  for (const item of inspected.issues) {
    const deleted = await client.request(`/api/issues/${item.id}`, { method: "DELETE" });
    expectStatus(deleted, 204, `delete issue ${item.id}`);
  }
  for (const item of inspected.issues) {
    const readBack = await client.request(`/api/issues/${item.id}`);
    expectStatus(readBack, 404, `verify issue ${item.id} deletion`);
  }
  rmSync(resolve(manifest.state_dir), { recursive: true, force: true });
  return {
    contract: CONTRACT,
    fixture_key: manifest.fixture_key,
    issue_ids: manifest.issue_ids,
    residual_issue_count: 0,
    residual_run_count: 0,
    residual_state_dir: false,
    reset_at: new Date().toISOString()
  };
}

export async function rollbackFixtureConfig(client: Client, manifest: FixtureManifest, apply: boolean): Promise<Json> {
  const issueID = manifest.issue_ids.success;
  const beforeResponse = await client.request(`/api/issues/${issueID}`);
  expectStatus(beforeResponse, 200, "read rollback target");
  const before = {
    priority: positiveInteger(beforeResponse.body?.priority, "fixture priority"),
    status: String(beforeResponse.body?.status ?? "")
  };
  const proposed = { priority: before.priority + 1, status: before.status };
  const plan = {
    apply,
    contract: "xw.agentic-activation.fixture-rollback.v1",
    fixture_key: manifest.fixture_key,
    issue_id: issueID,
    mutation: { before, proposed },
    restore: before
  };
  if (!apply) return { ...plan, result: "dry_run" };
  const mutated = await client.request(`/api/issues/${issueID}`, {
    method: "PATCH",
    body: JSON.stringify(proposed)
  });
  expectStatus(mutated, 200, "apply fixture config mutation");
  if (mutated.body?.priority !== proposed.priority) throw new Error("fixture config mutation did not take effect");
  const restored = await client.request(`/api/issues/${issueID}`, {
    method: "PATCH",
    body: JSON.stringify(before)
  });
  expectStatus(restored, 200, "restore fixture config");
  if (restored.body?.priority !== before.priority || restored.body?.status !== before.status) {
    throw new Error("fixture config rollback did not restore its baseline");
  }
  return { ...plan, result: "restored", restored: before };
}

export function runScenario(scenario: Scenario, stateDir: string): Json {
  const root = resolve(stateDir);
  if (scenario === "success") {
    return { contract: CONTRACT, exit_code: 0, external_writes: 0, scenario, status: "succeeded" };
  }
  if (scenario === "needs_user") {
    return {
      contract: CONTRACT,
      exit_code: 78,
      external_writes: 0,
      request: { question: "Approve the fixture-only continuation?", requires_user: true },
      scenario,
      status: "needs_user"
    };
  }
  mkdirSync(root, { recursive: true });
  const attemptPath = join(root, "retryable_failure.attempt");
  const previous = readInteger(attemptPath);
  const attempt = previous + 1;
  writeFileSync(attemptPath, `${attempt}\n`, { mode: 0o600 });
  return attempt === 1
    ? { attempt, contract: CONTRACT, exit_code: 75, external_writes: 0, retryable: true, scenario, status: "failed" }
    : { attempt, contract: CONTRACT, exit_code: 0, external_writes: 0, retryable: false, scenario, status: "succeeded" };
}

async function exercise(options: Options, client: Client): Promise<Json> {
  const artifactDir = resolve(options.artifactDir);
  mkdirSync(artifactDir, { recursive: true });
  const timelinePath = join(artifactDir, "timeline.jsonl");
  writeFileSync(timelinePath, "");
  const startedAt = new Date().toISOString();
  const timeline = (phase: string, action: string, result: string, detail: Json = {}) => {
    writeFileSync(timelinePath, `${JSON.stringify({
      action, at: new Date().toISOString(), detail, phase, result
    })}\n`, { flag: "a" });
  };
  const assertions: Array<{ id: string; passed: boolean; evidence: string; detail?: Json }> = [];
  const assert = (id: string, passed: boolean, evidence: string, detail?: Json) => {
    assertions.push({ id, passed, evidence, ...(detail ? { detail } : {}) });
    timeline("assertion", id, passed ? "passed" : "failed", detail ?? {});
  };
  let failureReason = "";
  try {
    timeline("baseline", "collect", "started");
    const before = await collectBaseline(options, client);
    writeJson(join(artifactDir, "baseline-before.json"), before);
    timeline("baseline", "collect", "passed", baselineSummary(before));

    const stale = await cleanExistingFixtures(client, options.db);
    timeline("fixture", "preflight-reset", "passed", stale);

    const cycle1 = await createFixture(client, 1, join(artifactDir, "fixture-state-cycle-1"));
    writeJson(join(artifactDir, "cycle-1.json"), cycle1);
    timeline("fixture", "create-inspect-cycle-1", "passed", { issue_ids: cycle1.issue_ids });
    const scenarioResults = [
      runScenario("success", cycle1.state_dir),
      runScenario("retryable_failure", cycle1.state_dir),
      runScenario("retryable_failure", cycle1.state_dir),
      runScenario("needs_user", cycle1.state_dir)
    ];
    writeJson(join(artifactDir, "scenario-results.json"), scenarioResults);
    timeline("fixture", "execute-safe-inputs", "passed", { exit_codes: scenarioResults.map((item) => item.exit_code) });

    const dryRun = await rollbackFixtureConfig(client, cycle1, false);
    writeJson(join(artifactDir, "rollback-dry-run.json"), dryRun);
    timeline("rollback", "dry-run", "passed", { issue_id: dryRun.issue_id });
    const restored = await rollbackFixtureConfig(client, cycle1, true);
    writeJson(join(artifactDir, "rollback-restored.json"), restored);
    timeline("rollback", "apply-and-restore", "passed", { issue_id: restored.issue_id });
    await inspectFixture(client, cycle1);

    const reset1 = await resetFixture(client, cycle1);
    writeJson(join(artifactDir, "reset-cycle-1.json"), reset1);
    timeline("fixture", "reset-cycle-1", "passed", reset1);

    const cycle2 = await createFixture(client, 2, join(artifactDir, "fixture-state-cycle-2"));
    writeJson(join(artifactDir, "cycle-2.json"), cycle2);
    timeline("fixture", "recreate-inspect-cycle-2", "passed", { issue_ids: cycle2.issue_ids });
    const reset2 = await resetFixture(client, cycle2);
    writeJson(join(artifactDir, "reset-cycle-2.json"), reset2);
    timeline("fixture", "reset-cycle-2", "passed", reset2);

    const leakCheck = await fixtureLeakCheck(options.db, [...Object.values(cycle1.issue_ids), ...Object.values(cycle2.issue_ids)]);
    writeJson(join(artifactDir, "fixture-leak-check.json"), leakCheck);
    timeline("fixture", "leak-check", leakCheck.clean ? "passed" : "failed", leakCheck);
    const after = await collectBaseline(options, client);
    writeJson(join(artifactDir, "baseline-after.json"), after);
    timeline("baseline", "collect-after", "passed", baselineSummary(after));

    assert("web_core_alive", before.web.alive && before.core.alive && after.web.alive && after.core.alive,
      "baseline-before.json + baseline-after.json");
    assert("db_quick_check_ok", before.db.quick_check === "ok" && after.db.quick_check === "ok",
      "baseline-before.json + baseline-after.json");
    assert("all_baseline_fields_explicit", !containsNull(before) && !containsNull(after),
      "baseline-before.json + baseline-after.json");
    assert("automatic_writes_disabled",
      before.project.auto_manage === 0 && before.project.auto_enqueue === 0 &&
      after.project.auto_manage === 0 && after.project.auto_enqueue === 0,
      "baseline-before.json + baseline-after.json");
    assert("three_inputs_are_safe_and_deterministic",
      scenarioResults.map((item) => item.exit_code).join(",") === "0,75,0,78" &&
      scenarioResults.every((item) => item.external_writes === 0),
      "scenario-results.json");
    assert("create_inspect_reset_recreate_traceable",
      new Set(Object.values(cycle1.issue_ids)).size === 3 &&
      new Set(Object.values(cycle2.issue_ids)).size === 3 &&
      Object.values(cycle1.issue_ids).every((id) => !Object.values(cycle2.issue_ids).includes(id)) &&
      cycle1.issues.every((item) => item.event_ids.length > 0) &&
      cycle2.issues.every((item) => item.event_ids.length > 0),
      "cycle-1.json + cycle-2.json");
    assert("rollback_dry_run_and_restore_proven",
      dryRun.result === "dry_run" && restored.result === "restored" &&
      restored.mutation.before.priority === restored.restored.priority,
      "rollback-dry-run.json + rollback-restored.json");
    assert("fixture_has_no_residue", leakCheck.clean === true,
      "fixture-leak-check.json", leakCheck);
    const baselineDiff = comparableBaselineDiff(before, after);
    writeJson(join(artifactDir, "baseline-diff.json"), baselineDiff);
    assert("baseline_counts_restored", baselineDiff.equal, "baseline-diff.json", baselineDiff);
  } catch (error) {
    failureReason = error instanceof Error ? error.message : String(error);
    timeline("exercise", "abort", "failed", { reason: failureReason });
    try {
      const cleanup = await cleanExistingFixtures(client, options.db);
      timeline("exercise", "failure-cleanup", cleanup.clean ? "passed" : "failed", cleanup);
    } catch (cleanupError) {
      const detail = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
      failureReason = `${failureReason}; failure cleanup failed: ${detail}`;
      timeline("exercise", "failure-cleanup", "failed", { reason: detail });
    }
  }
  const endedAt = new Date().toISOString();
  const result = failureReason === "" && assertions.length === 9 && assertions.every((item) => item.passed)
    ? "passed"
    : "failed";
  const report = {
    artifact_refs: [
      "baseline-before.json", "baseline-after.json", "baseline-diff.json", "cycle-1.json", "cycle-2.json",
      "scenario-results.json", "rollback-dry-run.json", "rollback-restored.json",
      "reset-cycle-1.json", "reset-cycle-2.json", "fixture-leak-check.json", "timeline.jsonl", "replay.md"
    ],
    assertions,
    contract: "xw.agentic-activation.issue-report.v1",
    ended_at: endedAt,
    failure_reasons: failureReason ? [failureReason] : [],
    issue_id: 777,
    result,
    started_at: startedAt
  };
  writeJson(join(artifactDir, "report.json"), report);
  writeFileSync(join(artifactDir, "replay.md"), replayText(options));
  return report;
}

async function collectBaseline(options: Options, client: Client): Promise<Json> {
  if (!options.db) throw new Error("--db is required");
  const db = new Database(resolve(options.db), { readonly: true, strict: true });
  try {
    const [webHealth, coreHealth, webStatus, coreStatus, skills] = await Promise.all([
      client.request("/health"),
      directClient("http://127.0.0.1:3009", token(options)).request("/health"),
      client.request("/api/system/status?compact=1"),
      directClient("http://127.0.0.1:3009", token(options)).request("/api/system/status?compact=1"),
      client.request("/api/pi/skills")
    ]);
    expectStatus(webHealth, 200, "Web health");
    expectStatus(coreHealth, 200, "Core health");
    expectStatus(webStatus, 200, "Web status");
    expectStatus(coreStatus, 200, "Core status");
    expectStatus(skills, 200, "Skills baseline");
    const features = db.query<Json, []>(`
      select
        (select count(*) from issue_supervisor_events) supervisor_events,
        (select coalesce(max(id),0) from issue_supervisor_events) supervisor_watermark,
        (select count(*) from issue_supervisor_events where project_id='codex-issue-runner') supervisor_project_events,
        (select count(*) from automation_definitions) automation_definitions,
        (select count(*) from automation_runs) automation_runs,
        (select count(*) from automation_run_events) automation_run_events,
        (select count(*) from automation_watches) automation_watches,
        (select coalesce(max(occurred_at),'') from automation_run_events) automation_watermark,
        (select count(*) from pi_heartbeat_controls) heartbeat_controls,
        (select count(*) from pi_heartbeat_runs) heartbeat_runs,
        (select count(*) from pi_heartbeat_events) heartbeat_events,
        (select coalesce(max(id),0) from pi_heartbeat_events) heartbeat_watermark,
        (select count(*) from pi_mcp_servers) mcp_servers,
        (select count(*) from pi_mcp_servers where enabled=1) mcp_servers_enabled,
        (select count(*) from pi_mcp_capabilities) mcp_capabilities,
        (select coalesce(max(updated_at),'') from pi_mcp_servers) mcp_watermark,
        (select count(*) from pi_skill_intent_audits) skill_audits,
        (select coalesce(max(id),0) from pi_skill_intent_audits) skill_watermark,
        (select count(*) from intake_runs) skill_intake_runs,
        (select count(*) from assistant_tool_providers) tool_providers,
        (select count(*) from assistant_tools) tools,
        (select count(*) from pi_action_events where event_type='tool_call_audit') tool_call_audits,
        (select coalesce(max(id),0) from pi_action_events where event_type='tool_call_audit') tool_watermark,
        (select count(*) from attention_inbox_items) attention_items,
        (select coalesce(max(id),0) from attention_inbox_items) attention_watermark
    `).get() ?? {};
    const project = db.query<Json, []>(`
      select p.id, p.auto_run,
        coalesce(nullif(p.default_skill_policy_json,''),'{}') default_skill_policy_json,
        coalesce(nullif(p.default_mcp_policy_json,''),'{}') default_mcp_policy_json,
        coalesce(s.auto_manage,0) auto_manage,
        coalesce(s.auto_triage,0) auto_triage,
        coalesce(s.auto_enqueue,0) auto_enqueue
      from projects p left join project_pi_settings s on s.project_id=p.id
      where p.id='codex-issue-runner'
    `).get();
    if (!project) throw new Error("codex-issue-runner project baseline is missing");
    const projection = db.query<Json, []>(`
      select count(*) count, coalesce(max(last_event_id),0) last_event_id,
        coalesce(max(updated_at),'') updated_at from event_projection_watermarks
    `).get() ?? {};
    const migration = db.query<Json, []>(
      "select count(*) count, coalesce(max(id),'') watermark from schema_migrations"
    ).get() ?? {};
    const quickCheck = String(Object.values(db.query("pragma quick_check").get() ?? {})[0] ?? "");
    const service = (response: { body: any }) => ({
      alive: response.body?.service?.alive === true,
      role: String(response.body?.service?.role ?? ""),
      runtime_stamp: String(response.body?.service?.build?.stamp ?? ""),
      started_at: String(response.body?.service?.started_at ?? ""),
      version: String(response.body?.service?.version ?? "")
    });
    return {
      captured_at: new Date().toISOString(),
      web: { ...service(webStatus), alive: webHealth.status === 200 && webStatus.body?.service?.alive === true },
      core: { ...service(coreStatus), alive: coreHealth.status === 200 && coreStatus.body?.service?.alive === true },
      db: { quick_check: quickCheck, schema_migration_count: migration.count, schema_watermark: migration.watermark },
      supervisor: {
        event_count: features.supervisor_events,
        project_event_count: features.supervisor_project_events,
        watermark: features.supervisor_watermark
      },
      automation: {
        definition_count: features.automation_definitions,
        run_count: features.automation_runs,
        run_event_count: features.automation_run_events,
        watch_count: features.automation_watches,
        watermark: features.automation_watermark || "none"
      },
      heartbeat: {
        control_count: features.heartbeat_controls,
        run_count: features.heartbeat_runs,
        event_count: features.heartbeat_events,
        watermark: features.heartbeat_watermark
      },
      mcp: {
        server_count: features.mcp_servers,
        enabled_server_count: features.mcp_servers_enabled,
        capability_count: features.mcp_capabilities,
        watermark: features.mcp_watermark
      },
      skills: {
        discovered_count: arrayBody(skills.body?.skills).length,
        diagnostic_count: arrayBody(skills.body?.diagnostics).length,
        audit_count: features.skill_audits,
        intake_run_count: features.skill_intake_runs,
        watermark: features.skill_watermark
      },
      tool: {
        provider_count: features.tool_providers,
        registered_count: features.tools,
        call_audit_count: features.tool_call_audits,
        watermark: features.tool_watermark
      },
      attention: { item_count: features.attention_items, watermark: features.attention_watermark },
      project,
      projection: {
        count: projection.count,
        issue_event_watermark: projection.last_event_id,
        updated_at: projection.updated_at
      }
    };
  } finally {
    db.close();
  }
}

async function cleanExistingFixtures(client: Client, dbPath: string): Promise<Json> {
  const listed = await client.request(`/api/issues?projectId=${PROJECT_ID}`);
  expectStatus(listed, 200, "list fixture preflight");
  const stale = arrayBody(listed.body).filter((item) => item?.source_session_id === SOURCE_MARKER);
  for (const issue of stale) {
    const id = positiveInteger(issue.id, "stale fixture id");
    const runs = await client.request(`/api/issues/${id}/runs`);
    expectStatus(runs, 200, `inspect stale fixture ${id}`);
    if (arrayBody(runs.body).length !== 0 || issue.status !== "triage") {
      throw new Error(`stale fixture ${id} is not safe to reset`);
    }
    expectStatus(await client.request(`/api/issues/${id}`, { method: "DELETE" }), 204, `delete stale fixture ${id}`);
  }
  const leak = await fixtureLeakCheck(dbPath, stale.map((item) => Number(item.id)));
  return { removed_issue_ids: stale.map((item) => Number(item.id)), clean: leak.clean };
}

async function fixtureLeakCheck(dbPath: string, issueIDs: number[]): Promise<Json> {
  const db = new Database(resolve(dbPath), { readonly: true, strict: true });
  try {
    const placeholders = issueIDs.length ? issueIDs.map(() => "?").join(",") : "null";
    const args = issueIDs;
    const count = (sql: string, parameters: any[] = []) =>
      Number((db.query<Json, any[]>(sql).get(...parameters)?.count ?? 0));
    const residual = {
      issues: count("select count(*) count from issues where source_session_id=?", [SOURCE_MARKER]),
      runs: count(`select count(*) count from issue_runs where issue_id in (${placeholders})`, args),
      supervisor_events: count(`select count(*) count from issue_supervisor_events where issue_id in (${placeholders})`, args),
      pi_actions: count(`select count(*) count from pi_actions where issue_id in (${placeholders})`, args),
      pi_action_events: count(`select count(*) count from pi_action_events where issue_id in (${placeholders})`, args),
      attention: count(
        "select count(*) count from attention_inbox_items where title like ? or summary like ?",
        [`%${SOURCE_MARKER}%`, `%${SOURCE_MARKER}%`]
      ),
      sync_outbox: count(`select count(*) count from sync_outbox where issue_id in (${placeholders})`, args),
      notifications: count(`select count(*) count from notifications where issue_id in (${placeholders})`, args),
      automation_leases: count(
        "select count(*) count from automation_runs where lease_token<>'' and (summary_json like ? or idempotency_key like ?)",
        [`%${SOURCE_MARKER}%`, `%${SOURCE_MARKER}%`]
      )
    };
    return { checked_issue_ids: issueIDs, clean: Object.values(residual).every((value) => value === 0), residual };
  } finally {
    db.close();
  }
}

function comparableBaselineDiff(before: Json, after: Json): Json {
  const paths = [
    "db.quick_check", "db.schema_migration_count", "db.schema_watermark",
    "automation.definition_count", "automation.run_count", "automation.run_event_count", "automation.watch_count",
    "heartbeat.control_count", "heartbeat.run_count", "heartbeat.event_count",
    "mcp.server_count", "mcp.enabled_server_count", "mcp.capability_count",
    "skills.discovered_count", "skills.diagnostic_count", "skills.audit_count", "skills.intake_run_count",
    "tool.provider_count", "tool.registered_count", "tool.call_audit_count",
    "attention.item_count",
    "project.auto_manage", "project.auto_triage", "project.auto_enqueue",
    "project.default_skill_policy_json", "project.default_mcp_policy_json"
  ];
  const values = paths.map((path) => ({ path, before: atPath(before, path), after: atPath(after, path) }));
  return { equal: values.every((item) => JSON.stringify(item.before) === JSON.stringify(item.after)), values };
}

function baselineSummary(baseline: Json): Json {
  return {
    web_alive: baseline.web.alive,
    core_alive: baseline.core.alive,
    db_quick_check: baseline.db.quick_check,
    supervisor_watermark: baseline.supervisor.watermark,
    automation_runs: baseline.automation.run_count,
    heartbeat_runs: baseline.heartbeat.run_count,
    mcp_servers: baseline.mcp.server_count,
    skills: baseline.skills.discovered_count,
    tools: baseline.tool.registered_count,
    attention: baseline.attention.item_count
  };
}

function scenarioDescription(scenario: Scenario, fixtureKey: string, stateDir: string): string {
  const expected = scenario === "success"
    ? "exit 0 immediately"
    : scenario === "retryable_failure"
      ? "first call exits 75, second call exits 0"
      : "exit 78 with requires_user=true";
  return [
    `Fixture contract: ${CONTRACT}`,
    `Fixture key: ${fixtureKey}`,
    `Scenario: ${scenario}`,
    `Expected: ${expected}`,
    "Execution policy: manual invocation only; keep this Issue in triage until a dependent acceptance test explicitly consumes it.",
    "External writes: forbidden.",
    "Automation: auto_manage and auto_enqueue must remain disabled.",
    `Replay: bun scripts/agentic-activation-fixture.ts scenario --scenario ${scenario} --state-dir ${resolve(stateDir)}`
  ].join("\n");
}

function replayText(options: Options): string {
  const db = resolve(options.db);
  const tokenFile = resolve(options.tokenFile);
  const artifactDir = resolve(options.artifactDir);
  return `# Issue 777 replay

前置条件：Web/Core 已由 launchd 启动；命令不会启用 \`auto_manage\`、\`auto_enqueue\` 或外部写工具。

\`\`\`bash
bun scripts/agentic-activation-fixture.ts exercise \\
  --addr ${options.addr} \\
  --db ${shellQuote(db)} \\
  --token-file ${shellQuote(tokenFile)} \\
  --artifact-dir ${shellQuote(artifactDir)}
\`\`\`

单独复用三类输入：

\`\`\`bash
# 创建并检查（保持 triage，不 enqueue）
bun scripts/agentic-activation-fixture.ts create --addr ${options.addr} --token-file ${shellQuote(tokenFile)} \\
  --cycle 1 --manifest ${shellQuote(join(artifactDir, "manual-manifest.json"))} \\
  --state-dir ${shellQuote(join(artifactDir, "manual-state"))}
bun scripts/agentic-activation-fixture.ts inspect --addr ${options.addr} --token-file ${shellQuote(tokenFile)} \\
  --manifest ${shellQuote(join(artifactDir, "manual-manifest.json"))}

# success=0；retryable_failure 第一次=75、第二次=0；needs_user=78
bun scripts/agentic-activation-fixture.ts scenario --scenario success --state-dir ${shellQuote(join(artifactDir, "manual-state"))}
bun scripts/agentic-activation-fixture.ts scenario --scenario retryable_failure --state-dir ${shellQuote(join(artifactDir, "manual-state"))} || test $? -eq 75
bun scripts/agentic-activation-fixture.ts scenario --scenario retryable_failure --state-dir ${shellQuote(join(artifactDir, "manual-state"))}
bun scripts/agentic-activation-fixture.ts scenario --scenario needs_user --state-dir ${shellQuote(join(artifactDir, "manual-state"))} || test $? -eq 78

# 回滚 dry-run、实际恢复、清理
bun scripts/agentic-activation-fixture.ts rollback-dry-run --addr ${options.addr} --token-file ${shellQuote(tokenFile)} \\
  --manifest ${shellQuote(join(artifactDir, "manual-manifest.json"))}
bun scripts/agentic-activation-fixture.ts rollback-apply --addr ${options.addr} --token-file ${shellQuote(tokenFile)} \\
  --manifest ${shellQuote(join(artifactDir, "manual-manifest.json"))}
bun scripts/agentic-activation-fixture.ts reset --addr ${options.addr} --token-file ${shellQuote(tokenFile)} \\
  --manifest ${shellQuote(join(artifactDir, "manual-manifest.json"))}
\`\`\`

判定以 \`report.json\` 的所有 assertions、\`fixture-leak-check.json\`、\`baseline-diff.json\` 和服务 health 为准。
`;
}

function httpClient(addr: string, authToken: string): Client {
  const base = /^https?:\/\//.test(addr) ? addr.replace(/\/$/, "") : `http://${addr.replace(/\/$/, "")}`;
  return directClient(base, authToken);
}

function directClient(base: string, authToken: string): Client {
  return {
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (authToken) headers.set("authorization", `Bearer ${authToken}`);
      if (init.body !== undefined) headers.set("content-type", "application/json");
      const response = await fetch(`${base}${path}`, {
        ...init,
        headers,
        signal: AbortSignal.timeout(10_000)
      });
      const text = await response.text();
      let body: any = null;
      if (text.trim()) {
        try { body = JSON.parse(text); } catch { body = text; }
      }
      return { body, status: response.status };
    }
  };
}

function parseArgs(argv: string[]): Options {
  const command = argv[0]?.trim() ?? "";
  const values: Record<string, string> = {};
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index] ?? "";
    if (!key.startsWith("--")) throw new Error(`unknown argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    values[key.slice(2)] = value;
    index += 1;
  }
  const artifactDir = resolve(values["artifact-dir"] || DEFAULT_ARTIFACT_DIR);
  const scenario = values.scenario ?? "";
  if (scenario && !SCENARIOS.includes(scenario as Scenario)) throw new Error(`unknown scenario: ${scenario}`);
  return {
    addr: values.addr || process.env.CODEX_RUNNER_ADDR || "127.0.0.1:3008",
    artifactDir,
    command,
    cycle: Number(values.cycle || "1"),
    db: values.db || "",
    manifest: resolve(values.manifest || join(artifactDir, "manifest.json")),
    scenario: scenario as Scenario | "",
    stateDir: resolve(values["state-dir"] || join(artifactDir, "fixture-state")),
    token: process.env.CODEX_RUNNER_AUTH_TOKEN || "",
    tokenFile: values["token-file"] || process.env.CODEX_RUNNER_AUTH_TOKEN_FILE || ""
  };
}

function token(options: Options): string {
  if (options.token) return options.token.trim();
  if (!options.tokenFile) return "";
  return readFileSync(resolve(options.tokenFile), "utf8").trim();
}

function readManifest(path: string): FixtureManifest {
  const manifest = JSON.parse(readFileSync(resolve(path), "utf8")) as FixtureManifest;
  assertManifest(manifest);
  return manifest;
}

function assertManifest(manifest: FixtureManifest): void {
  if (manifest.contract !== CONTRACT || manifest.project_id !== PROJECT_ID || manifest.source_marker !== SOURCE_MARKER) {
    throw new Error("fixture manifest contract/scope mismatch");
  }
  if (manifest.issues.length !== SCENARIOS.length) throw new Error("fixture manifest must contain three scenarios");
}

function expectStatus(response: { body: any; status: number }, status: number, action: string): void {
  if (response.status !== status) {
    throw new Error(`${action} returned HTTP ${response.status}: ${JSON.stringify(response.body)}`);
  }
}

function positiveInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function arrayBody(value: unknown): any[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Json).items)) return (value as Json).items;
  return [];
}

function readInteger(path: string): number {
  try {
    const value = Number(readFileSync(path, "utf8").trim());
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

function containsNull(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.some(containsNull);
  if (typeof value === "object") return Object.values(value as Json).some(containsNull);
  return false;
}

function atPath(value: Json, path: string): unknown {
  return path.split(".").reduce<any>((current, key) => current?.[key], value);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}
