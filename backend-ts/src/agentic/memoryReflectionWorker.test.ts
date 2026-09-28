import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { listPiMemoryItems, listPiMemoryHistory, updatePiMemoryItem, deletePiMemoryItem } from "../db/repositories/pi.ts";
import { seedMemoryExperience } from "../pi/memoryExperienceTestFixtures.ts";
import { createMemoryReflectionTools } from "../pi/memoryReflectionTools.ts";
import {
  claimMemoryReflection, getMemoryReflection, memoryReflectionEnabled, reconcileMemoryReflectionEvents,
  REFLECTION_LIMITS, requestMemoryReflection, setMemoryReflectionEnabled, type MemoryReflection
} from "../pi/memoryReflectionQueue.ts";
import { runMemoryReflectionOnce } from "./memoryReflectionWorker.ts";
import { recordReflectionAttempt, unknownReflectionUsage } from "../pi/memoryReflectionTelemetry.ts";

const roots: string[] = [];
const databases: RunnerDatabase[] = [];
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture(enabled = true, status = "done") {
  const root = await mkdtemp(join(tmpdir(), "memory-reflection-")); roots.push(root);
  const db = await openDatabase({ stateDir: root }); databases.push(db);
  const seed = seedMemoryExperience(db);
  if (enabled) setMemoryReflectionEnabled(db, "demo", true);
  db.sqlite.run("update issues set status=? where id=?", [status, seed.issueID]);
  db.sqlite.run("update issue_runs set status='succeeded', ended_at=? where id=?", [new Date().toISOString(), seed.legacyRunID]);
  const event = () => recordIssueEvent(db, seed.issueID, "issue.pi_acceptance_applied.v1", {
    action: status === "failed" ? "failed" : "accept", run_id: seed.legacyRunID,
    decision: { rationale: "回调顺序的定向验证提供明确根因证据" }
  });
  event();
  const { schema_version, source, outcome, verification, ...content } = seed.experience;
  const input = { kind: "debugging_pattern", memory_key: "callback.timeout", confidence: "high",
    content: { ...content, verification: { method: verification.method, evidence_indices: [0] } } };
  return { db, seed, root, event, input };
}
function rows(db: RunnerDatabase) { return db.sqlite.query<MemoryReflection, []>("select * from pi_memory_reflections order by created_at").all(); }
async function invoke(tools: ReturnType<typeof createMemoryReflectionTools>, name: string, params = {}) {
  return tools.find(tool => tool.name === name)!.execute("test", params, undefined, undefined, {} as never);
}
const skip = async () => JSON.stringify({ status: "skipped", reason: "no_new_reusable_experience" });
function claimTools(db: RunnerDatabase) {
  reconcileMemoryReflectionEvents(db);
  const row = claimMemoryReflection(db)!;
  return createMemoryReflectionTools(db, { id: row.id, token: row.lease_token });
}

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

test("reflection persists specification guidance containing current without admitting lifecycle snapshots", async () => {
  const { db, input } = await fixture();
  await runMemoryReflectionOnce(db, { reflect: async (_row, lease) => {
    const tools = createMemoryReflectionTools(db, lease);
    await invoke(tools, "reflection_evidence_read");
    const content = { ...input.content,
      applies_when: "修改门槛判定且当前业务规格规定阈值本身应通过时。",
      resolution: "按当前业务规格验证阈值下方、阈值本身和阈值上方。" };
    const rejected = await invoke(tools, "memory_remember", { ...input,
      content: { ...content, symptom: "当前任务已完成，根因已修复" } });
    expect(rejected.details).toMatchObject({ rejected: true, reason: "current Work/Run/Issue status snapshots are not memory" });
    expect(listPiMemoryItems(db)).toHaveLength(0);
    const saved = await invoke(tools, "memory_remember", { ...input, content });
    expect(saved.details).not.toHaveProperty("rejected");
    return '{"status":"saved"}';
  } });
  expect(rows(db)[0]).toMatchObject({ status: "completed", attempts: 1 });
  expect(listPiMemoryItems(db)).toHaveLength(1);
  expect(JSON.parse(listPiMemoryItems(db)[0]!.content).applies_when).toContain("当前业务规格");
});

test("model timeout, output budget, and no lesson leave Work done and stop after one retry", async () => {
  for (const reflect of [async () => new Promise<string>(() => {}), async () => "x".repeat(REFLECTION_LIMITS.outputBytes + 1)]) {
    const { db, seed } = await fixture();
    for (let i = 0; i < 3; i++) await runMemoryReflectionOnce(db, { reflect, timeoutMs: 10 });
    expect(rows(db)[0]).toMatchObject({ status: "failed", attempts: 2 });
    expect(db.sqlite.query<{ status: string }, [number]>("select status from issues where id=?").get(seed.issueID)?.status).toBe("done");
    expect(listPiMemoryItems(db)).toHaveLength(0);
    const attempts = db.sqlite.query<{ payload: string }, []>(
      "select payload from issue_events where type='issue.memory_reflection_attempt.v1' order by id"
    ).all().map(row => JSON.parse(row.payload));
    expect(attempts).toHaveLength(2);
    expect(attempts.map(row => row.attempt)).toEqual([1, 2]);
    for (const attempt of attempts) {
      expect(["timeout", "output_budget_exhausted"]).toContain(attempt.reason_code);
      expect(attempt.elapsed_ms).toBeGreaterThanOrEqual(0);
      expect(attempt.usage.cost_usd).toBeNull();
    }
    expect(db.sqlite.query<{ n: number }, []>("select count(*) n from issues").get()!.n).toBe(1);
  }
});

test("a dispatched model call without a usage receipt persists unknown tokens and price, never a free call", async () => {
  const { db } = await fixture();
  reconcileMemoryReflectionEvents(db);
  const row = claimMemoryReflection(db)!;
  recordReflectionAttempt(db, row, { startedAt: new Date().toISOString(), elapsedMs: 45_000,
    status: "failed", reason: "reflection timed out", usage: { ...unknownReflectionUsage(),
      model_calls: 1, completed_calls: 0, input_bytes: 120, input_tokens: 0, output_tokens: 0, cost_usd: 0 } });
  const event = db.sqlite.query<{ payload: string }, []>(
    "select payload from issue_events where type='issue.memory_reflection_attempt.v1' order by id desc limit 1"
  ).get()!;
  expect(JSON.parse(event.payload)).toMatchObject({ reason_code: "timeout", usage: { completeness: "partial",
    input_bytes: 120, input_tokens: null, output_tokens: null, cost_usd: null } });
  expect(event.payload).not.toContain(row.lease_token);
});

test("disabled project revokes an active lease; empty or superseded evidence never calls a model", async () => {
  const { db, seed, input } = await fixture();
  reconcileMemoryReflectionEvents(db);
  const row = claimMemoryReflection(db)!;
  const tools = createMemoryReflectionTools(db, { id: row.id, token: row.lease_token });
  await invoke(tools, "reflection_evidence_read");
  setMemoryReflectionEnabled(db, "demo", false);
  await expect(invoke(tools, "memory_remember", input)).rejects.toThrow("lease");
  expect(rows(db)[0]?.reason).toBe("project_disabled");
  const empty = await fixture();
  empty.db.sqlite.run("delete from issue_events where type='evidence.recorded.v1'");
  expect(await runMemoryReflectionOnce(empty.db, { reflect: () => { throw new Error("must not run"); } })).toBe(false);
  expect(rows(empty.db)[0]).toMatchObject({ status: "skipped", reason: "no_valid_evidence", attempts: 0 });
  expect(listPiMemoryItems(db)).toHaveLength(0);
});

test("only diagnosed failures become diagnosis_only, never a successful repair", async () => {
  const { db, input, seed } = await fixture(true, "failed");
  const failedID = `${seed.evidence.id}-failed` as typeof seed.evidence.id;
  seed.persistEvidence({ ...seed.evidence, id: failedID, supersedes_id: seed.evidence.id, status: "failed",
    decisive_output: { summary: "两个回调同时调用复现重复写入", exit_code: 1, facts: {} } });
  await runMemoryReflectionOnce(db, { reflect: async (_row, lease) => {
    const tools = createMemoryReflectionTools(db, lease);
    await invoke(tools, "reflection_evidence_read");
    const rejected = await invoke(tools, "memory_remember", { ...input, kind: "resolution" });
    expect(rejected.details).toMatchObject({ rejected: true });
    await invoke(tools, "memory_remember", input);
    return '{"status":"saved"}';
  } });
  expect(rows(db)[0]?.status).toBe("completed");
  expect(JSON.parse(listPiMemoryItems(db)[0]!.content)).toMatchObject({ outcome: "diagnosis_only", resolution: "未验证修复；仅保留排查结论。" });
});

test("#967 disabled/forgotten source cannot be revived with a new key, including during a concurrent reflection", async () => {
  for (const forget of [false, true]) {
    const { db, input, seed } = await fixture();
    await runMemoryReflectionOnce(db, { reflect: async (_row, lease) => {
      const tools = createMemoryReflectionTools(db, lease);
      await invoke(tools, "reflection_evidence_read");
      await invoke(tools, "memory_remember", input);
      return '{"status":"saved"}';
    } });
    const memory = listPiMemoryItems(db)[0]!;
    seed.persistEvidence({ ...seed.evidence, id: `${seed.evidence.id}-new` });
    await runMemoryReflectionOnce(db, { reflect: async (_row, lease) => {
      const tools = createMemoryReflectionTools(db, lease);
      await invoke(tools, "reflection_evidence_read");
      expect((await invoke(tools, "memory_remember", { ...input, reenable: true })).details).toMatchObject({ rejected: true });
      const wrong = { ...input.content, source: { work_id: "xw:work:issues:999", run_id: seed.runID, refs: ["work:xw:work:issues:999"] } };
      expect((await invoke(tools, "memory_remember", { ...input, memory_key: "other.work", content: wrong })).details).toMatchObject({ rejected: true });
      if (forget) deletePiMemoryItem(db, memory.id); else updatePiMemoryItem(db, memory.id, { disabled: 1 });
      expect((await invoke(tools, "memory_remember", { ...input, memory_key: "evasion.new.key" })).details).toMatchObject({ rejected: true });
      return skip();
    } });
    expect(listPiMemoryItems(db).filter(item => item.disabled === 0)).toHaveLength(0);
    expect(rows(db).at(-1)).toMatchObject({ status: "skipped", reason: "source_memory_suppressed" });
    seed.persistEvidence({ ...seed.evidence, id: `${seed.evidence.id}-another` });
    expect(await runMemoryReflectionOnce(db, { reflect: () => { throw new Error("must not run"); } })).toBe(false);
    expect(rows(db).at(-1)).toMatchObject({ status: "skipped", reason: "source_memory_suppressed", attempts: 0 });
  }
});

test("Agentic uses the configured Pi identity and actual SDK with only reflection tools (local faux provider)", async () => {
  const { db, root, input } = await fixture();
  const faux = registerFauxProvider({ api: "pi-smoke-faux-api", provider: "pi-smoke-faux", tokensPerSecond: 0 });
  try {
    db.sqlite.run("update projects set cwd=? where id='demo'", [root]);
    db.sqlite.run("update pi_agents set model_provider='pi-smoke-faux', model_id='faux-1', thinking_level='off', enabled=1 where id='runner-default'");
    const agentDir = join(root, "pi-runtime", "agent");
    await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
      "pi-smoke-faux": { api: "pi-smoke-faux-api", apiKey: "test", baseUrl: "http://localhost:0", models: [{ id: "faux-1" }] }
    } }));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("reflection_evidence_read", {}), fauxToolCall("memory_search", { query: "timeout" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("memory_remember", input)], { stopReason: "toolUse" }),
      fauxAssistantMessage('{"status":"saved"}')
    ]);
    await runMemoryReflectionOnce(db);
    expect(rows(db)[0]).toMatchObject({ status: "completed", attempts: 1 });
    expect(listPiMemoryItems(db)).toHaveLength(1);
    const attempt = db.sqlite.query<{ payload: string }, []>(
      "select payload from issue_events where type='issue.memory_reflection_attempt.v1' order by id desc limit 1"
    ).get();
    const telemetry = JSON.parse(attempt!.payload);
    expect(telemetry).toMatchObject({ status: "completed", reason_code: "experience_saved",
      usage: { model_calls: 3, completed_calls: 3, completeness: "reported" } });
    expect(telemetry.elapsed_ms).toBeGreaterThanOrEqual(0);
    expect(telemetry.usage.input_tokens).toBeGreaterThanOrEqual(0);
    const audit = db.sqlite.query<{ payload_json: string }, []>(
      "select payload_json from pi_action_events where event_type='runtime_tool_registry_snapshot'"
    ).all().map(row => JSON.parse(row.payload_json));
    expect(audit[0]?.tool_names.sort()).toEqual(["memory_remember", "memory_search", "reflection_evidence_read"]);
    const envelope = db.sqlite.query<{ payload_json: string }, []>(
      "select payload_json from pi_action_events where event_type='runtime_context_projected'"
    ).all().map(row => JSON.parse(row.payload_json));
    expect(envelope[0]?.identity.agent_id).toBe("runner-default");
  } finally { faux.unregister(); }
});
