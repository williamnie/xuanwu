import { expect, test } from "bun:test";

import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";

import { listPiMemoryItems, updatePiMemoryItem, deletePiMemoryItem } from "../db/repositories/pi.ts";

import { createMemoryReflectionTools } from "../pi/memory/memoryReflectionTools.ts";
import {
  claimMemoryReflection,
  reconcileMemoryReflectionEvents,
  REFLECTION_LIMITS,
  setMemoryReflectionEnabled
} from "../pi/memory/memoryReflectionQueue.ts";
import { runMemoryReflectionOnce } from "./memoryReflectionWorker.ts";
import { recordReflectionAttempt, unknownReflectionUsage } from "../pi/memory/memoryReflectionTelemetry.ts";

import { fauxPi, fixture, rows, invoke, skip } from "./memoryReflectionWorkerTestFixtures.ts";

export function registerMemoryReflectionWorkerEvidenceCases() {
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
  db.sqlite.run("update projects set cwd=? where id='demo'", [root]);
  fauxPi(db, { provider: "pi-smoke-faux", tokensPerSecond: 0 }).setResponses([
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
});
}
