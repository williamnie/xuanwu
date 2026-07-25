#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { openDatabase, type RunnerDatabase } from "../backend-ts/src/db/database.ts";
import { listStoredEvidence } from "../backend-ts/src/db/repositories/evidence.ts";
import { listStoredHandoffs } from "../backend-ts/src/db/repositories/handoffs.ts";
import {
  resolvePiGuardianAlert,
  upsertPiGuardianAlert
} from "../backend-ts/src/db/repositories/pi.ts";
import {
  getPersistedAttention,
  listPersistedAttention,
  persistAttentionCommand
} from "../backend-ts/src/domain/attention/persistence.ts";
import { completeIssueFromRuntimeEvidence } from "../backend-ts/src/domain/evidence/completionGate.ts";
import {
  recordIssueRunGitWorkspaceBaseline
} from "../backend-ts/src/domain/evidence/runGitWorkspaceBaseline.ts";

const ISSUE_ID = 783;
const CONTRACT = "xw.agentic-activation.issue-783-fixture.v1";
const REPORT_CONTRACT = "xw.agentic-activation.issue-report.v1";
const DEFAULT_ARTIFACT_DIR = ".runner/artifacts/agentic-activation/issue-783";
const VERIFY_COMMAND = "bun test scripts/handoff-attention-fixture.test.ts";
const BASE_TIME = "2026-07-25T12:00:00.000Z";

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
type HandoffScenario = {
  changed_files: string[];
  evidence_facts: Json;
  final_revision: string;
  risks: Json[];
  scenario: string;
  snapshot_sha256: string;
};
type FixtureReport = {
  artifact_refs: string[];
  assertions: Assertion[];
  contract: typeof REPORT_CONTRACT;
  ended_at: string;
  failure_reasons: string[];
  issue_id: typeof ISSUE_ID;
  result: "passed" | "failed";
  started_at: string;
};

if (import.meta.main) {
  const command = process.argv[2] ?? "";
  const artifactDir = option(process.argv.slice(3), "artifact-dir", DEFAULT_ARTIFACT_DIR);
  if (command !== "exercise") {
    console.error("usage: bun scripts/handoff-attention-fixture.ts exercise [--artifact-dir <path>]");
    process.exit(64);
  }
  const report = await runIssue783Fixture(resolve(artifactDir));
  console.log(JSON.stringify(report, null, 2));
  if (report.result !== "passed") process.exitCode = 1;
}

export async function runIssue783Fixture(artifactDir: string): Promise<FixtureReport> {
  const output = resolve(artifactDir);
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });
  const timeline: TimelineEvent[] = [];
  const startedAt = new Date().toISOString();
  record(timeline, "fixture", "input", "load-fixture-manifest", "issue:783",
    "execute six isolated attribution and Attention lifecycle scenarios", "started");

  try {
    const manifest = fixtureManifest();
    writeJson(join(output, "fixture-manifest.json"), manifest);
    record(timeline, "fixture", "decision", "isolate-all-state", "fixture:issue-783",
      "shared production worktree and live database must remain untouched", "passed", {
        handoff_scenarios: Object.keys(manifest.handoff_files),
        attention_scenarios: manifest.attention_scenarios
      });

    const clean = await runHandoffScenario("clean-commit", {
      baselineDirty: false,
      commitWork: true,
      recordBaseline: true,
      workPath: manifest.handoff_files.clean_commit[0],
      workValue: "clean committed work\n"
    });
    recordHandoffResult(timeline, clean, "clean commit only attributes the committed Work file");

    const shared = await runHandoffScenario("shared-dirty-tree", {
      baselineDirty: true,
      commitWork: true,
      recordBaseline: true,
      workPath: manifest.handoff_files.shared_dirty_tree[0],
      workValue: "current Work committed file\n"
    });
    recordHandoffResult(timeline, shared,
      "pre-existing tracked and untracked paths belong to another Work and must stay excluded");

    const untrackedFirst = await runHandoffScenario("current-work-untracked-1", {
      baselineDirty: false,
      commitWork: false,
      recordBaseline: true,
      workPath: manifest.handoff_files.current_work_untracked[0],
      workValue: "{\"fixture\":\"issue-783\",\"result\":\"replayable\"}\n"
    });
    const untrackedSecond = await runHandoffScenario("current-work-untracked-2", {
      baselineDirty: false,
      commitWork: false,
      recordBaseline: true,
      workPath: manifest.handoff_files.current_work_untracked[0],
      workValue: "{\"fixture\":\"issue-783\",\"result\":\"replayable\"}\n"
    });
    const replayable = untrackedFirst.snapshot_sha256 === untrackedSecond.snapshot_sha256 &&
      equalFiles(untrackedFirst.changed_files, untrackedSecond.changed_files);
    record(timeline, "handoff", "result", "replay-untracked-artifact",
      manifest.handoff_files.current_work_untracked[0],
      "two clean fixture runs must produce the same selected files and content-addressed snapshot",
      replayable ? "passed" : "failed", {
        first_snapshot_sha256: untrackedFirst.snapshot_sha256,
        second_snapshot_sha256: untrackedSecond.snapshot_sha256
      });

    const uncertain = await runHandoffScenario("uncertain-attribution", {
      baselineDirty: false,
      commitWork: true,
      recordBaseline: false,
      workPath: manifest.handoff_files.uncertain_attribution[0],
      workValue: "committed while workspace baseline is unavailable\n"
    });
    recordHandoffResult(timeline, uncertain,
      "missing Run workspace baseline must preserve committed proof but add a high attribution risk");

    const handoffResults = {
      clean_commit: clean,
      current_work_untracked: untrackedFirst,
      current_work_untracked_replay: untrackedSecond,
      shared_dirty_tree: shared,
      uncertain_attribution: uncertain
    };
    writeJson(join(output, "handoff-results.json"), handoffResults);

    const attention = await runAttentionScenarios();
    writeJson(join(output, "attention-results.json"), attention);
    for (const event of attention.timeline) timeline.push(event);

    const manifestExact = equalFiles(clean.changed_files, manifest.handoff_files.clean_commit) &&
      equalFiles(shared.changed_files, manifest.handoff_files.shared_dirty_tree) &&
      equalFiles(untrackedFirst.changed_files, manifest.handoff_files.current_work_untracked) &&
      equalFiles(uncertain.changed_files, manifest.handoff_files.uncertain_attribution);
    const sharedExcluded = manifest.excluded_shared_dirty_paths.every((path: string) =>
      !shared.changed_files.includes(path));
    const uncertaintyRisk = uncertain.risks.some((risk) =>
      risk.id === "handoff_attribution_uncertainty" && risk.severity === "high" &&
      /baseline|uncertain|attribut/i.test(`${risk.summary} ${risk.mitigation}`));
    const lifecycleActions = attention.human_help.timeline.map((event: Json) => event.action);
    const lifecycleComplete = ["create", "acknowledge", "resolve", "close"].every((action) =>
      lifecycleActions.includes(action)) && attention.human_help.timeline.every((event: Json) =>
      Boolean(event.target && event.reason && event.at));

    const assertions: Assertion[] = [
      assertion("clean_commit_handoff_scope",
        equalFiles(clean.changed_files, manifest.handoff_files.clean_commit),
        "fixture-manifest.json + handoff-results.json", clean),
      assertion("shared_dirty_tree_excluded",
        equalFiles(shared.changed_files, manifest.handoff_files.shared_dirty_tree) && sharedExcluded,
        "fixture-manifest.json + handoff-results.json", {
          excluded: manifest.excluded_shared_dirty_paths,
          handoff_files: shared.changed_files
        }),
      assertion("current_work_untracked_attributed_and_replayable",
        equalFiles(untrackedFirst.changed_files, manifest.handoff_files.current_work_untracked) && replayable,
        "handoff-results.json", {
          files: untrackedFirst.changed_files,
          snapshot_sha256: untrackedFirst.snapshot_sha256
        }),
      assertion("human_help_attention_lifecycle",
        attention.human_help.active_before === 1 &&
        attention.human_help.active_after === 0 &&
        attention.human_help.final_status === "resolved" &&
        lifecycleComplete,
        "attention-results.json", attention.human_help),
      assertion("agent_auto_recovery_no_stale_attention",
        attention.auto_recovery.active_after === 0 &&
        attention.auto_recovery.command_event_count === 0 &&
        attention.auto_recovery.stale_approval_count === 0,
        "attention-results.json", attention.auto_recovery),
      assertion("attribution_uncertainty_is_high_risk",
        uncertaintyRisk && uncertain.risks.length > 0,
        "handoff-results.json", uncertain.risks),
      assertion("handoff_manifest_exact", manifestExact,
        "fixture-manifest.json + handoff-results.json"),
      assertion("attention_audit_complete", lifecycleComplete &&
        attention.human_help.ack_audit.reason === "Operator acknowledged the fixture target" &&
        attention.human_help.resolution_reason === "Fixture target recovered after operator input",
        "attention-results.json"),
      assertion("completed_work_active_stale_attention_zero",
        attention.completed_work_active_stale_attention === 0,
        "attention-results.json")
    ];
    for (const item of assertions) {
      record(timeline, "assertion", "result", item.id, `assertion:${item.id}`,
        item.evidence, item.passed ? "passed" : "failed", item.detail as Json | undefined);
    }

    writeTimeline(join(output, "timeline.jsonl"), timeline);
    writeReplay(join(output, "replay.md"));
    const report = reportFrom(startedAt, assertions);
    writeJson(join(output, "report.json"), report);
    return report;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    record(timeline, "fixture", "result", "fixture-failed", "issue:783", reason, "failed");
    writeTimeline(join(output, "timeline.jsonl"), timeline);
    writeReplay(join(output, "replay.md"));
    const report = reportFrom(startedAt, [], [reason]);
    writeJson(join(output, "report.json"), report);
    return report;
  }
}

async function runHandoffScenario(
  scenario: string,
  input: {
    baselineDirty: boolean;
    commitWork: boolean;
    recordBaseline: boolean;
    workPath: string;
    workValue: string;
  }
): Promise<HandoffScenario> {
  const root = await mkdtemp(join(tmpdir(), `issue-783-${scenario}-`));
  const repository = join(root, "repository");
  mkdirSync(repository, { recursive: true });
  let db: RunnerDatabase | undefined;
  try {
    git(repository, ["init", "-q"]);
    write(repository, "README.md", "fixture baseline\n");
    write(repository, "shared-tracked.txt", "shared baseline\n");
    git(repository, ["add", "README.md", "shared-tracked.txt"]);
    commit(repository, "fixture baseline", "2026-07-25T11:00:00Z");
    const baseRevision = gitText(repository, ["rev-parse", "HEAD"]);

    if (input.baselineDirty) {
      write(repository, "shared-tracked.txt", "other Work tracked change\n");
      write(repository, "shared-untracked.txt", "other Work untracked change\n");
    }

    db = await openDatabase({ stateDir: join(root, "state") });
    const issueID = insertIssueRun(db, repository, baseRevision);
    const runID = `issue-${issueID}-attempt-1`;
    if (input.recordBaseline) {
      recordIssueRunGitWorkspaceBaseline(db, issueID, {
        base_revision: baseRevision,
        captured_at: new Date().toISOString(),
        repository_path: repository,
        run_id: runID
      });
    }

    write(repository, input.workPath, input.workValue);
    if (input.commitWork) {
      git(repository, ["add", "--", input.workPath]);
      commit(repository, `${scenario} Work`, "2026-07-25T11:30:00Z");
    }
    insertVerificationEvent(db, issueID, runID);

    const completion = await completeIssueFromRuntimeEvidence(db, issueID, { error: "", status: "done" });
    if (completion.issue.status !== "done") {
      throw new Error(`${scenario} did not pass completion: ${completion.issue.status} ${completion.issue.error}`);
    }
    const stored = listStoredHandoffs(db, {
      limit: 10,
      work_id: `xw:work:issues:${issueID}`
    }).items;
    if (stored.length !== 1) throw new Error(`${scenario} expected one persisted Handoff, found ${stored.length}`);
    const handoff = stored[0]!.handoff;
    const evidence = listStoredEvidence(db, { issue_ids: [issueID], limit: 20 }).items
      .map((item) => item.evidence)
      .find((item) => item.kind === "git");
    if (!evidence) throw new Error(`${scenario} has no persisted Git Evidence`);
    const snapshot = String(evidence.decisive_output.facts.snapshot_sha256 ?? "");
    if (!/^[a-f0-9]{64}$/.test(snapshot)) throw new Error(`${scenario} Git Evidence snapshot digest is invalid`);
    return {
      changed_files: handoff.changed_files,
      evidence_facts: evidence.decisive_output.facts,
      final_revision: handoff.final_revision,
      risks: handoff.risks,
      scenario,
      snapshot_sha256: snapshot
    };
  } finally {
    db?.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runAttentionScenarios(): Promise<Json> {
  const root = await mkdtemp(join(tmpdir(), "issue-783-attention-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  const timeline: TimelineEvent[] = [];
  try {
    insertProject(db);
    const humanIssue = insertIssue(db, "in_progress", "Human-help target");
    const humanAlert = upsertPiGuardianAlert(db, {
      alert_type: "fixture_input_required",
      id: "issue-783-human-help",
      issue_id: humanIssue,
      message: "Fixture target requires operator input",
      project_id: "fixture",
      severity: "high",
      status: "open"
    });
    const activeBefore = activeAttentionForIssue(db, humanIssue).length;
    const attention = listPersistedAttention(db).find((item) =>
      item.source_refs.some((source) => source.authority === "pi_guardian_alerts" &&
        source.local_id === humanAlert.id));
    if (!attention) throw new Error("human-help fixture did not create Attention");
    record(timeline, "attention-human", "state", "create", `issue:${humanIssue}`,
      humanAlert.message, activeBefore === 1 ? "passed" : "failed", {
        attention_id: attention.id,
        status: attention.status
      });

    const ackAt = new Date().toISOString();
    const acknowledged = persistAttentionCommand(db, attention.id, {
      action: "acknowledge",
      audit: {
        actor: { id: "operator:fixture", kind: "user" },
        correlation_id: `issue:${humanIssue}:human-help`,
        event_id: `issue-783-human-ack:${humanIssue}`,
        gate: {
          authority: "human_approval",
          decision: "allow",
          policy_ref: "issue-783-fixture-human-ack"
        },
        occurred_at: ackAt,
        reason: "Operator acknowledged the fixture target"
      },
      expected_revision: attention.revision
    });
    record(timeline, "attention-human", "action", "acknowledge", attention.id,
      acknowledged.audit_event.reason, "passed", {
        after_status: acknowledged.attention.status,
        before_status: acknowledged.audit_event.before_status,
        event_id: acknowledged.audit_event.event_id
      });

    const resolutionReason = "Fixture target recovered after operator input";
    const resolvedAlert = resolvePiGuardianAlert(db, humanAlert.id, {
      message: resolutionReason
    });
    record(timeline, "attention-human", "state", "resolve", `issue:${humanIssue}`,
      resolvedAlert.message, resolvedAlert.status === "resolved" ? "passed" : "failed", {
        authority: "pi_guardian_alerts",
        source_id: resolvedAlert.id
      });
    const closed = getPersistedAttention(db, attention.id);
    const activeAfter = activeAttentionForIssue(db, humanIssue).length;
    db.sqlite.run("update issues set status='done', updated_at=? where id=?", [
      new Date().toISOString(), humanIssue
    ]);
    record(timeline, "attention-human", "result", "close", attention.id,
      "all authoritative sources are terminal after the target recovered",
      closed?.status === "resolved" && activeAfter === 0 ? "passed" : "failed", {
        active_after: activeAfter,
        final_status: closed?.status
      });

    const autoIssue = insertIssue(db, "in_progress", "Agent auto-recovery target");
    const autoAlert = upsertPiGuardianAlert(db, {
      alert_type: "fixture_agent_recovery",
      id: "issue-783-agent-recovery",
      issue_id: autoIssue,
      message: "Transient fixture failure",
      project_id: "fixture",
      severity: "medium",
      status: "open"
    });
    record(timeline, "attention-auto", "input", "create-recoverable-target", `issue:${autoIssue}`,
      autoAlert.message, "observed", { source_id: autoAlert.id });
    const autoResolutionReason = "Agent recovered the fixture target without human approval";
    resolvePiGuardianAlert(db, autoAlert.id, { message: autoResolutionReason });
    db.sqlite.run("update issues set status='done', updated_at=? where id=?", [
      new Date().toISOString(), autoIssue
    ]);
    const autoAttention = getPersistedAttention(
      db,
      listPersistedAttention(db).find((item) =>
        item.source_refs.some((source) => source.local_id === autoAlert.id))?.id ?? ""
    );
    const autoActive = activeAttentionForIssue(db, autoIssue).length;
    const autoCommandCount = db.sqlite.query<{ count: number }, [string]>(`
      select count(*) as count from attention_command_events where attention_id=?
    `).get(autoAttention?.id ?? "")?.count ?? 0;
    const staleApprovalCount = db.sqlite.query<{ count: number }, [number]>(`
      select count(*) as count from pi_approval_requests
      where issue_id=? and status in ('pending', 'delivered', 'resolve_failed')
    `).get(autoIssue)?.count ?? 0;
    record(timeline, "attention-auto", "result", "auto-recover-and-close", `issue:${autoIssue}`,
      autoResolutionReason,
      autoActive === 0 && autoCommandCount === 0 && staleApprovalCount === 0 ? "passed" : "failed", {
        active_after: autoActive,
        command_event_count: autoCommandCount,
        stale_approval_count: staleApprovalCount
      });

    const ackRow = db.sqlite.query<{ audit_json: string; created_at: string }, [string]>(`
      select audit_json, created_at from attention_command_events
      where attention_id=? and action='acknowledge' order by revision asc limit 1
    `).get(attention.id);
    if (!ackRow) throw new Error("human-help Attention acknowledge audit was not persisted");
    const ackAudit = JSON.parse(ackRow.audit_json) as Json;
    const humanTimeline = timeline.filter((event) => event.phase === "attention-human")
      .map((event) => ({
        action: event.action,
        at: event.at,
        reason: event.reason,
        result: event.result,
        target: event.target
      }));
    const completedWorkActiveStale = [
      ...activeAttentionForIssue(db, humanIssue),
      ...activeAttentionForIssue(db, autoIssue)
    ].filter((item) => [humanIssue, autoIssue].some((issueID) =>
      item.source_refs.some((source) => source.correlation_refs.includes(`issue:${issueID}`)))).length;

    return {
      auto_recovery: {
        active_after: autoActive,
        command_event_count: autoCommandCount,
        final_status: autoAttention?.status,
        resolution_reason: autoResolutionReason,
        stale_approval_count: staleApprovalCount,
        target: `issue:${autoIssue}`
      },
      completed_work_active_stale_attention: completedWorkActiveStale,
      human_help: {
        ack_audit: ackAudit,
        active_after: activeAfter,
        active_before: activeBefore,
        final_status: closed?.status,
        resolution_reason: resolvedAlert.message,
        target: `issue:${humanIssue}`,
        timeline: humanTimeline
      },
      timeline
    };
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
}

function insertIssueRun(db: RunnerDatabase, repository: string, baseRevision: string): number {
  insertProject(db, repository);
  const issueID = insertIssue(db, "in_progress", "Issue 783 Handoff fixture");
  const startedAt = new Date(Date.now() - 1000).toISOString();
  db.sqlite.run(`
    insert into issue_runs (
      id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
      git_base_revision, started_at
    ) values (?, ?, 1, 'in_progress', 'codex', 'thread-issue-783-fixture',
      'turn-issue-783-fixture', ?, ?)
  `, [`issue-${issueID}-attempt-1`, issueID, baseRevision, startedAt]);
  db.sqlite.run(
    "update issues set codex_thread_id='thread-issue-783-fixture', codex_turn_id='turn-issue-783-fixture' where id=?",
    [issueID]
  );
  return issueID;
}

function insertProject(db: RunnerDatabase, repository = "/tmp/issue-783-attention-fixture"): void {
  db.sqlite.run(`
    insert or ignore into projects (id, name, cwd, provider, created_at, updated_at)
    values ('fixture', 'Issue 783 fixture', ?, 'codex', ?, ?)
  `, [repository, BASE_TIME, BASE_TIME]);
}

function insertIssue(db: RunnerDatabase, status: string, title: string): number {
  db.sqlite.run(`
    insert into issues (project_id, title, status, created_at, updated_at)
    values ('fixture', ?, ?, ?, ?)
  `, [title, status, BASE_TIME, BASE_TIME]);
  const id = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id;
  if (!id) throw new Error("fixture issue insert failed");
  return id;
}

function insertVerificationEvent(db: RunnerDatabase, issueID: number, issueRunID: string): void {
  const completedAtMs = Date.now();
  const runID = `xw:run:issue_runs:${issueRunID}`;
  const rawPayload = JSON.stringify({
    item: {
      aggregatedOutput: "Issue 783 focused fixture verification passed",
      command: VERIFY_COMMAND,
      commandActions: [{ command: VERIFY_COMMAND, type: "unknown" }],
      completedAtMs,
      durationMs: 10,
      exitCode: 0,
      id: `issue-783-command-${issueID}`,
      status: "completed",
      type: "commandExecution"
    }
  });
  db.sqlite.run(`
    insert into issue_events (issue_id, type, payload, created_at)
    values (?, 'issue.log', ?, ?)
  `, [
    issueID,
    JSON.stringify({
      raw_method: "item/completed",
      raw_payload: rawPayload,
      runtime_evidence_correlation: {
        attempt_id: `${runID}~attempt:1`,
        contract: "xw.runtime-evidence-correlation.v1",
        issue_run_id: issueRunID,
        provider: "codex",
        provider_session_id: "thread-issue-783-fixture",
        provider_turn_id: "turn-issue-783-fixture",
        run_id: runID
      },
      type: "tool"
    }),
    new Date(completedAtMs).toISOString()
  ]);
}

function activeAttentionForIssue(db: RunnerDatabase, issueID: number) {
  return listPersistedAttention(db).filter((item) =>
    item.status !== "resolved" && item.status !== "dismissed" &&
    item.source_refs.some((source) => source.correlation_refs.includes(`issue:${issueID}`)));
}

function fixtureManifest(): Json {
  return {
    attention_scenarios: ["human_help", "agent_auto_recovery"],
    contract: CONTRACT,
    excluded_shared_dirty_paths: ["shared-tracked.txt", "shared-untracked.txt"],
    handoff_files: {
      clean_commit: ["src/clean-current-work.ts"],
      current_work_untracked: ["artifacts/current-work.json"],
      shared_dirty_tree: ["src/shared-current-work.ts"],
      uncertain_attribution: ["src/uncertain-current-work.ts"]
    },
    issue_id: ISSUE_ID
  };
}

function reportFrom(
  startedAt: string,
  assertions: Assertion[],
  fatalReasons: string[] = []
): FixtureReport {
  const failed = assertions.filter((item) => !item.passed).map((item) => item.id);
  const failureReasons = [...fatalReasons, ...failed.map((id) => `assertion failed: ${id}`)];
  return {
    artifact_refs: [
      "fixture-manifest.json",
      "handoff-results.json",
      "attention-results.json",
      "timeline.jsonl",
      "replay.md"
    ],
    assertions,
    contract: REPORT_CONTRACT,
    ended_at: new Date().toISOString(),
    failure_reasons: failureReasons,
    issue_id: ISSUE_ID,
    result: failureReasons.length === 0 && assertions.length >= 9 ? "passed" : "failed",
    started_at: startedAt
  };
}

function assertion(id: string, passed: boolean, evidence: string, detail?: unknown): Assertion {
  return { id, passed, evidence, ...(detail === undefined ? {} : { detail }) };
}

function recordHandoffResult(timeline: TimelineEvent[], scenario: HandoffScenario, reason: string): void {
  record(timeline, "handoff", "result", scenario.scenario, `handoff:${scenario.scenario}`,
    reason, "passed", {
      changed_files: scenario.changed_files,
      risks: scenario.risks.map((risk) => ({ id: risk.id, severity: risk.severity }))
    });
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
  timeline.push({
    action,
    at: new Date().toISOString(),
    detail: redact(detail),
    kind,
    phase,
    reason,
    result,
    target
  });
}

function writeReplay(path: string): void {
  writeFileSync(path, `# Issue 783 replay

前置条件：仅需本仓库的 Bun 依赖与 Git。fixture 使用临时仓库和临时 SQLite，不读取或清理共享工作树，不修改 live DB。

\`\`\`bash
cd /Users/xiaobei/Documents/xiaobei/codex-issue-runner

# 六类端到端 fixture，并生成机器制品
bun scripts/handoff-attention-fixture.ts exercise \\
  --artifact-dir .runner/artifacts/agentic-activation/issue-783

# 直接相关回归
cd backend-ts
bun test \\
  ../scripts/handoff-attention-fixture.test.ts \\
  src/domain/evidence/runGitWorkspaceBaseline.test.ts \\
  src/domain/evidence/completionGate.test.ts \\
  src/db/repositories/issueRuns.test.ts \\
  src/domain/attention/contracts.test.ts \\
  src/http/commandCenterApi.test.ts
\`\`\`

判定：

1. \`report.json.result\` 必须为 \`passed\`，九条 assertion 全部通过。
2. \`handoff-results.json\` 的每组 \`changed_files\` 必须与 \`fixture-manifest.json\` 精确一致。
3. shared dirty 的 \`shared-tracked.txt\`、\`shared-untracked.txt\` 不得进入 Handoff。
4. uncertainty 场景必须包含 \`handoff_attribution_uncertainty\` high risk。
5. Attention timeline 必须含 create、acknowledge、resolve、close，且均有 target、reason、时间。
6. human-help 与 Agent auto-recovery 最终 active Attention 为 0，自动恢复不得产生 command/approval 残留。
`);
}

function writeTimeline(path: string, events: TimelineEvent[]): void {
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(redact(value), null, 2)}\n`);
}

function write(repository: string, path: string, value: string): void {
  const target = join(repository, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function commit(repository: string, message: string, timestamp: string): void {
  git(repository, [
    "-c", "user.name=Runner Fixture",
    "-c", "user.email=runner-fixture@example.invalid",
    "commit", "-qm", message
  ], {
    GIT_AUTHOR_DATE: timestamp,
    GIT_COMMITTER_DATE: timestamp
  });
}

function git(
  repository: string,
  args: string[],
  extraEnv: Record<string, string> = {}
): void {
  execFileSync("git", args, {
    cwd: repository,
    env: { ...process.env, ...extraEnv },
    stdio: "pipe"
  });
}

function gitText(repository: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}

function equalFiles(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function redact<T>(value: T): T {
  const text = JSON.stringify(value);
  if (text === undefined) return value;
  return JSON.parse(text.replace(
    /("(?:token|secret|password|credential|authorization)"\s*:\s*)"[^"]*"/gi,
    '$1"[redacted]"'
  )) as T;
}

function option(argv: string[], name: string, fallback: string): string {
  const key = `--${name}`;
  const index = argv.indexOf(key);
  if (index < 0) return fallback;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
  return value;
}

export function artifactDigest(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
