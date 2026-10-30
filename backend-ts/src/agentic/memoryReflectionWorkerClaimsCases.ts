import { expect, test } from "bun:test";

import { openDatabase } from "../db/database.ts";

import { listPiMemoryItems, listPiMemoryHistory, updatePiMemoryItem } from "../db/repositories/pi.ts";

import { createMemoryReflectionTools } from "../pi/memory/memoryReflectionTools.ts";
import {
  claimMemoryReflection,
  getMemoryReflection,
  memoryReflectionEnabled,
  reconcileMemoryReflectionEvents,
  requestMemoryReflection,
  setMemoryReflectionEnabled
} from "../pi/memory/memoryReflectionQueue.ts";
import { runMemoryReflectionOnce } from "./memoryReflectionWorker.ts";

import { databases, fixture, rows, invoke, skip, claimTools } from "./memoryReflectionWorkerTestFixtures.ts";

export function registerMemoryReflectionWorkerClaimsCases() {
  test("default off; enabling does not backfill previous acceptance or force needs_user attribution", async () => {
  const { db, seed, event } = await fixture(false);
  expect(memoryReflectionEnabled(db, "demo")).toBe(false);
  reconcileMemoryReflectionEvents(db); expect(rows(db)).toHaveLength(0);
  setMemoryReflectionEnabled(db, "demo", true);
  requestMemoryReflection(db, seed.issueID); expect(rows(db)).toHaveLength(0);
  event(); reconcileMemoryReflectionEvents(db); expect(rows(db)).toHaveLength(1);
  const other = await fixture(true, "needs_user");
  reconcileMemoryReflectionEvents(other.db); expect(rows(other.db)).toHaveLength(0);
});

  test("delivery events recover acceptance/request crash gap; duplicate events and restart do not repeat an effective reflection", async () => {
  const { db, root, event } = await fixture();
  expect(rows(db)).toHaveLength(0);
  await runMemoryReflectionOnce(db, { reflect: skip });
  expect(rows(db)[0]).toMatchObject({ status: "skipped", attempts: 1, reason: "no_new_reusable_experience" });
  event();
  const reopened = await openDatabase({ stateDir: root }); databases.push(reopened);
  expect(await runMemoryReflectionOnce(reopened, { reflect: () => { throw new Error("must not run"); } })).toBe(false);
  expect(rows(db)).toHaveLength(1);
});

  test("two database connections cannot claim the same fingerprint concurrently", async () => {
  const { db, root } = await fixture();
  const second = await openDatabase({ stateDir: root }); databases.push(second);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const first = runMemoryReflectionOnce(db, { reflect: async () => { entered(); await waiting; return skip(); } });
  await started;
  expect(await runMemoryReflectionOnce(second, { reflect: skip })).toBe(false);
  release(); await first;
  expect(rows(db)[0]).toMatchObject({ status: "skipped", attempts: 1 });
});

  test("crash lease recovery fences old writes and exhausts at two attempts across restarts", async () => {
  const { db, root, input } = await fixture();
  reconcileMemoryReflectionEvents(db);
  const first = claimMemoryReflection(db)!;
  const staleTools = createMemoryReflectionTools(db, { id: first.id, token: first.lease_token });
  await invoke(staleTools, "reflection_evidence_read");
  db.sqlite.run("update pi_memory_reflections set lease_until=0");
  const secondDB = await openDatabase({ stateDir: root }); databases.push(secondDB);
  const second = claimMemoryReflection(secondDB)!;
  expect(second.attempts).toBe(2);
  expect(second.lease_token).not.toBe(first.lease_token);
  await expect(invoke(staleTools, "memory_remember", input)).rejects.toThrow("lease");
  expect(listPiMemoryItems(db)).toHaveLength(0);
  db.sqlite.run("update pi_memory_reflections set lease_until=0");
  expect(claimMemoryReflection(db)).toBeNull();
  expect(rows(db)[0]).toMatchObject({ status: "failed", attempts: 2, reason: "crash_retry_exhausted" });
});

  test("memory write and completion are atomic; a crash after commit cannot cause duplicate adoption", async () => {
  const { db, input, event } = await fixture();
  reconcileMemoryReflectionEvents(db);
  const request = claimMemoryReflection(db)!;
  const tools = createMemoryReflectionTools(db, { id: request.id, token: request.lease_token });
  await invoke(tools, "reflection_evidence_read");
  db.sqlite.run(`create trigger simulate_crash before update of status on pi_memory_reflections
    when new.status='completed' begin select raise(abort, 'simulated crash before completion'); end`);
  await expect(invoke(tools, "memory_remember", input)).rejects.toThrow("simulated crash");
  expect(listPiMemoryItems(db)).toHaveLength(0);
  expect(getMemoryReflection(db, request.id)?.status).toBe("running");
  db.sqlite.run("drop trigger simulate_crash");
  await invoke(tools, "memory_remember", input);
  expect(rows(db)[0]).toMatchObject({ status: "completed", attempts: 1 });
  expect(listPiMemoryItems(db)[0]).toMatchObject({ occurrence_count: 1, revision: 1, source_type: "pi.memory_reflection" });
  event();
  expect(await runMemoryReflectionOnce(db, { reflect: skip })).toBe(false);
  await expect(invoke(tools, "memory_remember", { ...input, memory_key: "another.key" })).rejects.toThrow("lease");
  expect(listPiMemoryItems(db)).toHaveLength(1);
});

  test("reflection binds canonical source and evidence refs without asking the model to reproduce Host metadata", async () => {
  const { db, input } = await fixture();
  await runMemoryReflectionOnce(db, { reflect: async (_row, lease) => {
    const tools = createMemoryReflectionTools(db, lease);
    const summary = (await invoke(tools, "reflection_evidence_read")).details as {
      work_id: string; run_id: string; evidence: Array<{ id: string; evidence_index: number }> };
    expect(summary.evidence[0]?.evidence_index).toBe(0);
    expect(input.content).not.toHaveProperty("source");
    const result = await invoke(tools, "memory_remember", input);
    expect(result.details).not.toHaveProperty("rejected");
    const saved = JSON.parse(listPiMemoryItems(db)[0]!.content);
    expect(saved.source).toEqual({ work_id: summary.work_id, run_id: summary.run_id,
      refs: [`work:${summary.work_id}`, `run:${summary.run_id}`] });
    expect(saved.verification.evidence_refs).toEqual([`evidence:${summary.evidence[0]!.id}`]);
    expect(saved.verification).not.toHaveProperty("evidence_indices");
    expect(saved.schema_version).toBe(1);
    expect(saved.resolution).toBe(input.content.resolution);
    return '{"status":"saved"}';
  } });
  expect(rows(db)[0]).toMatchObject({ status: "completed", attempts: 1 });
  expect(listPiMemoryItems(db)).toHaveLength(1);
});

  test("reflection cannot override Host metadata or select evidence outside the issued list", async () => {
  const patches = [
    { scope: "global" }, { scope_id: "another-project" }, { user_authorized: true }, { reenable: true },
    { evidence_ref: "xw:evidence:issue_events:fake" },
    { contentPatch: { source: { work_id: "work:xw:work:issues:999" } } },
    { contentPatch: { schema_version: 2 } }, { contentPatch: { outcome: "verified_resolution" } },
    ...[[], [-1], [1], [0.5], [0, 0]].map(evidence_indices => ({
      contentPatch: { verification: { method: "test", evidence_indices } }
    }))
  ];
  for (const patch of patches) {
    const { db, input } = await fixture();
    const tools = claimTools(db);
    const { contentPatch, ...extra } = patch as { contentPatch?: object };
    await invoke(tools, "reflection_evidence_read");
    const rejected = await invoke(tools, "memory_remember", { ...input, ...extra,
      content: { ...input.content, ...contentPatch } });
    expect(rejected.details).toMatchObject({ rejected: true });
    expect(listPiMemoryItems(db)).toHaveLength(0);
    await invoke(tools, "memory_remember", input);
    expect(listPiMemoryItems(db)).toHaveLength(1);
  }
});

  test("reflection binds only selected evidence and rechecks it after reading", async () => {
  const selected = await fixture();
  selected.seed.persistEvidence({ ...selected.seed.evidence, id: `${selected.seed.evidence.id}-selected` });
  selected.seed.persistEvidence({ ...selected.seed.evidence, id: `${selected.seed.evidence.id}-failed`, status: "failed" });
  const tools = claimTools(selected.db);
  const summary = (await invoke(tools, "reflection_evidence_read")).details as {
    evidence: Array<{ id: string; evidence_index: number; verification_eligible: boolean }> };
  const failed = summary.evidence.find(item => item.id.endsWith("-failed"))!;
  expect(failed.verification_eligible).toBe(false);
  expect((await invoke(tools, "memory_remember", { ...selected.input, content: { ...selected.input.content,
    verification: { ...selected.input.content.verification, evidence_indices: [failed.evidence_index] } } })).details).toMatchObject({ rejected: true });
  expect(listPiMemoryItems(selected.db)).toHaveLength(0);
  const choice = summary.evidence.find(item => item.id.endsWith("-selected"))!;
  await invoke(tools, "memory_remember", { ...selected.input, content: { ...selected.input.content,
    verification: { ...selected.input.content.verification, evidence_indices: [choice.evidence_index] } } });
  expect(JSON.parse(listPiMemoryItems(selected.db)[0]!.content).verification.evidence_refs).toEqual([`evidence:${choice.id}`]);

  const stale = await fixture();
  const staleTools = claimTools(stale.db);
  expect((await invoke(staleTools, "memory_remember", stale.input)).details).toMatchObject({ rejected: true, reason: "read reflection evidence first" });
  await invoke(staleTools, "reflection_evidence_read");
  stale.seed.persistEvidence({ ...stale.seed.evidence, id: `${stale.seed.evidence.id}-replacement`, supersedes_id: stale.seed.evidence.id });
  expect((await invoke(staleTools, "memory_remember", stale.input)).details).toMatchObject({ rejected: true, reason: "experience Evidence has been superseded" });
  expect(listPiMemoryItems(stale.db)).toHaveLength(0);
});

  test("reflection binds correction revision to the memory actually read and refuses concurrent changes", async () => {
  for (const concurrent of [false, true]) {
    const { db, input, seed } = await fixture();
    const initial = claimTools(db);
    await invoke(initial, "reflection_evidence_read"); await invoke(initial, "memory_remember", input);
    const previous = listPiMemoryItems(db)[0]!;
    const evidenceID = `${seed.evidence.id}-correction` as const;
    seed.persistEvidence({ ...seed.evidence, id: evidenceID });
    const tools = claimTools(db);
    const summary = (await invoke(tools, "reflection_evidence_read")).details as {
      evidence: Array<{ id: string; evidence_index: number }> };
    const corrected = { ...input, content: { ...input.content,
      applies_when: `${input.content.applies_when}，仅限 Linux`,
      verification: { ...input.content.verification, evidence_indices: [summary.evidence.find(item => item.id === evidenceID)!.evidence_index] } },
      correction: { disposition: "narrow", reason: "新证据把适用范围限定为 Linux" } };
    expect((await invoke(tools, "memory_remember", corrected)).details).toMatchObject({ rejected: true,
      reason: "read the existing memory through memory_search before correcting it" });
    const searched = (await invoke(tools, "memory_search", { query: "async callback timeout v0.2.13" })).details as { items: Array<{ id: string; revision: number }> };
    expect(searched.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: previous.id, revision: 1 })]));
    if (concurrent) updatePiMemoryItem(db, previous.id, { content: JSON.stringify({ ...JSON.parse(previous.content), resolution: "并发更新后的处理方法" }) });
    const saved = (await invoke(tools, "memory_remember", corrected)).details as { rejected?: boolean; reason?: string; revision?: number };
    if (concurrent) {
      expect(saved.rejected).toBe(true); expect(saved.reason).toContain("revision conflict");
      expect(JSON.parse(listPiMemoryItems(db)[0]!.content).resolution).toBe("并发更新后的处理方法");
    } else {
      expect(saved.rejected).toBeUndefined(); expect(saved.revision).toBe(2);
      expect(listPiMemoryHistory(db, previous.id).at(-1)?.correction).toMatchObject({ expected_revision: 1, disposition: "narrow" });
      expect(JSON.parse(listPiMemoryItems(db)[0]!.content).verification.evidence_refs).toEqual([`evidence:${evidenceID}`]);
    }
  }
});
}
