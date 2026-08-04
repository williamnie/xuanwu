#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../backend-ts/src/db/database.ts";
import { listStoredHandoffs } from "../backend-ts/src/db/repositories/handoffs.ts";
import { listExternalEvents, upsertExternalEvent } from "../backend-ts/src/db/repositories/externalEvents.ts";
import { getAttentionInboxItem } from "../backend-ts/src/db/repositories/intakeRuns.ts";
import { listIssues } from "../backend-ts/src/db/repositories/issues.ts";
import {
  getActionProposal,
  listActionProposals,
  listPiActionEvents,
  listPiActions
} from "../backend-ts/src/db/repositories/pi.ts";
import { listPersistedAttention } from "../backend-ts/src/domain/attention/persistence.ts";
import { completeIssueFromRuntimeEvidence } from "../backend-ts/src/domain/evidence/completionGate.ts";
import { recordIssueRunGitWorkspaceBaseline } from "../backend-ts/src/domain/evidence/runGitWorkspaceBaseline.ts";
import { createDefaultRouter } from "../backend-ts/src/http/server.ts";
import { createPendingPiAction } from "../backend-ts/src/pi/actionEngine.ts";
import { runDomainSkillAndMarkProposal } from "../backend-ts/src/pi/domainSkillRun.ts";
import { routeRawEventToIntake, type EventRouterSourcePolicy } from "../backend-ts/src/pi/eventRouter.ts";
import type { LlmIntakeModel, LlmIntakeRequest } from "../backend-ts/src/pi/llmIntake.ts";
import { loadAssistantToolRegistrySnapshot } from "../backend-ts/src/pi/toolRegistrySnapshot.ts";
import { readSkillRegistry, type SkillMetadata } from "../backend-ts/src/skills/registry.ts";
import type { SkillRuntimeHandler } from "../backend-ts/src/skills/runtime.ts";

const ISSUE_ID = 784;
const PROJECT_ID = "agent-08-fixture";
const SOURCE = "agent-08-sandbox";
const SKILL_ID = "agent-08-intake-mcp-read";
const SKILL_HANDLER = "fixture:agent-08-intake-mcp-read";
const MCP_SERVER_ID = "agent-08-fixture";
const MCP_PROVIDER_ID = `mcp-${MCP_SERVER_ID}`;
const MCP_CAPABILITY_ID = `${MCP_SERVER_ID}:tool:fixture_read`;
const CONTRACT = "xw.agentic-activation.issue-784-observer.v1";
const SAMPLE_CONTRACT = "xw.agentic-activation.issue-784-sample.v1";
const REPORT_CONTRACT = "xw.agentic-activation.issue-report.v1";
const DEFAULT_ARTIFACT_DIR = ".runner/artifacts/agentic-activation/issue-784";
const VERIFY_COMMAND = "bun test scripts/intake-observability-live.test.ts";
const SCENARIOS = ["direct_success", "recoverable_failure", "human_help"] as const;

type Scenario = typeof SCENARIOS[number];
type Json = Record<string, any>;
type Assertion = { detail?: unknown; evidence: string; id: string; passed: boolean };
type TimelineEvent = {
  action: string;
  at: string;
  detail: Json;
  kind: "input" | "decision" | "action" | "state" | "result";
  phase: string;
  reason: string;
  result: "started" | "passed" | "failed" | "observed";
  target: string;
};
type Watermark = Record<string, number>;
type SamplerState = {
  contract: "xw.agentic-activation.issue-784-sampler-state.v1";
  cycle: number;
  watermark_end: Watermark;
  window_started_at: string;
};
type Sample = {
  contract: typeof SAMPLE_CONTRACT;
  cycle: number;
  facts: Json;
  sampled_at: string;
  watermark_end: Watermark;
  watermark_start: Watermark;
  window: { ended_at: string; started_at: string };
};
type Metric = { count: number; ids: string[]; drilldown: Json[] };
type LatencyMetric = { samples: Json[]; count: number; max_ms: number; p50_ms: number };
type ObserverReport = {
  contract: typeof CONTRACT;
  entity_index: Json;
  metrics: {
    agent_self_heal_success: Metric;
    detection_latency: LatencyMetric;
    direct_success: Metric;
    duplicate_execution: Metric;
    false_or_stale_help: Metric;
    final_failure: Metric;
    human_help: Metric;
    manual_status_modification: Metric;
    recovery_latency: LatencyMetric;
    total_work: Metric;
  };
  sample_cycles: number;
  watermark_end: Watermark;
  watermark_start: Watermark;
  window: { ended_at: string; started_at: string };
};
type IssueReport = {
  artifact_refs: string[];
  assertions: Assertion[];
  contract: typeof REPORT_CONTRACT;
  ended_at: string;
  failure_reasons: string[];
  issue_id: typeof ISSUE_ID;
  observer: ObserverReport | null;
  result: "passed" | "failed";
  started_at: string;
};
type FixtureContext = {
  artifactDir: string;
  controlPath: string;
  db: RunnerDatabase;
  env: Record<string, string>;
  repository: string;
  root: string;
  skill: SkillMetadata;
  statePath: string;
  toolSnapshot: ReturnType<typeof loadAssistantToolRegistrySnapshot>;
};

if (import.meta.main) {
  const command = process.argv[2] ?? "";
  const args = process.argv.slice(3);
  if (command === "exercise") {
    const artifactDir = resolve(option(args, "artifact-dir", DEFAULT_ARTIFACT_DIR));
    const report = await runIssue784Fixture(artifactDir);
    console.log(JSON.stringify(report, null, 2));
    if (report.result !== "passed") process.exitCode = 1;
  } else if (command === "report") {
    const input = resolve(requiredOption(args, "input"));
    const output = resolve(requiredOption(args, "output"));
    writeStableJson(output, reportFromSampleLog(input));
    console.log(JSON.stringify({ output, sha256: fileSha256(output) }, null, 2));
  } else if (command === "sample") {
    const result = await sampleObservationWindow({
      dbPath: resolve(requiredOption(args, "db")),
      outputPath: resolve(requiredOption(args, "output")),
      projectID: option(args, "project-id", ""),
      source: option(args, "source", ""),
      statePath: resolve(requiredOption(args, "state")),
      windowStartedAt: option(args, "window-start", "")
    });
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.error("usage: bun scripts/intake-observability-live.ts <exercise|sample|report> [options]");
    process.exit(64);
  }
}

export async function runIssue784Fixture(artifactDir: string): Promise<IssueReport> {
  rmSync(artifactDir, { recursive: true, force: true });
  mkdirSync(artifactDir, { recursive: true });
  const startedAt = new Date().toISOString();
  const timeline: TimelineEvent[] = [];
  const assertions: Assertion[] = [];
  let observer: ObserverReport | null = null;
  let fixture: FixtureContext | undefined;
  record(timeline, "fixture", "input", "start-short-window", "issue:784",
    "run three deterministic sampling cycles over isolated source/intake/action state", "started");
  try {
    fixture = await openFixture(artifactDir);
    const rawLog = join(artifactDir, "raw-samples.jsonl");
    const initialWatermark = watermarks(fixture.db);
    const windowStartedAt = new Date(Date.now() - 5_000).toISOString();
    const scenarioResults: Json[] = [];
    let previous = initialWatermark;

    for (let index = 0; index < SCENARIOS.length; index += 1) {
      const scenario = SCENARIOS[index]!;
      const result = await executeScenario(fixture, scenario, timeline);
      scenarioResults.push(result);
      const sample = sampleDatabase(fixture.db, index + 1, previous, windowStartedAt, {
        projectID: PROJECT_ID,
        source: SOURCE,
        toolProviderID: MCP_PROVIDER_ID
      });
      appendJsonLine(rawLog, sample);
      previous = sample.watermark_end;
      record(timeline, `sample-${index + 1}`, "state", "capture-watermark",
        `watermark:${index + 1}`, "sample persisted without model inference", "passed", {
          scenario,
          watermark_end: sample.watermark_end,
          watermark_start: sample.watermark_start
        });
    }

    const countsBeforeReplay = entityCounts(fixture.db);
    const toolStateBeforeReplay = fileSha256(fixture.statePath);
    const replayResults = [];
    for (const scenario of SCENARIOS) replayResults.push(await replayScenario(fixture, scenario));
    const countsAfterReplay = entityCounts(fixture.db);
    const toolStateAfterReplay = fileSha256(fixture.statePath);
    const replay = {
      counts_after: countsAfterReplay,
      counts_before: countsBeforeReplay,
      no_entity_growth: stableJson(countsBeforeReplay) === stableJson(countsAfterReplay),
      results: replayResults,
      tool_state_sha256_after: toolStateAfterReplay,
      tool_state_sha256_before: toolStateBeforeReplay,
      tool_state_unchanged: toolStateBeforeReplay === toolStateAfterReplay
    };
    writeStableJson(join(artifactDir, "replay-results.json"), replay);
    record(timeline, "replay", "result", "replay-all-inputs", "fixture:all",
      "source dedupe must stop before intake, skill, proposal, Work, Attention, and tool execution",
      replay.no_entity_growth && replay.tool_state_unchanged ? "passed" : "failed", replay);

    observer = reportFromSampleLog(rawLog);
    writeStableJson(join(artifactDir, "short-window-report.json"), observer);
    const regenerated = reportFromSampleLog(rawLog);
    writeStableJson(join(artifactDir, "short-window-report-regenerated.json"), regenerated);
    const firstHash = fileSha256(join(artifactDir, "short-window-report.json"));
    const secondHash = fileSha256(join(artifactDir, "short-window-report-regenerated.json"));
    writeStableJson(join(artifactDir, "report-hashes.json"), {
      algorithm: "sha256",
      first: firstHash,
      match: firstHash === secondHash,
      regenerated: secondHash
    });
    writeStableJson(join(artifactDir, "scenario-results.json"), scenarioResults);
    writeReplay(artifactDir);

    const expected = expectedMetrics();
    assertions.push(
      assertion("three_real_e2e_match_observer_classification",
        observer.metrics.total_work.count === 3 &&
        observer.metrics.direct_success.count === 1 &&
        observer.metrics.agent_self_heal_success.count === 1 &&
        observer.metrics.human_help.count === 1 &&
        observer.metrics.final_failure.count === 0,
        "scenario-results.json + short-window-report.json", observer.metrics),
      assertion("success_path_uses_skill_and_mcp_read_before_unique_work",
        scenarioResults.every((item) => item.skill_run_id && item.tool_call_event_ids.length === 1 &&
          item.proposal_id && item.work_id) &&
        scenarioResults.filter((item) => item.scenario !== "human_help")
          .every((item) => item.handoff_id && item.final_status === "done"),
        "scenario-results.json", scenarioResults),
      assertion("recoverable_failure_aggregates_by_work_not_attempt",
        observer.metrics.agent_self_heal_success.count === 1 &&
        observer.metrics.final_failure.count === 0 &&
        observer.metrics.recovery_latency.count === 1 &&
        observer.metrics.recovery_latency.max_ms > 0,
        "short-window-report.json", observer.metrics.agent_self_heal_success),
      assertion("missing_authorization_creates_one_help_without_write",
        scenarioResults.find((item) => item.scenario === "human_help")?.attention_ids.length === 1 &&
        scenarioResults.find((item) => item.scenario === "human_help")?.approval_action_status === "pending" &&
        scenarioResults.find((item) => item.scenario === "human_help")?.write_effects === 0,
        "scenario-results.json"),
      assertion("three_sampling_cycles_have_bounded_watermarks",
        observer.sample_cycles === 3 &&
        observer.metrics.detection_latency.count === 3 &&
        observer.metrics.detection_latency.max_ms > 0 &&
        Object.keys(observer.watermark_start).length > 0 &&
        Object.keys(observer.watermark_end).every((key) =>
          observer!.watermark_end[key]! >= observer!.watermark_start[key]!),
        "raw-samples.jsonl + short-window-report.json"),
      assertion("every_metric_drills_down_to_authoritative_ids",
        metricDrilldownComplete(observer),
        "short-window-report.json", observer.entity_index),
      assertion("fixed_fixture_validates_every_counter",
        Object.entries(expected).every(([key, value]) =>
          (observer!.metrics as unknown as Record<string, Metric>)[key]?.count === value),
        "short-window-report.json", expected),
      assertion("replay_is_idempotent_without_tool_side_effect",
        replay.no_entity_growth && replay.tool_state_unchanged &&
        replay.results.every((item) => item.status === "skipped" && item.reason === "duplicate_raw_event"),
        "replay-results.json", replay),
      assertion("raw_log_regeneration_hash_is_stable",
        firstHash === secondHash,
        "raw-samples.jsonl + report-hashes.json", { firstHash, secondHash })
    );
  } catch (error) {
    assertions.push(assertion("exercise_completed", false, "timeline.jsonl", safeMessage(error)));
    record(timeline, "fatal", "result", "exercise", "issue:784", safeMessage(error), "failed");
  } finally {
    if (fixture) {
      fixture.db.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
  writeTimeline(join(artifactDir, "timeline.jsonl"), timeline);
  const failureReasons = assertions.filter((item) => !item.passed)
    .map((item) => `assertion failed: ${item.id}`);
  const report: IssueReport = {
    artifact_refs: [
      "scenario-results.json",
      "raw-samples.jsonl",
      "short-window-report.json",
      "short-window-report-regenerated.json",
      "report-hashes.json",
      "replay-results.json",
      "timeline.jsonl",
      "replay.md"
    ],
    assertions,
    contract: REPORT_CONTRACT,
    ended_at: new Date().toISOString(),
    failure_reasons: failureReasons,
    issue_id: ISSUE_ID,
    observer,
    result: failureReasons.length === 0 ? "passed" : "failed",
    started_at: startedAt
  };
  writeStableJson(join(artifactDir, "report.json"), report);
  return report;
}

export function reportFromSampleLog(path: string): ObserverReport {
  const samples = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as Sample);
  if (samples.length === 0) throw new Error("sample log is empty");
  if (samples.some((sample) => sample.contract !== SAMPLE_CONTRACT)) {
    throw new Error("sample log contract mismatch");
  }
  samples.forEach((sample, index) => {
    if (sample.cycle !== index + 1) throw new Error(`sample cycle ${sample.cycle} is not contiguous`);
    if (index > 0 && stableJson(sample.watermark_start) !== stableJson(samples[index - 1]!.watermark_end)) {
      throw new Error(`sample cycle ${sample.cycle} watermark does not continue the previous cycle`);
    }
    if (sample.window.started_at !== samples[0]!.window.started_at) {
      throw new Error(`sample cycle ${sample.cycle} changed window start`);
    }
  });
  return aggregateSamples(samples);
}

export async function sampleObservationWindow(input: {
  dbPath: string;
  outputPath: string;
  projectID?: string;
  source?: string;
  statePath: string;
  windowStartedAt?: string;
}): Promise<{ cycle: number; output: string; state: string; watermark_end: Watermark; window: Sample["window"] }> {
  if (existsSync(input.outputPath) && !existsSync(input.statePath)) {
    throw new Error("sample output exists without sampler state; use a new output/state pair");
  }
  if (existsSync(input.statePath) && !existsSync(input.outputPath)) {
    throw new Error("sampler state exists without sample output; restore the log or use a new state");
  }
  const database = await openDatabase({ readonlyImportPath: input.dbPath });
  try {
    const existing = readSamplerState(input.statePath);
    const now = new Date().toISOString();
    const windowStartedAt = existing?.window_started_at || optionalIso(input.windowStartedAt, "window start") || now;
    const watermarkStart = existing?.watermark_end ?? watermarks(database);
    const cycle = (existing?.cycle ?? 0) + 1;
    const sample = sampleDatabase(database, cycle, watermarkStart, windowStartedAt, {
      projectID: clean(input.projectID),
      source: clean(input.source)
    });
    appendJsonLine(input.outputPath, sample);
    writeStableJson(input.statePath, {
      contract: "xw.agentic-activation.issue-784-sampler-state.v1",
      cycle,
      watermark_end: sample.watermark_end,
      window_started_at: windowStartedAt
    } satisfies SamplerState);
    return {
      cycle,
      output: input.outputPath,
      state: input.statePath,
      watermark_end: sample.watermark_end,
      window: sample.window
    };
  } finally {
    database.close();
  }
}

function aggregateSamples(samples: Sample[]): ObserverReport {
  const merged = mergeFacts(samples.map((sample) => sample.facts));
  const works = merged.works as Json[];
  const runs = merged.runs as Json[];
  const attempts = merged.run_attempts as Json[];
  const attentions = merged.attentions as Json[];
  const proposals = merged.proposals as Json[];
  const actions = merged.actions as Json[];
  const events = merged.issue_events as Json[];
  const externalEvents = merged.external_events as Json[];
  const inbox = merged.inbox_items as Json[];
  const handoffs = merged.handoffs as Json[];
  const toolCalls = merged.tool_calls as Json[];
  const direct: Json[] = [];
  const selfHeal: Json[] = [];
  const failed: Json[] = [];
  const human: Json[] = [];
  const stale: Json[] = [];
  const detection: Json[] = [];
  const recovery: Json[] = [];

  for (const work of works) {
    const workRuns = runs.filter((run) => run.issue_id === work.id);
    const workAttempts = attempts.filter((attempt) => workRuns.some((run) => run.run_id === attempt.run_id));
    const workAttention = attentions.filter((attention) => attention.issue_ids.includes(work.id));
    const failedRuns = workRuns.filter((run) => run.status === "failed");
    const failedAttempts = workAttempts.filter((attempt) => attempt.status === "failed");
    const detail = workDetail(work, merged);
    if (work.status === "done" && failedRuns.length + failedAttempts.length === 0) direct.push(detail);
    if (work.status === "done" && failedRuns.length + failedAttempts.length > 0) selfHeal.push(detail);
    if (work.status === "failed") failed.push(detail);
    if (workAttention.some((item) => !["resolved", "dismissed"].includes(item.status))) human.push(detail);
    if (["done", "failed", "cancelled"].includes(work.status) &&
      workAttention.some((item) => !["resolved", "dismissed"].includes(item.status))) stale.push(detail);

    const item = inbox.find((entry) => entry.id === work.inbox_item_id);
    const source = externalEvents.find((entry) => item?.event_refs?.includes(entry.id));
    if (source) {
      detection.push({
        detected_at: work.created_at,
        event_id: `external_event:${source.id}`,
        latency_ms: nonNegativeMs(source.occurred_at, work.created_at),
        work_id: work.work_id
      });
    }
    const firstFailure = [...failedRuns.map((run) => ({
      at: run.ended_at || run.started_at,
      id: run.run_id
    })), ...failedAttempts.map((attempt) => ({
      at: attempt.ended_at || attempt.started_at,
      id: attempt.attempt_id
    }))].sort((left, right) => left.at.localeCompare(right.at))[0];
    const success = workRuns.filter((run) => ["done", "pending_verification"].includes(run.status))
      .sort((left, right) => (right.ended_at || right.started_at).localeCompare(left.ended_at || left.started_at))[0];
    if (firstFailure && success) {
      recovery.push({
        failure_id: firstFailure.id,
        recovered_at: success.ended_at || success.started_at,
        latency_ms: nonNegativeMs(firstFailure.at, success.ended_at || success.started_at),
        run_id: success.run_id,
        work_id: work.work_id
      });
    }
  }

  const duplicates = duplicateDetails({ actions, proposals, runs, toolCalls, works });
  const manual = events.filter((event) =>
    event.type === "issue.status.manual" ||
    event.type === "issue.status_changed" && ["user", "operator", "manual"].includes(clean(event.actor)));
  const start = samples[0]!;
  const end = samples.at(-1)!;
  return {
    contract: CONTRACT,
    entity_index: {
      action_ids: actions.map((item) => item.id),
      attention_ids: attentions.map((item) => item.id),
      event_ids: events.map((item) => `issue_event:${item.id}`),
      handoff_ids: handoffs.map((item) => item.id),
      proposal_ids: proposals.map((item) => item.id),
      run_ids: runs.map((item) => item.run_id),
      tool_call_ids: toolCalls.map((item) => item.tool_call_id),
      work_ids: works.map((item) => item.work_id)
    },
    metrics: {
      agent_self_heal_success: metric(selfHeal, "work_id"),
      detection_latency: latencyMetric(detection),
      direct_success: metric(direct, "work_id"),
      duplicate_execution: metric(duplicates, "id"),
      false_or_stale_help: metric(stale, "work_id"),
      final_failure: metric(failed, "work_id"),
      human_help: metric(uniqueBy(human, (item) => item.work_id), "work_id"),
      manual_status_modification: metric(manual.map((event) => ({
        event_id: `issue_event:${event.id}`,
        id: `issue_event:${event.id}`,
        work_id: `xw:work:issues:${event.issue_id}`
      })), "id"),
      recovery_latency: latencyMetric(recovery),
      total_work: metric(works.map((work) => workDetail(work, merged)), "work_id")
    },
    sample_cycles: samples.length,
    watermark_end: end.watermark_end,
    watermark_start: start.watermark_start,
    window: { ended_at: end.window.ended_at, started_at: start.window.started_at }
  };
}

async function openFixture(artifactDir: string): Promise<FixtureContext> {
  const root = await mkdtemp(join(tmpdir(), "issue-784-intake-observer-"));
  const repository = join(root, "repository");
  const stateDir = join(root, "state");
  const skillRoot = join(root, "skills");
  const controlPath = join(root, "mcp-control.json");
  const statePath = join(root, "mcp-state.json");
  mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-q"]);
  writeFileSync(join(repository, "README.md"), "AGENT-08 isolated fixture\n");
  git(repository, ["add", "README.md"]);
  gitCommit(repository, "fixture baseline");
  writeFileSync(controlPath, JSON.stringify({ online: true }) + "\n");
  writeFileSync(statePath, JSON.stringify({ value: "agent-08-read-only" }) + "\n");
  await writeFixtureSkill(skillRoot);
  const db = await openDatabase({ stateDir });
  insertProject(db, repository);
  const env = {
    XUANWU_MCP_REGISTRY_JSON: registryJson(controlPath, statePath)
  };
  const toolSnapshot = loadAssistantToolRegistrySnapshot(db, { env });
  const skill = loadFixtureSkill(skillRoot, toolSnapshot);
  writeStableJson(join(artifactDir, "fixture-manifest.json"), {
    contract: CONTRACT,
    expected_metrics: expectedMetrics(),
    external_writes: 0,
    issue_id: ISSUE_ID,
    mcp_capability_id: MCP_CAPABILITY_ID,
    sample_cycles: 3,
    scenarios: SCENARIOS,
    skill_id: SKILL_ID
  });
  return {
    artifactDir, controlPath, db, env, repository, root, skill, statePath, toolSnapshot
  };
}

async function executeScenario(
  fixture: FixtureContext,
  scenario: Scenario,
  timeline: TimelineEvent[]
): Promise<Json> {
  const event = upsertExternalEvent(fixture.db, fixtureEvent(scenario), new Date());
  record(timeline, scenario, "input", "ingest-source-event", `external_event:${event.id}`,
    "sandbox source event accepted with deterministic dedupe key", "passed", { scenario });
  const route = await routeRawEventToIntake(
    fixture.db,
    event,
    listExternalEvents(fixture.db, { source: SOURCE }),
    intakeModel(scenario),
    { now: new Date(), policy: sourcePolicy(), skillId: `agent-08-intake-${scenario}` }
  );
  if (route.status !== "routed" || !route.result?.created_items[0]) {
    throw new Error(`${scenario} intake did not route`);
  }
  const item = route.result.created_items[0];
  record(timeline, scenario, "decision", "intake-to-inbox", `attention_inbox_item:${item.id}`,
    route.reason, "passed", {
      bundle_id: route.bundle?.id,
      intake_run_id: route.result.run.id
    });
  const beforeAudit = maxID(fixture.db, "pi_action_events");
  const domain = await runDomainSkillAndMarkProposal(
    fixture.db,
    item,
    SKILL_ID,
    {
      env: fixture.env,
      handlers: { [SKILL_HANDLER]: fixtureHandler() },
      skill: fixture.skill,
      toolSnapshot: fixture.toolSnapshot
    }
  );
  const toolCalls = toolCallFacts(fixture.db).filter((call) => call.event_id > beforeAudit);
  if (toolCalls.length !== 1 || toolCalls[0]!.status !== "succeeded") {
    throw new Error(`${scenario} did not execute exactly one audited MCP read`);
  }
  record(timeline, scenario, "action", "skill-mcp-read-and-propose", domain.proposal.id,
    "capability-granted Skill used the real MCP read-only transport", "passed", {
      skill_run_id: domain.runtime.run_id,
      tool_call_event_ids: toolCalls.map((call) => `pi_action_event:${call.event_id}`)
    });

  const router = createDefaultRouter({ database: fixture.db });
  const approved = await jsonRequest(router,
    `/api/pi/action-proposals/${encodeURIComponent(domain.proposal.id)}/approve`, {
      body: JSON.stringify({ actor: "agent-08-fixture-policy" }),
      method: "POST"
    });
  const action = approved.actions?.[0];
  const issueID = Number(action?.result?.id ?? action?.result?.issue_id ?? 0);
  if (!Number.isSafeInteger(issueID) || issueID <= 0) {
    throw new Error(`${scenario} proposal did not create Work`);
  }
  const issue = listIssues(fixture.db, { projectId: PROJECT_ID }).find((entry) => entry.id === issueID);
  if (!issue) throw new Error(`${scenario} Work missing after proposal approval`);
  record(timeline, scenario, "action", "policy-approve-and-create-work", `xw:work:issues:${issueID}`,
    "proposal approval executed one internal issue.create action", "passed", {
      action_id: action.pi_action_id,
      proposal_id: domain.proposal.id
    });

  let handoffID = "";
  let approvalActionStatus = "";
  let writeEffects = 0;
  if (scenario === "human_help") {
    const pending = createPendingPiAction(fixture.db, {
      source: "agent_08_missing_authorization"
    }, {
      actionType: "message.reply_send",
      authorization: {
        allowed_actions: ["message.reply_send"],
        mode: "manual",
        scope: { issue_id: issueID, project_id: PROJECT_ID }
      },
      idempotencyKey: `agent-08:${scenario}:external-write`,
      issueID,
      payload: {
        content: "fixture-only payload",
        proposal_id: domain.proposal.id,
        source_item_ids: [`attention_inbox_item:${item.id}`]
      },
      projectID: PROJECT_ID,
      rationale: "missing fixture authorization must ask",
      riskOverride: { requiresConfirmation: true, riskLevel: "high" }
    }, () => {
      writeEffects += 1;
      return { written: true };
    }) as Json;
    approvalActionStatus = clean(pending.status);
    if (approvalActionStatus !== "pending") throw new Error("human_help did not stop at approval");
  } else {
    handoffID = await completeWork(fixture, issueID, scenario);
  }

  const attentionIDs = listPersistedAttention(fixture.db)
    .filter((attention) => attention.source_refs.some((ref) =>
      ref.correlation_refs.includes(`issue:${issueID}`)))
    .filter((attention) => !["resolved", "dismissed"].includes(attention.status))
    .map((attention) => attention.id);
  if (scenario === "human_help" && attentionIDs.length !== 1) {
    throw new Error(`human_help expected one active Attention, found ${attentionIDs.length}`);
  }
  const finalIssue = listIssues(fixture.db, { projectId: PROJECT_ID }).find((entry) => entry.id === issueID)!;
  return {
    approval_action_status: approvalActionStatus,
    attention_ids: attentionIDs,
    bundle_id: route.bundle!.id,
    final_status: finalIssue.status,
    handoff_id: handoffID,
    intake_run_id: route.result.run.id,
    proposal_id: domain.proposal.id,
    scenario,
    skill_run_id: domain.runtime.run_id,
    source_event_id: event.id,
    tool_call_event_ids: toolCalls.map((call) => call.event_id),
    work_id: `xw:work:issues:${issueID}`,
    write_effects: writeEffects
  };
}

async function replayScenario(fixture: FixtureContext, scenario: Scenario): Promise<Json> {
  const event = upsertExternalEvent(fixture.db, fixtureEvent(scenario), new Date());
  const route = await routeRawEventToIntake(
    fixture.db,
    event,
    listExternalEvents(fixture.db, { source: SOURCE }),
    intakeModel(scenario),
    { now: new Date(), policy: sourcePolicy(), skillId: `agent-08-intake-${scenario}` }
  );
  return { reason: route.reason, scenario, status: route.status };
}

async function completeWork(
  fixture: FixtureContext,
  issueID: number,
  scenario: Exclude<Scenario, "human_help">
): Promise<string> {
  const now = Date.now();
  fixture.db.sqlite.run("update issues set status='in_progress', updated_at=? where id=?", [
    new Date(now).toISOString(), issueID
  ]);
  if (scenario === "recoverable_failure") {
    insertIssueRun(fixture.db, issueID, 1, "failed", {
      endedAt: new Date(now - 800).toISOString(),
      error: "fixture transient failure",
      startedAt: new Date(now - 1_000).toISOString()
    });
  }
  const attempt = scenario === "recoverable_failure" ? 2 : 1;
  const baseRevision = gitText(fixture.repository, ["rev-parse", "HEAD"]);
  const startedAt = new Date(now - 700).toISOString();
  const runID = insertIssueRun(fixture.db, issueID, attempt, "in_progress", {
    baseRevision,
    startedAt
  });
  recordIssueRunGitWorkspaceBaseline(fixture.db, issueID, {
    base_revision: baseRevision,
    captured_at: startedAt,
    repository_path: fixture.repository,
    run_id: runID
  });
  const relativePath = `deliveries/${scenario}-${issueID}.txt`;
  const path = join(fixture.repository, relativePath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${scenario} verified\n`);
  git(fixture.repository, ["add", "--", relativePath]);
  gitCommit(fixture.repository, `${scenario} verified`);
  insertVerificationEvent(fixture.db, issueID, runID, attempt, new Date(now - 100).toISOString());
  const completion = await completeIssueFromRuntimeEvidence(
    fixture.db,
    issueID,
    { error: "", status: "done" },
    {
      actor: { id: "agent-08-fixture", kind: "automation" },
      correlation_id: `agent-08:${scenario}:${issueID}`,
      now: new Date(now).toISOString(),
      source: "agent-08-intake-observability-fixture"
    }
  );
  if (completion.issue.status !== "done") {
    throw new Error(`${scenario} completion gate returned ${completion.issue.status}: ${stableJson({
      error: completion.issue.error,
      evaluation: completion.evaluation,
      target_status: completion.target_status
    })}`);
  }
  const handoffs = listStoredHandoffs(fixture.db, {
    limit: 10,
    work_id: `xw:work:issues:${issueID}`
  }).items;
  if (handoffs.length !== 1 || handoffs[0]!.handoff.status !== "ready") {
    throw new Error(`${scenario} missing ready Handoff`);
  }
  return handoffs[0]!.handoff.id;
}

function sampleDatabase(
  db: RunnerDatabase,
  cycle: number,
  watermarkStart: Watermark,
  windowStartedAt: string,
  scope: { projectID?: string; source?: string; toolProviderID?: string } = {}
): Sample {
  const watermarkEnd = watermarks(db);
  const sampledAt = new Date().toISOString();
  return {
    contract: SAMPLE_CONTRACT,
    cycle,
    facts: databaseFacts(db, windowStartedAt, scope),
    sampled_at: sampledAt,
    watermark_end: watermarkEnd,
    watermark_start: watermarkStart,
    window: { ended_at: sampledAt, started_at: windowStartedAt }
  };
}

function databaseFacts(
  db: RunnerDatabase,
  windowStartedAt: string,
  scope: { projectID?: string; source?: string; toolProviderID?: string }
): Json {
  const projectID = clean(scope.projectID);
  const source = clean(scope.source);
  const bundles = rows(db, "select id, event_refs_json from context_bundles order by id")
    .map((row) => ({ event_refs: jsonArray(row.event_refs_json), id: row.id }));
  const allInbox = rows(db, `select id, bundle_id, intake_run_id, status, created_at
    from attention_inbox_items order by id`).map((row) => ({
      ...row,
      event_refs: bundles.find((bundle) => bundle.id === row.bundle_id)?.event_refs ?? []
    }));
  const allProposals = listActionProposals(db).map((proposal) => ({
    id: proposal.id,
    source_item_ids: proposal.source_item_ids,
    status: proposal.status
  }));
  const allActions = listPiActions(db).map((action) => ({
    action_type: action.action_type,
    id: action.id,
    idempotency_key: action.idempotency_key,
    issue_id: action.issue_id,
    status: action.status
  }));
  const issues = listIssues(db, projectID ? { projectId: projectID } : {})
    .filter((issue) => issue.created_at >= windowStartedAt || issue.updated_at >= windowStartedAt);
  const works = issues.map((issue) => {
    const inboxID = Number(/^attention_inbox_item:(\d+)$/.exec(issue.source_turn_id)?.[1] ?? 0);
    return {
      created_at: issue.created_at,
      id: issue.id,
      inbox_item_id: inboxID,
      source_turn_id: issue.source_turn_id,
      status: issue.status,
      updated_at: issue.updated_at,
      work_id: `xw:work:issues:${issue.id}`
    };
  });
  const issueIDs = new Set(works.map((work) => work.id));
  const issueIDList = [...issueIDs];
  const runs = scopedRows(db, `select id, run_id, issue_id, attempt, status, started_at, ended_at, error
    from issue_runs`, "issue_id", issueIDList, "order by issue_id, attempt");
  const runIDs = new Set(runs.map((run) => run.run_id));
  const runAttempts = scopedRows(db, `select attempt_id, run_id, sequence, kind, status,
    started_at, ended_at, terminal_reason from run_attempts`, "run_id", [...runIDs], "order by run_id, sequence");
  const rawIssueEvents = scopedRows(db,
    "select id, issue_id, type, payload, created_at from issue_events",
    "issue_id",
    issueIDList,
    "order by id");
  const issueEvents = rawIssueEvents
    .map((event) => ({ ...event, actor: eventActor(event.payload), payload: redactPayload(event.payload) }));
  const inboxIDs = new Set(works.map((work) => work.inbox_item_id).filter((id) => id > 0));
  const inbox = allInbox.filter((item) => inboxIDs.has(item.id));
  const proposals = allProposals.filter((proposal) => proposal.source_item_ids.some((ref: string) => {
    const id = Number(/^attention_inbox_item:(\d+)$/.exec(ref)?.[1] ?? 0);
    return inboxIDs.has(id);
  }));
  const proposalIDs = actionsForProposal(proposals);
  const actions = allActions.filter((action) =>
    issueIDs.has(action.issue_id) || proposalAction(proposalIDs, action));
  const externalEventIDs = new Set(inbox.flatMap((item) => item.event_refs));
  const externalEvents = rows(db, "select id, occurred_at, source from external_events order by id")
    .filter((event) => externalEventIDs.has(event.id) && (!source || event.source === source));
  const attentions = listPersistedAttention(db).flatMap((attention) => {
    const issueIDs = attention.source_refs.flatMap((ref) => ref.correlation_refs)
      .map((ref) => Number(/^issue:(\d+)$/.exec(ref)?.[1] ?? 0))
      .filter((id) => id > 0);
    return issueIDs.some((id) => works.some((work) => work.id === id))
      ? [{
        id: attention.id,
        issue_ids: [...new Set(issueIDs)],
        revision: attention.revision,
        status: attention.status
      }]
      : [];
  });
  const handoffs = handoffFacts(rawIssueEvents);
  return {
    actions,
    attentions,
    external_events: externalEvents,
    handoffs,
    inbox_items: inbox,
    issue_events: issueEvents,
    proposals,
    run_attempts: runAttempts,
    runs,
    tool_calls: toolCallFacts(db, scope.toolProviderID, windowStartedAt),
    works
  };
}

function mergeFacts(facts: Json[]): Json {
  const keys = [
    "actions", "attentions", "external_events", "handoffs", "inbox_items",
    "issue_events", "proposals", "run_attempts", "runs", "tool_calls", "works"
  ];
  const identity: Record<string, (item: Json) => string> = {
    actions: (item) => item.id,
    attentions: (item) => item.id,
    external_events: (item) => String(item.id),
    handoffs: (item) => item.id,
    inbox_items: (item) => String(item.id),
    issue_events: (item) => String(item.id),
    proposals: (item) => item.id,
    run_attempts: (item) => item.attempt_id,
    runs: (item) => item.run_id,
    tool_calls: (item) => item.tool_call_id,
    works: (item) => item.work_id
  };
  return Object.fromEntries(keys.map((key) => {
    const map = new Map<string, Json>();
    for (const snapshot of facts) {
      for (const item of snapshot[key] ?? []) map.set(identity[key]!(item), item);
    }
    return [key, [...map.values()].sort((left, right) =>
      identity[key]!(left).localeCompare(identity[key]!(right), "en", { numeric: true }))];
  }));
}

function workDetail(work: Json, facts: Json): Json {
  const proposals = (facts.proposals as Json[]).filter((proposal) =>
    proposal.source_item_ids.includes(`attention_inbox_item:${work.inbox_item_id}`));
  const actions = (facts.actions as Json[]).filter((action) =>
    action.issue_id === work.id || proposalAction(actionsForProposal(proposals), action));
  const runs = (facts.runs as Json[]).filter((run) => run.issue_id === work.id);
  const attentions = (facts.attentions as Json[]).filter((attention) => attention.issue_ids.includes(work.id));
  const handoffs = (facts.handoffs as Json[]).filter((handoff) => handoff.work_id === work.work_id);
  return {
    action_ids: actions.map((item) => item.id),
    attention_ids: attentions.map((item) => item.id),
    handoff_ids: handoffs.map((item) => item.id),
    proposal_ids: proposals.map((item) => item.id),
    run_ids: runs.map((item) => item.run_id),
    status: work.status,
    work_id: work.work_id
  };
}

function duplicateDetails(input: {
  actions: Json[];
  proposals: Json[];
  runs: Json[];
  toolCalls: Json[];
  works: Json[];
}): Json[] {
  return [
    ...duplicateGroups(input.works, (item) => item.source_turn_id, "work"),
    ...duplicateGroups(input.proposals.flatMap((proposal) =>
      proposal.source_item_ids.map((source: string) => ({ id: proposal.id, source }))),
    (item) => item.source, "proposal"),
    ...duplicateGroups(input.runs, (item) => `${item.issue_id}:${item.attempt}`, "run"),
    ...duplicateGroups(input.actions.filter((item) => item.idempotency_key),
      (item) => item.idempotency_key, "action"),
    ...duplicateGroups(input.toolCalls, (item) => item.tool_call_id, "tool_call")
  ];
}

function duplicateGroups(items: Json[], key: (item: Json) => string, kind: string): Json[] {
  const groups = new Map<string, Json[]>();
  for (const item of items) {
    const value = clean(key(item));
    if (!value) continue;
    groups.set(value, [...(groups.get(value) ?? []), item]);
  }
  return [...groups.entries()].filter(([, values]) => values.length > 1).map(([value, values]) => ({
    id: `${kind}:${value}`,
    kind,
    key: value,
    member_ids: values.map((item) => item.id ?? item.run_id ?? item.tool_call_id)
  }));
}

function toolCallFacts(db: RunnerDatabase, providerID?: string, windowStartedAt = ""): Json[] {
  return listPiActionEvents(db, { eventType: "tool_call_audit" }).flatMap((event) => {
    const payload = parseObject(event.payload_json);
    if (providerID && payload.provider_id !== providerID) return [];
    if (windowStartedAt && event.created_at < windowStartedAt) return [];
    return [{
      created_at: event.created_at,
      event_id: event.id,
      permission: payload.permission,
      provider_id: payload.provider_id,
      status: payload.status,
      tool: payload.tool,
      tool_call_id: payload.tool_call_id
    }];
  });
}

function intakeModel(scenario: Scenario): LlmIntakeModel {
  return (request) => {
    const evidence = request.input.context_bundle.raw_event_summaries[0];
    if (!evidence) throw new Error("fixture intake context is empty");
    return {
      ignored_groups: [],
      inbox_items: [{
        actor_refs: [evidence.actor],
        confidence: 0.99,
        evidence_refs: [evidence.evidence_ref],
        intents: { primary: "create_task", secondary: [], tags: ["agent_08", scenario] },
        suggested_actions: ["issue.create"],
        summary: `AGENT-08 ${scenario} deterministic intake`,
        target_hints: [{
          confidence: 1,
          id: PROJECT_ID,
          kind: "project",
          reason: "isolated fixture project"
        }],
        title: `AGENT-08 ${scenario}`,
        urgency: "low"
      }]
    };
  };
}

function fixtureHandler(): SkillRuntimeHandler {
  return async (input, context) => {
    const item = input.inbox_item as Json;
    const read = await context.invokeTool(MCP_CAPABILITY_ID, {
      request_id: `attention-inbox-item:${item.id}`
    }) as Json;
    if (read.fixture !== "agent-05" || read.value !== "agent-08-read-only") {
      throw new Error(`fixture MCP read returned unexpected output: ${stableJson(read)}`);
    }
    return {
      action_proposals: [{
        evidence_refs: item.evidence_refs,
        id: `agent-08-issue-create-${item.id}`,
        payload: {
          body: `${item.summary}\n\nMCP read value: ${read.value}`,
          project_id: PROJECT_ID,
          status: "triage",
          title: item.title
        },
        rationale: "create one isolated Work after deterministic policy approval",
        requires_approval: true,
        risk: "medium",
        summary: item.summary,
        target_hints: item.target_hints,
        type: "issue.create"
      }],
      item_id: item.id,
      primary_intent: item.primary_intent,
      skill_id: context.skillID,
      summary: item.summary
    };
  };
}

async function writeFixtureSkill(root: string): Promise<void> {
  const dir = join(root, SKILL_ID);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), [
    "---",
    `name: ${SKILL_ID}`,
    "version: 1.0.0",
    "description: Use for the isolated AGENT-08 intake fixture after reading MCP state.",
    "---",
    "",
    "# AGENT-08 intake fixture",
    "",
    "Read the isolated MCP fixture through the granted read-only capability, then return one Work proposal."
  ].join("\n") + "\n");
  await writeFile(join(dir, "manifest.json"), JSON.stringify({
    execution: {
      adapter: "builtin",
      handler: SKILL_HANDLER,
      sandbox: "capability",
      timeout_ms: 5000
    },
    input_object: "inbox_item",
    input_schema: {
      properties: {
        context_retrieval: { type: "object" },
        inbox_item: {
          properties: {
            evidence_refs: { items: { type: "string" }, minItems: 1, type: "array" },
            id: { minimum: 1, type: "integer" },
            primary_intent: { minLength: 1, type: "string" },
            summary: { minLength: 1, type: "string" },
            target_hints: { items: { type: "object" }, type: "array" },
            title: { minLength: 1, type: "string" }
          },
          required: ["id", "evidence_refs", "primary_intent", "summary", "title"],
          type: "object"
        }
      },
      required: ["inbox_item"],
      type: "object"
    },
    intent_tags: ["create_task", "agentic_activation"],
    kind: "domain",
    manifest_version: "pi-skill.v0",
    output_objects: ["action_proposals"],
    output_schema: {
      properties: {
        action_proposals: { items: { type: "object" }, type: "array" },
        item_id: { type: "integer" },
        primary_intent: { type: "string" },
        skill_id: { type: "string" },
        summary: { type: "string" }
      },
      required: ["action_proposals", "item_id", "primary_intent", "skill_id", "summary"],
      type: "object"
    },
    permissions: { max_tool_permission: "read" },
    primary_intents: ["create_task"],
    required_tools: [MCP_CAPABILITY_ID],
  }, null, 2) + "\n");
}

function loadFixtureSkill(
  skillRoot: string,
  snapshot: ReturnType<typeof loadAssistantToolRegistrySnapshot>
): SkillMetadata {
  const registry = readSkillRegistry({
    availableTools: snapshot.tools.map((tool) => ({
      aliases: [clean(tool.metadata?.capability_id)].filter(Boolean),
      name: tool.name,
      permission: tool.permission,
      provider_id: tool.provider_id
    })),
    roots: [{ label: "agent-08", path: skillRoot }]
  });
  const skill = registry.items.find((item) => item.id === SKILL_ID);
  if (!skill) throw new Error(`fixture skill missing: ${registry.diagnostics.map((item) => item.code).join(",")}`);
  return skill;
}

function fixtureEvent(scenario: Scenario): Json {
  const occurredAt = new Date(Date.now() - 1_000).toISOString();
  return {
    actor: "fixture-user",
    content: `@PI AGENT-08 ${scenario}`,
    dedupe_key: `agent-08:${scenario}`,
    event_type: "message",
    external_id: `agent-08-${scenario}`,
    normalized_message: {
      bot_mentioned: true,
      message_id: `agent-08-${scenario}`,
      thread_id: `agent-08-${scenario}`
    },
    occurred_at: occurredAt,
    project_id: PROJECT_ID,
    provider: "fixture",
    received_at: occurredAt,
    source: SOURCE,
    trust_level: "untrusted"
  };
}

function sourcePolicy(): EventRouterSourcePolicy {
  return {
    action_mode: "propose_actions",
    automatic_intake_enabled: true,
    collect_raw_events: true,
    intake_mode: "continuous_llm_triage",
    issue_policy: { require_project_confirmation: false },
    profile: "custom"
  };
}

function registryJson(controlPath: string, statePath: string): string {
  return JSON.stringify({
    servers: [{
      id: MCP_SERVER_ID,
      name: "AGENT-08 fixture",
      readiness: "ready",
      risk_level: "low",
      status: "enabled",
      tools: [{
        description: "Read isolated AGENT-08 state.",
        input_schema: { properties: { request_id: { type: "string" } }, type: "object" },
        name: "fixture_read",
        output_schema: { type: "object" },
        permission: "read",
        read_only: true,
        requires_confirmation: false,
        risk_level: "low"
      }],
      transport: {
        args: [resolve("scripts/mcp-live-activation-server.ts")],
        command: process.execPath,
        env: {
          MCP_ACTIVATION_CONTROL_FILE: controlPath,
          MCP_ACTIVATION_STATE_FILE: statePath
        },
        type: "stdio"
      }
    }]
  });
}

function insertProject(db: RunnerDatabase, repository: string): void {
  const now = new Date().toISOString();
  db.sqlite.run(`insert into projects
    (id, name, cwd, provider, approval_policy, sandbox, created_at, updated_at)
    values (?, ?, ?, 'codex', 'never', 'danger-full-access', ?, ?)`, [
    PROJECT_ID, PROJECT_ID, repository, now, now
  ]);
}

function insertIssueRun(
  db: RunnerDatabase,
  issueID: number,
  attempt: number,
  status: string,
  options: { baseRevision?: string; endedAt?: string; error?: string; startedAt: string }
): string {
  const id = `issue-${issueID}-attempt-${attempt}`;
  db.sqlite.run(`insert into issue_runs
    (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
      git_base_revision, started_at, ended_at, error, exit_reason)
    values (?, ?, ?, ?, 'codex', ?, ?, ?, ?, ?, ?, ?)`, [
    id,
    issueID,
    attempt,
    status,
    `thread-agent-08-${issueID}-${attempt}`,
    `turn-agent-08-${issueID}-${attempt}`,
    options.baseRevision ?? "",
    options.startedAt,
    options.endedAt ?? "",
    options.error ?? "",
    status === "failed" ? "retryable_fixture_failure" : ""
  ]);
  return id;
}

function insertVerificationEvent(
  db: RunnerDatabase,
  issueID: number,
  issueRunID: string,
  attempt: number,
  completedAt: string
): void {
  const completedAtMs = Date.parse(completedAt);
  const runID = `xw:run:issue_runs:${issueRunID}`;
  db.sqlite.run(`insert into issue_events (issue_id, type, payload, created_at)
    values (?, 'issue.log', ?, ?)`, [
    issueID,
    JSON.stringify({
      raw_method: "item/completed",
      raw_payload: JSON.stringify({
        item: {
          aggregatedOutput: "AGENT-08 focused fixture verification passed",
          command: VERIFY_COMMAND,
          commandActions: [{ command: VERIFY_COMMAND, type: "unknown" }],
          completedAtMs,
          durationMs: 10,
          exitCode: 0,
          id: `agent-08-command-${issueID}`,
          status: "completed",
          type: "commandExecution"
        }
      }),
      runtime_evidence_correlation: {
        attempt_id: `${runID}~attempt:${attempt}`,
        contract: "xw.runtime-evidence-correlation.v1",
        issue_run_id: issueRunID,
        provider: "codex",
        provider_session_id: `thread-agent-08-${issueID}-${attempt}`,
        provider_turn_id: `turn-agent-08-${issueID}-${attempt}`,
        run_id: runID
      },
      type: "tool"
    }),
    completedAt
  ]);
}

function watermarks(db: RunnerDatabase): Watermark {
  return Object.fromEntries([
    "attention_command_events",
    "attention_inbox_items",
    "context_bundles",
    "external_events",
    "intake_runs",
    "issue_events",
    "issues",
    "pi_action_events"
  ].map((table) => [table, maxID(db, table)]));
}

function entityCounts(db: RunnerDatabase): Json {
  return {
    actions: count(db, "pi_actions"),
    attentions: listPersistedAttention(db).length,
    handoffs: listStoredHandoffs(db, { limit: 100 }).items.length,
    inbox_items: count(db, "attention_inbox_items"),
    intake_runs: count(db, "intake_runs"),
    issue_runs: count(db, "issue_runs"),
    proposals: count(db, "pi_action_proposals"),
    tool_calls: toolCallFacts(db).length,
    works: listIssues(db, { projectId: PROJECT_ID }).length
  };
}

function metric(items: Json[], idKey: string): Metric {
  return {
    count: items.length,
    drilldown: items,
    ids: items.map((item) => clean(item[idKey])).filter(Boolean)
  };
}

function latencyMetric(samples: Json[]): LatencyMetric {
  const values = samples.map((sample) => Number(sample.latency_ms)).sort((left, right) => left - right);
  return {
    count: values.length,
    max_ms: values.at(-1) ?? 0,
    p50_ms: values.length === 0 ? 0 : values[Math.floor((values.length - 1) / 2)]!,
    samples
  };
}

function metricDrilldownComplete(report: ObserverReport): boolean {
  const metrics = report.metrics;
  const counted = [
    metrics.total_work,
    metrics.direct_success,
    metrics.agent_self_heal_success,
    metrics.final_failure,
    metrics.human_help,
    metrics.false_or_stale_help,
    metrics.duplicate_execution,
    metrics.manual_status_modification
  ];
  return counted.every((metric) =>
    metric.count === metric.ids.length &&
    metric.count === metric.drilldown.length &&
    metric.ids.every(Boolean)) &&
    [metrics.detection_latency, metrics.recovery_latency]
      .every((metric) => metric.count === metric.samples.length &&
        metric.samples.every((sample) => sample.work_id &&
          (sample.event_id || sample.failure_id) && sample.latency_ms >= 0));
}

function expectedMetrics(): Record<string, number> {
  return {
    agent_self_heal_success: 1,
    direct_success: 1,
    duplicate_execution: 0,
    false_or_stale_help: 0,
    final_failure: 0,
    human_help: 1,
    manual_status_modification: 0,
    total_work: 3
  };
}

function writeReplay(artifactDir: string): void {
  writeFileSync(join(artifactDir, "replay.md"), `# Issue 784 replay

## 前置

- 在仓库根目录执行。
- 只创建临时 SQLite、临时 Git repository 和本地 stdio MCP fixture。
- 不调用 LLM，不发送外部消息。

## 定向测试与相邻主链回归

\`\`\`bash
bun test \\
  scripts/intake-observability-live.test.ts \\
  backend-ts/src/skills/runtime.test.ts \\
  backend-ts/src/pi/eventRouter.test.ts \\
  backend-ts/src/pi/fixtureCliE2e.test.ts
\`\`\`

## 三周期短窗预演

\`\`\`bash
rm -rf /tmp/issue-784-replay
bun scripts/intake-observability-live.ts exercise \\
  --artifact-dir /tmp/issue-784-replay
\`\`\`

## 从原始采样日志确定性重建

\`\`\`bash
bun scripts/intake-observability-live.ts report \\
  --input /tmp/issue-784-replay/raw-samples.jsonl \\
  --output /tmp/issue-784-replay/report-rebuilt.json
shasum -a 256 \\
  /tmp/issue-784-replay/short-window-report.json \\
  /tmp/issue-784-replay/report-rebuilt.json
\`\`\`

两个 SHA-256 必须一致。检查 \`report.json\` 的 \`result=passed\`，以及
\`short-window-report.json\` 的 Work/Run/Event/Attention 下钻 ID。

## 后续 24 小时确定性采样

首次采样固定窗口起点；后续周期复用同一 state/watermark。采样器只读 SQLite，
不调用 LLM。按需用 \`--project-id\` 或 \`--source\` 收窄范围。

\`\`\`bash
WINDOW_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
DB_PATH="\${XUANWU_DB_PATH:-data-bun/runner.db}"
bun scripts/intake-observability-live.ts sample \\
  --db "$DB_PATH" \\
  --output /tmp/issue-784-24h/raw-samples.jsonl \\
  --state /tmp/issue-784-24h/sampler-state.json \\
  --window-start "$WINDOW_START" \\
  --project-id xuanwu

# 每个后续采样周期执行同一命令；已有 state 时 window-start 不再改变。
bun scripts/intake-observability-live.ts sample \\
  --db "$DB_PATH" \\
  --output /tmp/issue-784-24h/raw-samples.jsonl \\
  --state /tmp/issue-784-24h/sampler-state.json \\
  --project-id xuanwu

bun scripts/intake-observability-live.ts report \\
  --input /tmp/issue-784-24h/raw-samples.jsonl \\
  --output /tmp/issue-784-24h/report.json
\`\`\`
`);
}

function record(
  timeline: TimelineEvent[],
  phase: string,
  kind: TimelineEvent["kind"],
  action: string,
  target: string,
  reason: string,
  result: TimelineEvent["result"],
  detail: Json = {}
): void {
  timeline.push({ action, at: new Date().toISOString(), detail, kind, phase, reason, result, target });
}

function assertion(id: string, passed: boolean, evidence: string, detail?: unknown): Assertion {
  return { id, passed, evidence, ...(detail === undefined ? {} : { detail }) };
}

async function jsonRequest(
  router: ReturnType<typeof createDefaultRouter>,
  path: string,
  init: RequestInit = {}
): Promise<Json> {
  const response = await router.handle(new Request(`http://127.0.0.1:3008${path}`, {
    headers: { "content-type": "application/json" },
    ...init
  }));
  const body = await response.json() as Json;
  if (!response.ok) throw new Error(`fixture API ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

function rows(db: RunnerDatabase, sql: string, args: Array<number | string> = []): Json[] {
  return db.sqlite.query<Json, Array<number | string>>(sql).all(...args);
}

function scopedRows(
  db: RunnerDatabase,
  select: string,
  field: string,
  ids: Array<number | string>,
  order: string
): Json[] {
  if (ids.length === 0) return [];
  if (!/^[a-z_]+$/.test(field)) throw new Error(`invalid scoped field ${field}`);
  const result: Json[] = [];
  for (let offset = 0; offset < ids.length; offset += 500) {
    const chunk = ids.slice(offset, offset + 500);
    result.push(...rows(db,
      `${select} where ${field} in (${chunk.map(() => "?").join(",")}) ${order}`,
      chunk));
  }
  return result;
}

function handoffFacts(events: Json[]): Json[] {
  const records = new Map<string, Json>();
  for (const event of events) {
    if (![
      "handoff.prepared.v1",
      "handoff.delivery_requested.v1",
      "handoff.delivery_completed.v1",
      "handoff.delivery_failed.v1",
      "handoff.superseded.v1"
    ].includes(clean(event.type))) continue;
    const handoff = parseObject(event.payload).handoff as Json | undefined;
    const id = clean(handoff?.id);
    if (!id) continue;
    const current = records.get(id);
    if (current && Number(current.revision) > Number(handoff?.revision ?? 0)) continue;
    records.set(id, {
      evidence_ids: Array.isArray(handoff?.evidence_ids) ? handoff.evidence_ids : [],
      event_id: event.id,
      id,
      revision: Number(handoff?.revision ?? 0),
      run_ids: Array.isArray(handoff?.run_ids) ? handoff.run_ids : [],
      status: clean(handoff?.status),
      work_id: clean(handoff?.work_id)
    });
  }
  return [...records.values()].sort((left, right) => clean(left.id).localeCompare(clean(right.id)));
}

function maxID(db: RunnerDatabase, table: string): number {
  return db.sqlite.query<{ id: number }, []>(`select coalesce(max(rowid), 0) as id from ${table}`).get()?.id ?? 0;
}

function count(db: RunnerDatabase, table: string): number {
  return db.sqlite.query<{ value: number }, []>(`select count(*) as value from ${table}`).get()?.value ?? 0;
}

function nonNegativeMs(from: string, to: string): number {
  return Math.max(0, Date.parse(to) - Date.parse(from));
}

function eventActor(payload: unknown): string {
  const value = parseObject(payload);
  const actor = value.actor;
  if (typeof actor === "string") return actor;
  return clean((actor as Json | undefined)?.kind ?? (actor as Json | undefined)?.id);
}

function redactPayload(payload: unknown): Json {
  const value = parseObject(payload);
  return {
    correlation_id: clean(value.correlation_id),
    handoff_id: clean(value.handoff_id ?? value.handoff?.id),
    source: clean(value.source),
    target_status: clean(value.target_status),
    work_id: clean(value.work_id)
  };
}

function actionsForProposal(proposals: Json[]): Set<string> {
  return new Set(proposals.map((proposal) => proposal.id));
}

function proposalAction(proposalIDs: Set<string>, action: Json): boolean {
  return [...proposalIDs].some((id) => clean(action.idempotency_key).startsWith(`action-proposal:${id}:`));
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function jsonArray(value: unknown): unknown[] {
  try {
    const parsed = JSON.parse(clean(value) || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseObject(value: unknown): Json {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Json;
  try {
    const parsed = JSON.parse(clean(value) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Json : {};
  } catch {
    return {};
  }
}

function appendJsonLine(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJson(value)}\n`, { flag: "a" });
}

function writeTimeline(path: string, events: TimelineEvent[]): void {
  writeFileSync(path, events.map(stableJson).join("\n") + "\n");
}

function writeStableJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stableJson(value, 2)}\n`);
}

function stableJson(value: unknown, space?: number): string {
  return JSON.stringify(sortValue(value), null, space);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Json).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => [key, sortValue(entry)]));
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function gitText(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitCommit(cwd: string, message: string): void {
  execFileSync("git", [
    "-c", "user.name=Agent 08 Fixture",
    "-c", "user.email=agent08@fixture.invalid",
    "commit", "-q", "-m", message
  ], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-07-25T12:00:00Z",
      GIT_COMMITTER_DATE: "2026-07-25T12:00:00Z"
    },
    stdio: "pipe"
  });
}

function option(args: string[], name: string, fallback: string): string {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1]! : fallback;
}

function requiredOption(args: string[], name: string): string {
  const value = option(args, name, "");
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

function readSamplerState(path: string): SamplerState | null {
  if (!existsSync(path)) return null;
  const value = parseObject(readFileSync(path, "utf8"));
  if (value.contract !== "xw.agentic-activation.issue-784-sampler-state.v1") {
    throw new Error("sampler state contract mismatch");
  }
  const cycle = Number(value.cycle);
  if (!Number.isSafeInteger(cycle) || cycle < 1) throw new Error("sampler state cycle is invalid");
  const windowStartedAt = optionalIso(value.window_started_at, "sampler state window start");
  const watermark = parseObject(value.watermark_end);
  if (Object.values(watermark).some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw new Error("sampler state watermark is invalid");
  }
  return {
    contract: "xw.agentic-activation.issue-784-sampler-state.v1",
    cycle,
    watermark_end: watermark as Watermark,
    window_started_at: windowStartedAt
  };
}

function optionalIso(value: unknown, field: string): string {
  const text = clean(value);
  if (!text) return "";
  if (!Number.isFinite(Date.parse(text))) throw new Error(`${field} must be an ISO timestamp`);
  return new Date(text).toISOString();
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : value === undefined || value === null ? "" : String(value);
}
