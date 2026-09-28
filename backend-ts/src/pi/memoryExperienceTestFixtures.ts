import type { RunnerDatabase } from "../db/database.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { recordHandoff } from "../db/repositories/handoffs.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import type { MemoryExperience } from "./memoryExperience.ts";

const at = "2026-09-28T00:00:00.000Z";

export function seedMemoryExperience(db: RunnerDatabase, projectID = "demo") {
  db.sqlite.run("insert or ignore into projects (id, name, cwd, created_at, updated_at) values (?, ?, ?, ?, ?)",
    [projectID, projectID, `/tmp/memory-fixture-${projectID}`, at, at]);
  db.sqlite.run("insert into issues (project_id, title, status, created_at, updated_at) values (?, 'Memory regression', 'in_progress', ?, ?)",
    [projectID, at, at]);
  const issueID = Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()!.id);
  const legacyRunID = `memory-${issueID}-attempt-1`;
  db.sqlite.run(`insert into issue_runs (id, issue_id, attempt, status, provider, started_at, ended_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, '')`, [legacyRunID, issueID, at]);
  const workID = `xw:work:issues:${issueID}` as EvidenceRecord["work_id"];
  const runID = `xw:run:issue_runs:${legacyRunID}` as NonNullable<EvidenceRecord["run_id"]>;
  const evidence: EvidenceRecord = {
    schema_version: 1, id: `xw:evidence:issue_events:memory-${issueID}`, work_id: workID, run_id: runID,
    revision: 0, kind: "test", status: "passed", created_at: at, observed_at: at, updated_at: at, completed_at: at,
    decisive_output: { summary: "timeout regression passed", exit_code: 0, facts: { tests_passed: 1 } },
    artifact_refs: [],
    provenance: { assertion_origin: "tool_result", source_kind: "test_runner", source_ref: `test:memory-${issueID}`,
      audit_event_ref: `audit:memory-${issueID}`, producer: { id: "memory-test", kind: "runner" } },
    redaction: { status: "not_required", policy_ref: "memory-test:v1", redacted_paths: [] }
  };
  const persistEvidence = (record: EvidenceRecord) => recordEvidenceRecords(db, issueID, [record], { recorded_at: at, source: "memory-test" });
  persistEvidence(evidence);
  const handoff = recordHandoff(db, issueID, {
    schema_version: 1, id: `xw:handoff:derived:memory-${issueID}`, work_id: workID, run_ids: [runID], evidence_ids: [evidence.id],
    revision: 0, status: "ready", summary: "Timeout regression", created_at: at, updated_at: at,
    baseline_revision: "git:base", final_revision: "git:fixed", review_ref: "git:fixed", changed_files: ["timeout.ts"],
    delivery: { mode: "local_changes", working_tree_ref: "git:fixed" }, delivery_actions: [], risks: [],
    rollback: { availability: "not_required", destructive: false, refs: [] },
    review: { required: false, state: "not_requested", reviewer_refs: [] }
  }, { recorded_at: at, source: "memory-test" }).record;
  const experience: MemoryExperience = {
    schema_version: 1, applies_when: "异步请求超时且回调仍可能执行时", symptom: "响应被重复写入",
    root_cause: "超时回调与完成回调共享可变响应", resolution: "完成后移除超时回调",
    failed_attempts: ["仅增加超时时间仍存在竞争"],
    verification: { method: "运行 timeout.test.ts 覆盖两个回调顺序", evidence_refs: [`evidence:${evidence.id}`] },
    source: { work_id: workID, run_id: runID, refs: [`work:${workID}`, `run:${runID}`, `handoff:${handoff.handoff.id}`] },
    version: "runner v0.2.13 / timeout callback implementation"
  };
  return { evidence, experience, handoff, issueID, legacyRunID, persistEvidence, runID, workID };
}
