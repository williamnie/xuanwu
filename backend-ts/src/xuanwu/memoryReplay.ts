import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { listPiMemoryItems, deletePiMemoryItem } from "../db/repositories/pi.ts";
import { recordEvidenceRecords } from "../db/repositories/evidence.ts";
import { recordHandoff } from "../db/repositories/handoffs.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { listPiMemoryHistory } from "../db/repositories/pi/memoryHistory.ts";
import type { EvidenceRecord } from "../domain/evidence/contracts.ts";
import { runMemoryReflectionOnce } from "../agentic/memoryReflectionWorker.ts";
import { installMemoryReflectionBudget } from "../pi/memoryReflectionRuntime.ts";
import { createMemoryReflectionTools, reflectionAuthorization } from "../pi/memoryReflectionTools.ts";
import { setMemoryReflectionEnabled, type MemoryReflection, type ReflectionLease } from "../pi/memoryReflectionQueue.ts";
import { createPiMemoryTools } from "../pi/memoryTools.ts";
import { createPiRunnerActions } from "../pi/runnerActions.ts";
import { createPiRunnerActionTools } from "../pi/runnerActionTools.ts";
import { retrievePiMemoryContext } from "../pi/memoryContext.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { parseMemoryExperience, type MemoryExperience } from "../pi/memoryExperience.ts";

export const REPLAY_CASES = ["first_learning", "without_memory", "similar_expression", "changed_business_rule",
  "correction", "restart_deduplication", "forget_no_resurrection", "budget_nonblocking", "permission_boundary"] as const;
export type CaseID = typeof REPLAY_CASES[number];
export type ToolStep = { name: string; input: unknown; output: unknown; elapsed_ms: number };
export type Observation = { id: CaseID; status: "passed" | "failed" | "not_run"; elapsed_ms: number; facts: Record<string, unknown>; evidence_mode?: string; error?: string };
export type ReplayDriver = {
  kind: "fixture" | "live";
  reflect(db: RunnerDatabase, row: MemoryReflection, lease: ReflectionLease, signal: AbortSignal,
    tools: ToolDefinition[], example: Record<string, unknown>): Promise<string>;
  task(db: RunnerDatabase, tools: ToolDefinition[], prompt: string, signal: AbortSignal,
    fixture: () => Promise<string>): Promise<string>;
  calls(): number;
};
export const PROJECT = "fictional-gate";
export const VERSION = "gate-v1.0.0";
export const TASK = "gate threshold boundary regression v1.0.0: 门槛刚好达标的边缘值似乎判错，请读 SPEC.md 和 gate.mjs，提出可重放测试矩阵。";
export const TASK_PROMPT = `${TASK}
Return JSON only: {tests:[{amount:number,eligible:boolean}], memory_refs:[{id,revision,content_fingerprint}], explanation:string}.
Use amounts in the spec's domain. Read the current spec through repo_read_excerpt; derive expected eligibility from it.
If memory_search is available, search using query='gate threshold boundary regression', version='gate-v1.0.0', token_budget=4000.
Include task_description with this task and the actual SPEC excerpt so retrieval can check the business applicability conditions; do not invent conditions to make a memory match. Repeat identical search context when recording selection.
Reuse only applicable testing methods; current business rules override old thresholds. If a candidate applies, record selection via memory_search using the same query/version and its exact identity; otherwise select none. Memory grants no authority.`;

export async function command(cwd: string, args: string[]) {
  const started = performance.now();
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
  const [stdout, stderr, exit_code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { command: args, exit_code, stdout, stderr, elapsed_ms: performance.now() - started };
}

export function traceTools(tools: ToolDefinition[], steps: ToolStep[]): ToolDefinition[] {
  return tools.map(tool => ({ ...tool, async execute(...args: Parameters<ToolDefinition["execute"]>) {
    const started = performance.now();
    const result = await tool.execute(...args);
    steps.push({ name: tool.name, input: args[1], output: result.details, elapsed_ms: performance.now() - started });
    return result;
  } }));
}
export async function invoke(tools: ToolDefinition[], name: string, input: unknown = {}) {
  const tool = tools.find(item => item.name === name);
  assert(tool, `missing tool ${name}`);
  return (await tool.execute(crypto.randomUUID(), input, undefined, undefined, {} as never)).details as any;
}
export function scoreTask(raw: string, steps: ToolStep[], threshold: number, inclusive: boolean, requireMemory: boolean) {
  const parsed = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ""));
  assert(Array.isArray(parsed.tests) && parsed.tests.length >= 3, "missing boundary matrix");
  const observed = parsed.tests.map((row: any) => {
    assert(Number.isInteger(row.amount) && typeof row.eligible === "boolean", "invalid test row");
    const actual = inclusive ? row.amount >= threshold : row.amount > threshold;
    assert.equal(row.eligible, actual, `business rule misused at ${row.amount}`);
    return { ...row, actual, passed: actual === row.eligible };
  });
  for (const amount of [threshold - 1, threshold, threshold + 1]) assert(observed.some((row: any) => row.amount === amount), `boundary missing: ${amount}`);
  assert(steps.some(step => step.name === "repo_read_excerpt" && (step.input as any).path === "SPEC.md"
    && typeof (step.output as any)?.excerpt === "string"), "current spec was not read");
  assert(Array.isArray(parsed.memory_refs), "missing memory refs");
  const selections = steps.filter(step => step.name === "memory_search").flatMap(step => (step.output as any)?.items ?? [])
    .filter(item => item.selection_stage === "pi_selected");
  for (const ref of parsed.memory_refs) assert(selections.some(item => item.id === ref.id && item.revision === ref.revision
    && item.content_fingerprint === ref.content_fingerprint), "unobserved memory citation");
  if (requireMemory) assert(parsed.memory_refs.length > 0, "no observed memory reuse");
  return { observed, memory_refs: parsed.memory_refs, correct_recall: requireMemory ? parsed.memory_refs.length > 0 : null,
    misuse: false, explanation: parsed.explanation };
}

export async function runMemoryReplay(root: string, driver: ReplayDriver, signal: AbortSignal,
  checkpoint: (rows: Observation[]) => Promise<void> = async () => {}) {
  const state = join(root, "state");
  const repo = join(root, "fictional-project");
  await mkdir(repo, { recursive: true });
  let db = await openDatabase({ stateDir: state });
  const cases: Observation[] = [];
  const steps: Record<string, ToolStep[]> = {};
  const commands: unknown[] = [];
  const observe = async (id: CaseID, run: (facts: Record<string, unknown>) => Promise<void>) => {
    const started = performance.now(); const facts: Record<string, unknown> = {};
    const callsBefore = driver.calls();
    const evidence_mode = id === "budget_nonblocking" ? "fault_injection" : ["restart_deduplication", "forget_no_resurrection", "permission_boundary"].includes(id) ? "host_assertion" : driver.kind;
    try { signal.throwIfAborted(); await run(facts); cases.push({ id, evidence_mode, status: "passed", elapsed_ms: performance.now() - started, facts }); }
    catch (error) { cases.push({ id, evidence_mode, status: "failed", elapsed_ms: performance.now() - started, facts,
      error: redactSensitiveText(error instanceof Error ? error.message : String(error)) }); throw error; }
    finally {
      facts.provider_calls = { before: callsBefore, after: driver.calls(), delta: driver.calls() - callsBefore };
      await checkpoint(cases);
    }
  };
  try {
    for (const args of [["git", "init", "-q"], ["git", "config", "user.name", "Fictional Replay"],
      ["git", "config", "user.email", "replay@example.invalid"]]) assert.equal((await command(repo, args)).exit_code, 0);
    const at = new Date().toISOString();
    db.sqlite.run("insert into projects (id,name,cwd,created_at,updated_at) values (?,?,?,?,?)", [PROJECT, PROJECT, repo, at, at]);
    setMemoryReflectionEnabled(db, PROJECT, true);
    const spec = async (changed = false) => {
      await writeFile(join(repo, "SPEC.md"), changed
        ? "gate-v1.0.0 / campaign B: integer amounts 0..1000. Eligibility requires strictly more than 200 units. Read this rule again whenever campaign changes. Test the boundary below, exactly at, and above the threshold.\n"
        : "gate-v1.0.0 / campaign A: integer amounts 0..1000. Eligibility starts at 100 units, including exactly 100. Test the boundary below, exactly at, and above the threshold.\n");
    };
    await spec();
    await writeFile(join(repo, "gate.mjs"), "export const eligible = amount => amount > 100;\n");
    await writeFile(join(repo, "gate.test.mjs"), "import assert from 'node:assert/strict'; import {test} from 'node:test'; import {eligible} from './gate.mjs';\nfor (const [n,want] of [[99,false],[100,true],[101,true]]) test('boundary '+n,()=>assert.equal(eligible(n),want));\n");
    const before = await command(repo, ["node", "--test", "gate.test.mjs"]); commands.push(before);
    assert.notEqual(before.exit_code, 0);
    await writeFile(join(repo, "gate.mjs"), "export const eligible = amount => amount >= 100;\n");
    const after = await command(repo, ["node", "--test", "gate.test.mjs"]); commands.push(after); assert.equal(after.exit_code, 0);
    assert.equal((await command(repo, ["git", "add", "SPEC.md", "gate.mjs", "gate.test.mjs"])).exit_code, 0);
    assert.equal((await command(repo, ["git", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fictional threshold fixture"])).exit_code, 0);
    const revision = (await command(repo, ["git", "rev-parse", "HEAD"])).stdout.trim();
    const seed = seedAccepted(db, "gate threshold boundary regression", `Observed defect: gate.mjs used >100, SPEC campaign A requires >=100. Node tests 99/100/101 failed at 100 before fix; after >=100 all passed. Reusable lesson: test below/at/above threshold, read current business specification each time; do not hardcode campaign A in another campaign. Code version ${VERSION}.`, revision);
    let memoryID = "";
    const reflect = (key: string, example: Record<string, unknown>) => async (row: MemoryReflection, lease: ReflectionLease, innerSignal: AbortSignal) => {
      const tools = traceTools(createMemoryReflectionTools(db, lease), steps[key] ??= []);
      return driver.reflect(db, row, lease, innerSignal, tools, example);
    };
    const example = memoryInput(seed);
    await observe("first_learning", async facts => {
      await runMemoryReflectionOnce(db, { signal, reflect: reflect("first_learning", example) });
      facts.reflections = reflectionRows(db); facts.memory = listPiMemoryItems(db);
      const memory = listPiMemoryItems(db)[0];
      assert(memory && memory.authority === "evidence_backed", "reflection did not save verified memory");
      assert.equal(reflectionRows(db)[0].status, "completed"); memoryID = memory.id;
      assert(parseMemoryExperience(memory.content));
    });
    const task = async (id: "without_memory" | "similar_expression" | "changed_business_rule", threshold: number, inclusive: boolean) => observe(id, async facts => {
      const context = { project: getProject(db, PROJECT)!, projectID: PROJECT, source: "pi_memory_replay",
        conversationID: `replay-${id}`, authorization: { ...reflectionAuthorization(PROJECT),
          allowedActions: ["memory.search", "repo.read_excerpt"], authorizedActions: ["memory.search", "repo.read_excerpt"].map(action_type => ({ action_type, project_id: PROJECT })) } };
      const repository = createPiRunnerActionTools(createPiRunnerActions(db, context)).filter(tool => tool.name === "repo_read_excerpt");
      const memory = createPiMemoryTools(db, context).filter(tool => tool.name === "memory_search");
      const tools = traceTools([...repository, ...(id === "without_memory" ? [] : memory)], steps[id] ??= []);
      const fixture = async () => {
        await invoke(tools, "repo_read_excerpt", { path: "SPEC.md" });
        const refs: unknown[] = [];
        if (id !== "without_memory") {
          const input = { query: "gate threshold boundary regression", version: VERSION, token_budget: 4000 };
          const found = await invoke(tools, "memory_search", input);
          const selection = (found.items ?? []).map((item: any) => ({ id: item.id, revision: item.revision, content_fingerprint: item.content_fingerprint, reason: "Only reuse boundary testing method; read current spec for business values" }));
          const selected = await invoke(tools, "memory_search", { ...input, selection });
          refs.push(...selected.items.map(({ id, revision, content_fingerprint }: any) => ({ id, revision, content_fingerprint })));
        }
        return JSON.stringify({ tests: [threshold - 1, threshold, threshold + 1].map(amount => ({ amount, eligible: inclusive ? amount >= threshold : amount > threshold })), memory_refs: refs, explanation: "Fixture policy uses the current specification" });
      };
      const raw = await driver.task(db, tools, TASK_PROMPT, signal, fixture); facts.raw = raw;
      Object.assign(facts, scoreTask(raw, steps[id], threshold, inclusive, id === "similar_expression"));
    });
    await task("without_memory", 100, true);
    await task("similar_expression", 100, true);
    await spec(true);
    await writeFile(join(repo, "gate.mjs"), "export const eligible = amount => amount > 200;\n");
    await writeFile(join(repo, "gate.test.mjs"), "import assert from 'node:assert/strict'; import {test} from 'node:test'; import {eligible} from './gate.mjs';\nfor (const [n,want] of [[199,false],[200,false],[201,true]]) test('boundary '+n,()=>assert.equal(eligible(n),want));\n");
    const changed = await command(repo, ["node", "--test", "gate.test.mjs"]); commands.push(changed); assert.equal(changed.exit_code, 0);
    await task("changed_business_rule", 200, false);
    await observe("correction", async facts => {
      const previous = listPiMemoryItems(db)[0];
      // 旧正文通过 memory_search 读取；重复嵌入会挤掉 Host 有界摘要中的新证据与纠错范围。
      const next = seedAccepted(db, "gate threshold boundary regression correction", `New verified scope: campaign B uses strictly >200; Node tests 199=false,200=false,201=true passed. Previous memory ${previous.id} revision ${previous.revision}, key ${previous.memory_key}. Narrow the existing lesson to integer threshold tests where current campaign SPEC has been read; never reuse campaign A's inclusive 100 rule for B. Version ${VERSION}.`, revision);
      const input = memoryInput(next);
      const content = JSON.parse(String(input.content)); content.applies_when = "gate threshold boundary regression integer";
      content.resolution = "Read the current campaign SPEC; test T-1, T, T+1 using the specified operator. B is >200, A is >=100.";
      await runMemoryReflectionOnce(db, { signal, reflect: reflect("correction", { ...input, memory_key: previous.memory_key,
        content: JSON.stringify(content), correction: { expected_revision: previous.revision, disposition: "narrow", reason: "Verified new campaign evidence limits reuse to the testing method; business operators must be read again" } }) });
      facts.reflections = reflectionRows(db); facts.history = listPiMemoryHistory(db, memoryID);
      const corrected = listPiMemoryItems(db).find(item => item.id === memoryID);
      assert(corrected && corrected.revision > previous.revision, "existing memory was not corrected");
      assert.equal(listPiMemoryItems(db).length, 1, "correction duplicated memory");
      const history = listPiMemoryHistory(db, memoryID); assert(history.some(item => item.correction.disposition === "narrow"));
      facts.current = corrected;
    });
    await observe("restart_deduplication", async facts => {
      const calls = driver.calls(); const previous = reflectionRows(db).length;
      const memories = listPiMemoryItems(db).map(item => [item.id, item.revision, item.occurrence_count]);
      acceptance(db, seed.issueID, seed.legacyRunID);
      db.close(); db = await openDatabase({ stateDir: state });
      let invoked = 0;
      assert.equal(await runMemoryReflectionOnce(db, { signal, reflect: async () => { invoked++; throw new Error("duplicate model dispatch"); } }), false);
      assert.equal(invoked, 0); assert.equal(driver.calls(), calls); assert.equal(reflectionRows(db).length, previous);
      assert.deepEqual(listPiMemoryItems(db).map(item => [item.id, item.revision, item.occurrence_count]), memories);
      facts.provider_calls_delta = driver.calls() - calls; facts.reflections = reflectionRows(db); facts.memory_identities = memories;
      facts.retrieval = retrievePiMemoryContext(db, { projectID: PROJECT, query: "gate threshold boundary regression integer current campaign SPEC read", version: VERSION, tokenBudget: 4000 });
      assert((facts.retrieval as any).memory_items.some((item: any) => item.id === memoryID), "corrected experience cannot be retrieved");
    });
    await observe("forget_no_resurrection", async facts => {
      deletePiMemoryItem(db, memoryID);
      const calls = driver.calls();
      // 新 Evidence 指纹也不能唤醒已遗忘来源。
      recordEvidenceRecords(db, seed.issueID, [{ ...seed.evidence, id: `${seed.evidence.id}-new` }], { source: "memory-replay", recorded_at: new Date().toISOString() });
      db.close(); db = await openDatabase({ stateDir: state });
      let invoked = 0;
      await runMemoryReflectionOnce(db, { signal, reflect: async () => { invoked++; throw new Error("forgotten model dispatch"); } });
      assert.equal(invoked, 0); assert.equal(listPiMemoryItems(db).length, 0); assert.equal(driver.calls(), calls);
      facts.reflections = reflectionRows(db); facts.provider_calls_delta = driver.calls() - calls;
      assert(reflectionRows(db).some(row => row.reason === "source_memory_suppressed"));
    });
    await observe("budget_nonblocking", async facts => {
      const last = seedAccepted(db, "gate budget failure", "Synthetic completed Work for budget-failure injection only", revision);
      let invoked = 0;
      const dispatches: number[] = [];
      const fail = async () => {
        invoked++;
        let dispatched = 0;
        const fauxAgent = { streamFunction: (_model: unknown, _context: unknown) => { dispatched++; return {}; }, subscribe: () => () => {} };
        const stop = installMemoryReflectionBudget(fauxAgent as never, signal);
        try { for (let i = 0; i < 5; i++) fauxAgent.streamFunction({}, { messages: [] }); }
        finally { dispatches.push(dispatched); stop(); }
        throw new Error("reflection budget did not stop dispatch");
      };
      for (let i = 0; i < 3; i++) await runMemoryReflectionOnce(db, { signal, reflect: fail });
      assert.equal(invoked, 2);
      assert.deepEqual(dispatches, [4, 4], "each attempt must reach the real call-budget boundary");
      const reflections = reflectionRows(db);
      assert.equal(reflections.at(-1)?.reason, "reflection model call budget exceeded");
      const status = db.sqlite.query<{status: string}, [number]>("select status from issues where id=?").get(last.issueID)!.status;
      assert.equal(status, "done"); facts.work_status = status; facts.attempts = invoked; facts.fault_injection = true;
      facts.fake_dispatches_per_attempt = dispatches; facts.reflections = reflections;
    });
    await observe("permission_boundary", async facts => {
      const tools = createPiMemoryTools(db, { projectID: PROJECT, source: "pi_memory_reflection", authorization: {
        mode: "delegated", scope: { project_id: PROJECT }, allowedActions: ["memory.search"],
        authorizedActions: [{ action_type: "memory.search", project_id: PROJECT }] } });
      facts.result = await invoke(tools, "memory_remember", example);
      assert.equal(listPiMemoryItems(db).length, 0);
      const rejected = facts.result as any;
      assert.equal(rejected.status, "denied"); assert.equal(rejected.decision, "deny");
      assert.match(rejected.gate_reason, /allowed_actions/, "write must be rejected by permission scope, not only by memory suppression");
    });
  } catch (error) {
    // 首个不确定阶段后不继续消费 live 预算；初始化失败也必须显式报告。
    if (!cases.some(row => row.status === "failed")) cases.push({ id: "first_learning", status: "failed", elapsed_ms: 0,
      facts: { stage: "setup" }, error: redactSensitiveText(error instanceof Error ? error.message : String(error)) });
  }
  finally {
    const audit = db.sqlite.query("select action_type,status from pi_actions").all();
    await writeFile(join(root, "audit.json"), JSON.stringify(audit, null, 2));
    db.close();
    for (const id of REPLAY_CASES) if (!cases.some(row => row.id === id)) cases.push({ id, status: "not_run", elapsed_ms: 0, facts: {} });
    await writeFile(join(root, "tool-steps.json"), JSON.stringify(steps, null, 2));
    await writeFile(join(root, "commands.json"), JSON.stringify(commands, null, 2));
    await checkpoint(cases);
  }
  return { kind: driver.kind, cases, status: cases.every(row => row.status === "passed") ? "passed" : "failed", root };
}

function reflectionRows(db: RunnerDatabase) {
  return db.sqlite.query<{ id: string; status: string; attempts: number; reason: string; memory_id: string }, []>(
    "select id,status,attempts,reason,memory_id from pi_memory_reflections order by rowid").all();
}
function acceptance(db: RunnerDatabase, id: number, run: string) {
  recordIssueEvent(db, id, "issue.pi_acceptance_applied.v1", { action: "accept", run_id: run, decision: { rationale: "Isolated replay: observed local tests passed" } });
}
function seedAccepted(db: RunnerDatabase, title: string, summary: string, revision: string) {
  const at = new Date().toISOString();
  db.sqlite.run("insert into issues (project_id,title,status,created_at,updated_at) values (?,?,'done',?,?)", [PROJECT, title, at, at]);
  const issueID = Number(db.sqlite.query<{ id: number }, []>("select last_insert_rowid() id").get()!.id);
  const legacyRunID = `replay-${issueID}`;
  db.sqlite.run("insert into issue_runs (id,issue_id,attempt,status,provider,started_at,ended_at) values (?,?,1,'succeeded','codex',?,?)", [legacyRunID, issueID, at, at]);
  const workID = `xw:work:issues:${issueID}` as const;
  const runID = `xw:run:issue_runs:${legacyRunID}` as const;
  const evidence: EvidenceRecord = { schema_version: 1, id: `xw:evidence:issue_events:replay-${issueID}`, work_id: workID, run_id: runID,
    revision: 0, kind: "test", status: "passed", created_at: at, observed_at: at, updated_at: at, completed_at: at,
    decisive_output: { summary, exit_code: 0, facts: { command: "node --test gate.test.mjs", fixture: true } }, artifact_refs: [],
    provenance: { assertion_origin: "tool_result", source_kind: "test_runner", source_ref: "commands.json", audit_event_ref: `replay:${issueID}`, producer: { id: "memory-replay", kind: "runner" } },
    redaction: { status: "not_required", policy_ref: "synthetic-project", redacted_paths: [] } };
  recordEvidenceRecords(db, issueID, [evidence], { source: "memory-replay", recorded_at: at });
  recordHandoff(db, issueID, { schema_version: 1, id: `xw:handoff:derived:replay-${issueID}`, work_id: workID, run_ids: [runID], evidence_ids: [evidence.id],
    revision: 0, status: "ready", summary: title, created_at: at, updated_at: at, baseline_revision: revision, final_revision: revision, review_ref: revision,
    changed_files: ["gate.mjs", "gate.test.mjs"], delivery: { mode: "local_changes", working_tree_ref: revision }, delivery_actions: [], risks: [],
    rollback: { availability: "not_required", destructive: false, refs: [] }, review: { required: false, state: "not_requested", reviewer_refs: [] } }, { source: "memory-replay", recorded_at: at });
  acceptance(db, issueID, legacyRunID);
  return { issueID, legacyRunID, workID, runID, evidence };
}
function memoryInput(seed: ReturnType<typeof seedAccepted>) {
  const experience: MemoryExperience = { schema_version: 1, applies_when: "gate threshold boundary regression", symptom: "Threshold equality rejected",
    root_cause: "Strict comparison used for inclusive campaign A", resolution: "Read SPEC and test T-1,T,T+1; use the campaign operator, not remembered business values",
    failed_attempts: [], verification: { method: "node --test gate.test.mjs", evidence_refs: [`evidence:${seed.evidence.id}`] },
    source: { work_id: seed.workID, run_id: seed.runID, refs: [`work:${seed.workID}`, `run:${seed.runID}`] }, version: VERSION };
  return { kind: "debugging_pattern", memory_key: "gate.threshold.boundary", confidence: "high", content: JSON.stringify(experience) };
}
export const fixtureDriver: ReplayDriver = {
  kind: "fixture", calls: () => 0,
  async reflect(_db, _row, _lease, _signal, tools, example) {
    await invoke(tools, "reflection_evidence_read"); await invoke(tools, "memory_search", { query: "gate threshold boundary regression v1.0.0" });
    // 仅离线 fixture 适配测试策略；live driver 不读取 example，也不改写模型输出。
    const { schema_version, source, outcome, verification, ...content } = parseMemoryExperience(String(example.content))!;
    const correction = example.correction as { disposition: "narrow" | "disable"; reason: string } | undefined;
    const result = await invoke(tools, "memory_remember", { ...example,
      content: { ...content, verification: { method: verification.method, evidence_indices: [0] } },
      ...(correction ? { correction: { disposition: correction.disposition, reason: correction.reason } } : {}) });
    assert(result.id, JSON.stringify(result)); return '{"status":"saved"}';
  },
  async task(_db, _tools, _prompt, _signal, fixture) { return fixture(); }
};
