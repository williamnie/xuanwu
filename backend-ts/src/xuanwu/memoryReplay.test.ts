import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureDriver, runMemoryReplay, scoreTask, REPLAY_CASES, type ToolStep } from "./memoryReplay.ts";
import { ReplayBudget, readOnlyReplayCredentials } from "./memoryReplayRuntime.ts";

test("memory journey replays the real persistence, tool gate, correction, restart and suppression paths in a fresh DB", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-journey-test-"));
  try {
    const result = await runMemoryReplay(root, fixtureDriver, new AbortController().signal);
    expect(result.cases.map(row => [row.id, row.status, row.error])).toEqual(REPLAY_CASES.map(id => [id, "passed", undefined]));
    expect(result.kind).toBe("fixture"); expect(fixtureDriver.calls()).toBe(0);
    const steps = JSON.parse(await readFile(join(root, "tool-steps.json"), "utf8"));
    expect(steps.similar_expression.some((step: any) => step.output?.items?.some((item: any) => item.selection_stage === "pi_selected"))).toBe(true);
    const commands = JSON.parse(await readFile(join(root, "commands.json"), "utf8"));
    expect(commands.map((row: any) => row.exit_code)).toEqual([1, 0, 0]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);

test("scoring rejects old business rules, fabricated references, denied reads and absent boundary coverage", () => {
  const read: ToolStep = { name: "repo_read_excerpt", input: { path: "SPEC.md" }, output: { excerpt: "current spec" }, elapsed_ms: 1 };
  const valid = { tests: [{ amount: 199, eligible: false }, { amount: 200, eligible: false }, { amount: 201, eligible: true }], memory_refs: [] };
  expect(scoreTask(JSON.stringify(valid), [read], 200, false, false).misuse).toBe(false);
  expect(() => scoreTask(JSON.stringify({ ...valid, tests: valid.tests.map(row => ({ ...row, eligible: row.amount >= 100 })) }), [read], 200, false, false)).toThrow("business rule misused");
  expect(() => scoreTask(JSON.stringify({ ...valid, memory_refs: [{ id: "invented", revision: 1, content_fingerprint: "fake" }] }), [read], 200, false, false)).toThrow("unobserved memory citation");
  expect(() => scoreTask(JSON.stringify(valid), [{ ...read, output: { rejected: true } }], 200, false, false)).toThrow("spec was not read");
  expect(() => scoreTask(JSON.stringify(valid), [read], 200, false, true)).toThrow("no observed memory reuse");
  expect(() => scoreTask(JSON.stringify({ ...valid, tests: [...valid.tests.slice(0, 2), { amount: 202, eligible: true }] }), [read], 200, false, false)).toThrow("boundary missing");
});

test("global budget stops before call 21 and independently enforces deadline without counting a rejected dispatch", () => {
  const budget = new ReplayBudget();
  for (let i = 0; i < 20; i++) budget.dispatch({ turn: i });
  expect(() => budget.dispatch({})).toThrow("budget exhausted");
  expect(budget.calls).toBe(20); expect(budget.report().receipts).toEqual([]);
  const expired = new ReplayBudget(20, 1);
  const original = Date.now; Date.now = () => expired.started + 2;
  try { expect(() => expired.dispatch({})).toThrow("budget exhausted"); expect(expired.calls).toBe(0); }
  finally { Date.now = original; }
});

test("live auth adapter reads only selected provider via SDK and cannot mutate source credentials", async () => {
  const reads: string[] = [];
  const sdk = { pi: { readStoredCredential: (id: string) => { reads.push(id); return { type: "oauth", access: "fixture", refresh: "fixture", expires: 0 }; } } };
  const store = readOnlyReplayCredentials(sdk as never, "/synthetic/auth.json", "selected");
  expect(await store.read("other")).toBeUndefined(); expect(reads).toEqual([]);
  expect(await store.list()).toEqual([{ providerId: "selected", type: "oauth" }]);
  await expect(store.modify("selected", async () => undefined)).rejects.toThrow("requires refresh");
  await expect(store.delete("selected")).rejects.toThrow("read-only");
  expect(reads).toEqual(["selected"]);
});

test("live adapter exposes actual reflection tools to the SDK (faux transport only)", async () => {
  const { registerFauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/compat");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { openDatabase } = await import("../db/database.ts");
  const { seedMemoryExperience } = await import("../pi/memoryExperienceTestFixtures.ts");
  const { recordIssueEvent } = await import("../db/repositories/issueEvents.ts");
  const { setMemoryReflectionEnabled, reconcileMemoryReflectionEvents, claimMemoryReflection } = await import("../pi/memoryReflectionQueue.ts");
  const { createMemoryReflectionTools } = await import("../pi/memoryReflectionTools.ts");
  const { listPiMemoryItems } = await import("../db/repositories/pi.ts");
  const { liveReplayDriver } = await import("./memoryReplayRuntime.ts");
  const root = await mkdtemp(join(tmpdir(), "memory-sdk-replay-"));
  const db = await openDatabase({ stateDir: root });
  const faux = registerFauxProvider({ api: "pi-smoke-faux-api", provider: "pi-smoke-faux", tokensPerSecond: 0 });
  try {
    const seed = seedMemoryExperience(db, "fictional-gate");
    db.sqlite.run("update projects set cwd=?", [root]);
    db.sqlite.run("update pi_agents set model_provider='pi-smoke-faux', model_id='faux-1', thinking_level='off'");
    const dir = join(root, "pi-runtime", "agent"); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "models.json"), JSON.stringify({ providers: { "pi-smoke-faux": { api: "pi-smoke-faux-api", apiKey: "fixture", baseUrl: "http://localhost:0", models: [{ id: "faux-1" }] } } }));
    setMemoryReflectionEnabled(db, "fictional-gate", true);
    db.sqlite.run("update issues set status='done'");
    db.sqlite.run("update issue_runs set status='succeeded',ended_at=?", [new Date().toISOString()]);
    recordIssueEvent(db, seed.issueID, "issue.pi_acceptance_applied.v1", { action: "accept", run_id: seed.legacyRunID });
    reconcileMemoryReflectionEvents(db); const row = claimMemoryReflection(db)!;
    const lease = { id: row.id, token: row.lease_token };
    const input = { kind: "debugging_pattern", confidence: "high", memory_key: "callback.timeout", content: JSON.stringify({ ...seed.experience,
      source: { ...seed.experience.source, refs: [`work:${seed.workID}`, `run:${seed.runID}`] } }) };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("reflection_evidence_read", {}), fauxToolCall("memory_search", { query: "timeout" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("memory_remember", input)], { stopReason: "toolUse" }),
      fauxAssistantMessage('{"status":"saved"}')
    ]);
    const budget = new ReplayBudget(); const { driver } = await liveReplayDriver(root, root, budget);
    await driver.reflect(db, row, lease, budget.controller.signal, createMemoryReflectionTools(db, lease), input);
    expect(listPiMemoryItems(db)).toHaveLength(1); expect(budget.calls).toBe(3); expect(budget.receipts).toHaveLength(3);
  } finally { faux.unregister(); db.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);

test("a claimed saved response without a persisted memory cannot pass the replay", async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-false-observation-"));
  try {
    const result = await runMemoryReplay(root, { ...fixtureDriver, reflect: async () => '{"status":"saved"}' }, new AbortController().signal);
    expect(result.status).toBe("failed");
    expect(result.cases[0]).toMatchObject({ id: "first_learning", status: "failed" });
    expect(result.cases.slice(1).every(row => row.status === "not_run")).toBe(true);
    expect(result.cases[0].facts.memory).toEqual([]);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 60_000);
