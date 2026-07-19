import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { recordEvidenceRecords } from "../../db/repositories/evidence.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { claimNextIssue } from "../../db/repositories/issueQueue.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { insertWorkRecord, insertWorkRelationRecord } from "../../db/repositories/workLedger.ts";
import type { EvidenceRecord } from "../evidence/contracts.ts";
import type { DependencyRelation } from "../work/contracts.ts";
import { getIssueAsWork, issueIDToWorkID } from "../work/issueAdapter.ts";
import {
  declareIssueReadinessRequirements,
  readIssueReadiness,
  type ReadinessEvidenceEvent,
  type ReadinessRequirementDeclaration
} from "./contracts.ts";

const NOW = "2026-07-20T00:00:00Z";
const REVISION = "9f1e2d3";
const RUNTIME_REVISION = "v0.1.0-760-g9f1e2d3";
const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { force: true, recursive: true });
  }
});

describe("delivery readiness Evidence projection", () => {
  test("keeps source-ready downstream unclaimed while the live revision Evidence is missing", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db);
      const source = insertIssue(db, "source", "done");
      const downstream = insertIssue(db, "destructive downstream", "todo");
      addDependency(db, downstream, source);
      declareRequirements(db, downstream, source, { required_stage: "observed" });

      expect(readIssueReadiness(db, downstream)).toMatchObject({
        current_stage: "source_ready",
        ready: false,
        status: "waiting",
        requirements: [{
          current_stage: "source_ready",
          missing_evidence: [
            `deployed:production:${RUNTIME_REVISION}`,
            "observed:production:W2"
          ],
          source_status: "done"
        }]
      });
      expect(claimNextIssue(db, "demo")).toBeNull();
      expect(getIssue(db, downstream)).toMatchObject({ attempt_count: 0, status: "todo" });
      expect(listIssueRuns(db, downstream)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("advances only after exact environment, revision, release-window, and gate Evidence", async () => {
    const db = await fixtureDatabase();
    try {
      insertProject(db);
      const source = insertIssue(db, "source", "done");
      const downstream = insertIssue(db, "migration downstream", "todo");
      addDependency(db, downstream, source);
      declareRequirements(db, downstream, source, { migration_gate: "G4", required_stage: "gate_passed" });

      record(db, source, evidence(source, "deployment", "deploy-wrong-env", { environment: "staging" }));
      record(db, source, evidence(source, "deployment", "deploy-old-release", { release_window: "W1" }));
      record(db, source, evidence(source, "deployment", "deploy-old-revision", {
        runtime_revision: "v0.1.0-759-g8e0d1c2",
        source_revision: "8e0d1c2"
      }));
      record(db, source, evidence(source, "deployment", "deploy-current"));
      expect(readIssueReadiness(db, downstream)).toMatchObject({ current_stage: "deployed", ready: false });

      record(db, source, evidence(source, "gate_pass", "gate-too-early", { migration_gate: "G4" }));
      record(db, source, evidence(source, "observation", "golden-journey"));
      expect(readIssueReadiness(db, downstream)).toMatchObject({ current_stage: "observed", ready: false });

      record(db, source, evidence(source, "gate_pass", "wrong-gate", { migration_gate: "G3" }));
      expect(readIssueReadiness(db, downstream)).toMatchObject({ current_stage: "observed", ready: false });
      record(db, source, evidence(source, "gate_pass", "gate-current", { migration_gate: "G4" }));

      expect(readIssueReadiness(db, downstream)).toMatchObject({
        current_stage: "gate_passed",
        missing_evidence: [],
        ready: true,
        status: "ready"
      });
      expect(claimNextIssue(db, "demo")).toMatchObject({ id: downstream, status: "in_progress" });
    } finally {
      db.close();
    }
  });

  test("rebuilds after restart and rollback Evidence revokes only the matching projection", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-runner-readiness-restart-"));
    tempRoots.push(root);
    const stateDir = join(root, "state");
    let db = await openDatabase({ stateDir });
    insertProject(db);
    const source = insertIssue(db, "source", "done");
    const downstream = insertIssue(db, "live downstream", "todo");
    addDependency(db, downstream, source);
    declareRequirements(db, downstream, source, { required_stage: "observed" });
    record(db, source, evidence(source, "deployment", "deploy-before-restart"));
    record(db, source, evidence(source, "observation", "observe-before-restart"));
    expect(readIssueReadiness(db, downstream)?.ready).toBe(true);
    db.close();

    db = await openDatabase({ stateDir });
    try {
      expect(readIssueReadiness(db, downstream)).toMatchObject({ current_stage: "observed", ready: true });
      record(db, source, evidence(source, "rollback", "rollback-current"));
      expect(readIssueReadiness(db, downstream)).toMatchObject({
        current_stage: "source_ready",
        ready: false,
        requirements: [{ rollback_evidence_id: expect.stringContaining("rollback-current") }]
      });
      expect(db.sqlite.query<{ count: number }, []>(
        "select count(*) as count from issue_events where type='evidence.recorded.v1'"
      ).get()?.count).toBe(3);

      record(db, source, evidence(source, "deployment", "redeploy-current"));
      record(db, source, evidence(source, "observation", "reobserve-current"));
      expect(readIssueReadiness(db, downstream)).toMatchObject({ current_stage: "observed", ready: true });
    } finally {
      db.close();
    }
  });
});

async function fixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-readiness-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

function insertProject(db: RunnerDatabase): void {
  db.sqlite.run(`insert into projects (id, name, cwd, provider, auto_run, created_at, updated_at)
    values ('demo', 'demo', '/tmp/readiness-demo', 'codex', 1, ?, ?)`, [NOW, NOW]);
}

function insertIssue(db: RunnerDatabase, title: string, status: string): number {
  return createIssue(db, { project_id: "demo", status, title }).id;
}

function addDependency(db: RunnerDatabase, issueID: number, dependencyID: number): void {
  ensureWork(db, issueID);
  ensureWork(db, dependencyID);
  const relation: DependencyRelation = {
    actor: { id: "readiness-test", kind: "runner" },
    audit_event_ref: `readiness-test:${issueID}:${dependencyID}`,
    correlation_id: `readiness-test:${issueID}:${dependencyID}`,
    depends_on_work_id: issueIDToWorkID(dependencyID),
    kind: "depends_on",
    occurred_at: NOW,
    reason: "readiness dependency fixture",
    relation_id: `depends-on:${issueID}:${dependencyID}`,
    work_id: issueIDToWorkID(issueID)
  };
  insertWorkRelationRecord(db, "demo", relation);
}

function ensureWork(db: RunnerDatabase, issueID: number): void {
  const work = getIssueAsWork(db, issueID);
  if (!work) throw new Error(`missing fixture issue ${issueID}`);
  insertWorkRecord(db, work);
}

function declareRequirements(
  db: RunnerDatabase,
  downstream: number,
  source: number,
  override: Partial<ReadinessRequirementDeclaration["requirements"][number]>
): void {
  declareIssueReadinessRequirements(db, downstream, {
    audit: {
      actor: { id: "release-controller", kind: "system" },
      correlation_id: `readiness:${downstream}`,
      event_id: `readiness:${downstream}:v1`,
      occurred_at: NOW,
      reason: "Declare live delivery gate"
    },
    requirements: [{
      environment: "production",
      release_window: "W2",
      required_stage: "observed",
      runtime_revision: RUNTIME_REVISION,
      source_revision: REVISION,
      source_work_id: issueIDToWorkID(source),
      ...override
    }],
    schema_version: 1,
    work_id: issueIDToWorkID(downstream)
  });
}

function record(db: RunnerDatabase, issueID: number, item: EvidenceRecord): void {
  recordEvidenceRecords(db, issueID, [item], { recorded_at: item.observed_at, source: "readiness-test" });
}

function evidence(
  sourceIssueID: number,
  event: ReadinessEvidenceEvent,
  id: string,
  overrides: Partial<Record<"environment" | "migration_gate" | "release_window" | "runtime_revision" | "source_revision", string>> = {}
): EvidenceRecord {
  const observedAt = "2026-07-20T00:05:00.000Z";
  return {
    artifact_refs: [{ kind: "report", ref: `artifact:${id}` }],
    completed_at: observedAt,
    created_at: observedAt,
    decisive_output: {
      facts: {
        environment: overrides.environment ?? "production",
        migration_gate: overrides.migration_gate ?? "",
        readiness_event: event,
        release_window: overrides.release_window ?? "W2",
        rollback_ref: "release:760:rollback",
        runtime_revision: overrides.runtime_revision ?? RUNTIME_REVISION,
        runtime_stamp: "20260720T000500Z-9f1e2d3-clean",
        source_revision: overrides.source_revision ?? REVISION
      },
      summary: `${event} readiness Evidence`
    },
    id: `xw:evidence:issue_events:${id}`,
    kind: "http",
    observed_at: observedAt,
    provenance: {
      assertion_origin: "system_observation",
      audit_event_ref: `release-audit:${id}`,
      producer: { id: "release-controller", kind: "system" },
      source_kind: "http_exchange",
      source_ref: `runtime:${id}`
    },
    redaction: { policy_ref: "evidence-redaction:test", redacted_paths: [], status: "not_required" },
    revision: 0,
    schema_version: 1,
    status: "passed",
    updated_at: observedAt,
    work_id: issueIDToWorkID(sourceIssueID)
  };
}
