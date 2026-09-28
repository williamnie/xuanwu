import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import {
  createPiMemoryItem,
  getPiMemoryItem,
  listPiActionEvents,
  listPiActions,
  listPiMemoryItems,
  listPiMemoryHistory,
  rememberPiMemoryItem,
  updatePiMemoryItem,
  deletePiMemoryItem
} from "../db/repositories/pi.ts";
import { createPiMemoryTools, PI_MEMORY_TOOL_NAMES } from "./memoryTools.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { retrievePiMemoryContext } from "./memoryContext.ts";

describe("PI memory tools", () => {
  test("remembers an explicit preference as active memory and reuses its stable key", async () => {
    const fixture = await openFixture();
    try {
      const tools = createPiMemoryTools(fixture.db, {
        conversationID: "conv-1",
        projectID: "demo",
        source: "runner_chat"
      });
      const search = toolByName(tools, "memory_search");
      const remember = toolByName(tools, "memory_remember");

      expect(tools.map((tool) => tool.name).sort()).toEqual([...PI_MEMORY_TOOL_NAMES].sort());
      expect(validateArgs(search, { query: "minimal", scope: "project" })).toEqual({
        query: "minimal",
        scope: "project"
      });
      expect(validateArgs(remember, {
        kind: "user_preference", content: "Prefer small patches", memory_key: "user.patch-size"
      })).toMatchObject({ kind: "user_preference", memory_key: "user.patch-size" });
      expect(() => validateArgs(remember, { kind: "user_preference", content: " ", memory_key: "user.patch-size" }))
        .toThrow(/Validation failed/);
      expect(() => validateArgs(search, { include_candidates: true })).toThrow(/Validation failed/);

      const remembered = await remember.execute("tool-1", {
        kind: "user_preference",
        content: "Prefer small patches",
        confidence: "high",
        memory_key: "user.patch-size",
        scope: "global",
        user_authorized: true
      }, undefined, undefined, {} as never);
      const activeSearch = await search.execute("tool-2", {
        query: "patches"
      }, undefined, undefined, {} as never);
      const secondSearch = await search.execute("tool-3", { query: "patches" }, undefined, undefined, {} as never);

      expect(remembered.details).toMatchObject({
        authority: "user_explicit",
        authorized_by: "conv-1",
        disabled: 0,
        kind: "user_preference",
        memory_key: "user.patch-size",
        occurrence_count: 1,
        scope: "global",
        scope_id: "runner",
        source_id: "conv-1",
        source_type: "pi.conversation"
      });
      const rememberedDetails = remembered.details as { id: string };
      expect(getPiMemoryItem(fixture.db, String(rememberedDetails.id))).toMatchObject({ disabled: 0 });
      expect((activeSearch.details as { items: Array<{ id: string }> }).items.map((item) => item.id))
        .toEqual([String(rememberedDetails.id)]);
      expect((secondSearch.details as { items: Array<{ id: string }> }).items.map((item) => item.id))
        .toEqual([String(rememberedDetails.id)]);
      expect(listPiMemoryItems(fixture.db, { disabled: 1 })).toEqual([]);
      const memorySearchActions = listPiActions(fixture.db).filter((item) => item.action_type === "memory.search");
      expect(memorySearchActions).toHaveLength(2);
      expect(memorySearchActions.every((item) => item.status === "completed")).toBe(true);
      const action = listPiActions(fixture.db).find((item) => item.action_type === "memory.remember");
      expect(action).toMatchObject({
        conversation_id: "conv-1",
        gate_decision: "execute",
        project_id: "runner",
        status: "completed"
      });
      expect(listPiActionEvents(fixture.db, { actionId: action?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("does not persist sensitive memory candidates from PI tools", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-secret",
        projectID: "demo",
        source: "runner_chat"
      }), "memory_remember");

      const result = await writeCandidate.execute("tool-secret", {
        kind: "constraint",
        content: "XUANWU_AUTH_TOKEN=fixture-secret",
        confidence: "high",
        memory_key: "project.secret",
        user_authorized: true
      }, undefined, undefined, {} as never);

      expect(result.details).toEqual({
        rejected: true,
        reason: "memory content contains sensitive data"
      });
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  test("activates only an explicitly authorized structured preference without inspecting wording", async () => {
    const fixture = await openFixture();
    try {
      const writeCandidate = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "conv-authorized",
        projectID: "demo",
        source: "runner_chat"
      }), "memory_remember");

      const result = await writeCandidate.execute("tool-authorized", {
        content: "Zed",
        kind: "user_preference",
        memory_key: "user.display-name",
        scope: "global",
        user_authorized: true
      }, undefined, undefined, {} as never);

      expect(result.details).toMatchObject({
        content: "Zed",
        disabled: 0,
        kind: "user_preference",
        scope: "global"
      });
    } finally {
      await fixture.close();
    }
  });

  test("rejects status snapshots and deduplicates evidence-backed manager experience", async () => {
    const fixture = await openFixture();
    try {
      const remember = toolByName(createPiMemoryTools(fixture.db, {
        conversationID: "manager-cycle-1",
        projectID: "demo",
        source: "pi_manager_cycle"
      }), "memory_remember");

      const rejected = await remember.execute("tool-status", {
        confidence: "high",
        content: "当前 Issue #785 failed，等待人工处理。",
        evidence_ref: "run:785",
        kind: "resolution",
        memory_key: "bug.785.resolution",
        scope: "project"
      }, undefined, undefined, {} as never);
      expect(rejected.details).toEqual({
        rejected: true,
        reason: "current Work/Run/Issue status snapshots are not memory"
      });

      const seeded = seedMemoryExperience(fixture.db);
      const input = {
        confidence: "high",
        content: JSON.stringify(seeded.experience),
        evidence_ref: `handoff:${seeded.handoff.handoff.id}`,
        kind: "resolution" as const,
        memory_key: "runner.recovery-only-dependency",
        scope: "project"
      };
      const first = await remember.execute("tool-resolution-1", input, undefined, undefined, {} as never);
      const second = await remember.execute("tool-resolution-2", {
        ...input,
        content: JSON.stringify(Object.fromEntries(Object.entries(seeded.experience).reverse()))
      }, undefined, undefined, {} as never);

      expect(first.details).toMatchObject({ disabled: 0, occurrence_count: 1 });
      expect(first.details).toMatchObject({ authority: "evidence_backed", authorized_by: input.evidence_ref });
      expect(second.details).toMatchObject({
        disabled: 0,
        memory_key: "runner.recovery-only-dependency",
        occurrence_count: 1, revision: 1
      });
      expect(listPiMemoryItems(fixture.db)).toHaveLength(1);
      expect(retrievePiMemoryContext(fixture.db, { projectID: "demo", tokenBudget: 4000 }).memory_items[0])
        .toMatchObject({ authority: "evidence_backed", content: JSON.stringify(seeded.experience) });
    } finally {
      await fixture.close();
    }
  });

  test("retrieves project policy memory with correct project/global scope and redaction", async () => {
    const fixture = await openFixture();
    try {
      seedProjectPolicyFixture(fixture.db);
      const search = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo" }), "memory_search");

      expect(validateArgs(search, { kind: "project_policy_memory", scope: "project" }))
        .toMatchObject({ kind: "project_policy_memory", scope: "project" });
      const allRelevant = await search.execute("tool-project", {
        query: "Prefer"
      }, undefined, undefined, {} as never);
      const projectPolicy = await search.execute("tool-policy", {
        kind: "project_policy_memory",
        query: "runner",
        scope: "project"
      }, undefined, undefined, {} as never);
      const sensitive = await search.execute("tool-secret", {
        query: "fixture-secret",
        scope: "project"
      }, undefined, undefined, {} as never);
      const staleStatus = await search.execute("tool-stale-status", {
        query: "785",
        scope: "project"
      }, undefined, undefined, {} as never);

      expect(itemIds(allRelevant.details)).toEqual(expect.arrayContaining([
        "global-user-preference",
        "project-policy-memory"
      ]));
      expect(itemIds(allRelevant.details)).not.toContain("other-project-memory");
      expect(itemIds(projectPolicy.details)).toEqual(["project-policy-memory"]);
      expect(itemIds(sensitive.details)).toEqual([]);
      expect(itemIds(staleStatus.details)).toEqual([]);
      expect(JSON.stringify(sensitive.details)).not.toContain("fixture-secret");
    } finally {
      await fixture.close();
    }
  });

  test("corrects only with new evidence and an explicit narrower scope, retaining version provenance", async () => {
    const fixture = await openFixture();
    try {
      const firstSource = seedMemoryExperience(fixture.db);
      const secondSource = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const invoke = (content: unknown, correction?: { expected_revision: number; disposition: "narrow" | "disable"; reason: string }) =>
        remember.execute("correction", { kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(content), ...(correction ? { correction } : {}) }, undefined, undefined, {} as never);
      const original = (await invoke(firstSource.experience)).details as { id: string };
      const incoming = { ...secondSource.experience, root_cause: "超时取消未覆盖共享响应的所有回调", version: "runner v0.2.14" };
      expect((await invoke(incoming)).details).toMatchObject({ rejected: true });
      const correction = { expected_revision: 1, disposition: "narrow" as const, reason: "新的回归证明仅共享响应的回调需要此约束" };
      expect((await invoke(incoming, correction)).details).toMatchObject({ rejected: true });
      const narrow = { ...incoming, applies_when: "异步请求超时且多个回调共享同一响应时" };
      const repeatEvidence = { ...firstSource.experience, applies_when: narrow.applies_when };
      expect((await invoke(repeatEvidence, correction)).details).toMatchObject({ rejected: true });
      const corrected = (await invoke(narrow, correction)).details;
      expect(corrected).toMatchObject({ id: original.id, revision: 2, occurrence_count: 2, disabled: 0 });
      expect(listPiMemoryHistory(fixture.db, original.id)).toMatchObject([
        { revision: 1, operation: "create", snapshot: { content: JSON.stringify(firstSource.experience) } },
        { revision: 2, operation: "correct", correction, snapshot: { content: JSON.stringify(narrow) } }
      ]);
      // 旧来源回放不回滚已修正的结论；同一修正重试也不虚增出现次数。
      expect((await invoke(firstSource.experience)).details).toEqual(corrected);
      expect((await invoke(narrow, correction)).details).toEqual(corrected);
      expect(listPiMemoryHistory(fixture.db, original.id)).toHaveLength(2);
      const stale = seedMemoryExperience(fixture.db);
      expect((await invoke({ ...stale.experience, applies_when: "仅旧取消协议生效时" }, correction)).details)
        .toMatchObject({ rejected: true, reason: expect.stringContaining("revision conflict") });
      expect(listPiMemoryHistory(fixture.db, original.id)).toHaveLength(2);
    } finally { await fixture.close(); }
  });

  test("one failed task cannot invalidate a lesson, while verified conflict can disable it", async () => {
    const fixture = await openFixture();
    try {
      const old = seedMemoryExperience(fixture.db);
      const newer = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const initial = await remember.execute("initial", { kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(old.experience) }, undefined, undefined, {} as never);
      const failed = { ...newer.evidence, id: `${newer.evidence.id}-failure` as typeof newer.evidence.id, status: "failed" as const };
      newer.persistEvidence(failed);
      const correction = { expected_revision: 1, disposition: "disable" as const, reason: "独立回归显示旧修复不适用于新取消协议" };
      const input = { kind: "resolution" as const, memory_key: "bug.timeout", correction,
        content: JSON.stringify({ ...newer.experience, verification: { ...newer.experience.verification, evidence_refs: [`evidence:${failed.id}`] } }) };
      expect((await remember.execute("failed-task", input, undefined, undefined, {} as never)).details).toMatchObject({ rejected: true });
      const id = (initial.details as { id: string }).id;
      expect(getPiMemoryItem(fixture.db, id)).toMatchObject({ revision: 1, disabled: 0 });
      const disabled = await remember.execute("verified-conflict", { ...input, content: JSON.stringify(newer.experience) }, undefined, undefined, {} as never);
      expect(disabled.details).toMatchObject({ revision: 2, disabled: 1 });
      expect(retrievePiMemoryContext(fixture.db, { projectID: "demo" }).memory_items).toEqual([]);
      expect(listPiMemoryHistory(fixture.db, id).map((entry) => entry.operation)).toEqual(["create", "correct"]);
    } finally { await fixture.close(); }
  });

  test("same Run can gain a new evidence-backed revision without adding an occurrence", async () => {
    const fixture = await openFixture();
    try {
      const source = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const input = { kind: "resolution" as const, memory_key: "same-run.lesson", content: JSON.stringify(source.experience) };
      const initial = (await remember.execute("first", input, undefined, undefined, {} as never)).details as { id: string };
      const evidence = { ...source.evidence, id: `${source.evidence.id}-additional` as typeof source.evidence.id };
      source.persistEvidence(evidence);
      const correction = { expected_revision: 1, disposition: "narrow" as const, reason: "同一 Run 的新增回归覆盖共享取消句柄" };
      const result = await remember.execute("second", { ...input, correction,
        content: JSON.stringify({ ...source.experience, applies_when: "仅共享取消句柄且响应回调仍可执行时",
          verification: { ...source.experience.verification, evidence_refs: [`evidence:${evidence.id}`] } })
      }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ id: initial.id, revision: 2, occurrence_count: 1, source_id: source.runID });
      expect(listPiMemoryHistory(fixture.db, initial.id)).toHaveLength(2);
    } finally { await fixture.close(); }
  });

  test("rolls back item, receipt, suppression and history together when persistence fails", async () => {
    const fixture = await openFixture();
    try {
      const input = { id: "atomic", scope: "project", scope_id: "demo", kind: "decision", content: "用户明确要求小改动", memory_key: "atomic.lesson", source_id: "first" };
      const original = rememberPiMemoryItem(fixture.db, input);
      fixture.db.sqlite.run(`create trigger reject_memory_history before insert on pi_memory_history
        when new.revision>1 begin select raise(abort, 'fixture history unavailable'); end`);
      expect(() => rememberPiMemoryItem(fixture.db, { ...input, content: "用户明确要求增加定向测试", source_id: "second" })).toThrow("fixture history unavailable");
      expect(() => updatePiMemoryItem(fixture.db, original.id, { disabled: 1 })).toThrow("fixture history unavailable");
      expect(() => deletePiMemoryItem(fixture.db, original.id)).toThrow("fixture history unavailable");
      expect(getPiMemoryItem(fixture.db, original.id)).toEqual(original);
      expect(listPiMemoryHistory(fixture.db, original.id)).toHaveLength(1);
      expect(fixture.db.sqlite.query("select * from pi_memory_suppressions").all()).toEqual([]);
      expect(fixture.db.sqlite.query("select * from pi_memory_receipts").all()).toHaveLength(1);
      fixture.db.sqlite.run("drop trigger reject_memory_history");
      expect(rememberPiMemoryItem(fixture.db, { ...input, source_id: "second" })).toMatchObject({ revision: 2, occurrence_count: 2 });
    } finally { await fixture.close(); }
  });

  test("serializes independent processes and preserves correction ownership after reopening", async () => {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-memory-concurrent-"));
    let db = await openDatabase({ stateDir: join(root, "state"), writerBusyTimeoutMs: 10000 });
    try {
      const original = seedMemoryExperience(db);
      const left = seedMemoryExperience(db);
      const right = seedMemoryExperience(db);
      const input = { kind: "resolution", memory_key: "concurrent.lesson", content: JSON.stringify(original.experience) };
      const [a, b] = await concurrentRemember(root, db.path, [input, input]);
      expect(a).toMatchObject({ revision: 1, occurrence_count: 1 });
      expect(b).toMatchObject({ id: a.id, revision: 1, occurrence_count: 1 });
      const correctedInputs = [left, right].map((source, i) => ({ ...input,
        content: JSON.stringify({ ...source.experience, applies_when: `仅回调分支 ${i} 共享响应且会超时时` }),
        correction: { expected_revision: 1, disposition: "narrow", reason: `独立回归限定分支 ${i}` }
      }));
      const outcomes = await concurrentRemember(root, db.path, correctedInputs);
      expect(outcomes.filter((item) => item.revision === 2)).toHaveLength(1);
      expect(outcomes.filter((item) => item.rejected === true)).toMatchObject([{ reason: expect.stringContaining("revision conflict") }]);
      const winner = outcomes.find((item) => item.revision === 2)!;
      db.close();
      db = await openDatabase({ dbPath: join(root, "state", "runner.db") });
      const persisted = getPiMemoryItem(db, a.id);
      if (!persisted) throw new Error("concurrent memory missing after restart");
      expect(winner).toEqual(persisted);
      expect(listPiMemoryHistory(db, a.id)).toMatchObject([
        { revision: 1, snapshot: { content: input.content } },
        { revision: 2, operation: "correct", snapshot: { content: winner.content } }
      ]);
      const [replay] = await concurrentRemember(root, db.path, [input]);
      expect(replay).toEqual(winner);
      expect(listPiMemoryHistory(db, a.id)).toHaveLength(2);
    } finally { db.close(); await rm(root, { recursive: true, force: true }); }
  }, 30000);

  test("rejects every forged or mismatched experience reference, including secondary references", async () => {
    const fixture = await openFixture();
    try {
      const own = seedMemoryExperience(fixture.db);
      const otherProject = seedMemoryExperience(fixture.db, "other");
      const otherWork = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const input = { kind: "resolution" as const, memory_key: "bug.timeout", content: JSON.stringify(own.experience) };
      const withRef = (ref: string) => JSON.stringify({ ...own.experience,
        source: { ...own.experience.source, refs: [...own.experience.source.refs, ref] } });
      const withEvidence = (ref: string) => JSON.stringify({ ...own.experience,
        verification: { ...own.experience.verification, evidence_refs: [...own.experience.verification.evidence_refs, ref] } });
      const candidates = [
        { evidence_ref: "handoff:invented" },
        { evidence_ref: "run:123" },
        { evidence_ref: "work:xw:work:issues:99999999" },
        { content: withRef("evidence:xw:evidence:issue_events:invented") },
        { content: withRef("issue_event:99999999") },
        { content: withRef(`handoff:${otherProject.handoff.handoff.id}`) },
        { content: withRef(`issue_event:${otherProject.handoff.event_id}`) },
        { content: withEvidence(`evidence:${otherProject.evidence.id}`) },
        { content: withEvidence(`evidence:${otherWork.evidence.id}`) },
        { content: withEvidence(`run:${own.runID}`) },
        { content: JSON.stringify(otherProject.experience) },
        { content: JSON.stringify({ ...own.experience, source: { ...own.experience.source, run_id: otherWork.runID } }) },
        { content: JSON.stringify({ ...own.experience, source: { ...own.experience.source, work_id: "xw:work:issues:99999999" } }) },
        { content: JSON.stringify({ ...own.experience, source: { ...own.experience.source, run_id: "xw:run:issue_runs:missing" } }) },
        { scope: "global" },
        { scope_id: "other" },
        { confidence: "queue length 5" },
        { kind: "decision" as const, user_authorized: true },
        { content: "根因是超时，修复并验证通过。", evidence_ref: `evidence:${own.evidence.id}` },
        { content: JSON.stringify({ ...own.experience, applies_when: " " }) },
        { content: JSON.stringify({ ...own.experience, schema_version: 2 }) },
        { content: JSON.stringify({ ...own.experience, version: "" }) },
        { content: JSON.stringify({ ...own.experience, verification: { method: "tests pass", evidence_refs: [] } }) },
        { content: JSON.stringify({ ...own.experience, symptom: "当前任务已完成，根因已修复" }) },
        { content: JSON.stringify({ ...own.experience, symptom: "队列数量为 5，根因已修复" }) }
      ];
      for (const [index, patch] of candidates.entries()) {
        const result = await remember.execute(`reject-${index}`, { ...input, ...patch }, undefined, undefined, {} as never);
        expect(result.details, JSON.stringify(patch)).toMatchObject({ rejected: true });
      }
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
      const noProject = toolByName(createPiMemoryTools(fixture.db, { source: "pi_manager_cycle" }), "memory_remember");
      expect((await noProject.execute("no-project", input, undefined, undefined, {} as never)).details).toMatchObject({ rejected: true });
    } finally { await fixture.close(); }
  });

  test("requires passed, trusted, unsuperseded Evidence from the exact Run", async () => {
    const fixture = await openFixture();
    try {
      const own = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const variants = [
        { status: "failed" as const },
        { status: "blocked" as const },
        { status: "pending" as const, completed_at: undefined },
        { provenance: { ...own.evidence.provenance, assertion_origin: "agent_claim" as const, source_kind: "agent_statement" as const } },
        { kind: "future_unverified" },
        { decisive_output: { ...own.evidence.decisive_output, exit_code: 1 } },
        { run_id: undefined },
        { run_id: `${own.runID}-different` as typeof own.runID }
      ];
      for (const [index, patch] of variants.entries()) {
        const record = { ...own.evidence, ...patch, id: `${own.evidence.id}-${index}` as typeof own.evidence.id };
        own.persistEvidence(record);
        const experience = { ...own.experience, verification: { ...own.experience.verification, evidence_refs: [`evidence:${record.id}`] } };
        const result = await remember.execute(`verification-${index}`, {
          kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(experience)
        }, undefined, undefined, {} as never);
        expect(result.details, JSON.stringify(patch)).toMatchObject({ rejected: true });
      }
      own.persistEvidence({ ...own.evidence, id: `${own.evidence.id}-correction`, supersedes_id: own.evidence.id, status: "failed" });
      const corrected = await remember.execute("corrected", {
        kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(own.experience)
      }, undefined, undefined, {} as never);
      expect(corrected.details).toMatchObject({ rejected: true, reason: "experience Evidence has been superseded" });
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
    } finally { await fixture.close(); }
  });

  test("defaults to project scope and accepts verified experience without keyword heuristics or a terminal Work", async () => {
    const fixture = await openFixture();
    try {
      const own = seedMemoryExperience(fixture.db);
      const failed = { ...own.evidence, id: `${own.evidence.id}-failed` as typeof own.evidence.id, status: "failed" as const,
        decisive_output: { ...own.evidence.decisive_output, exit_code: 1 } };
      own.persistEvidence(failed);
      own.experience.source.refs.push(`evidence:${failed.id}`, `issue_event:${own.handoff.event_id}`);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      const result = await remember.execute("valid", {
        kind: "debugging_pattern", memory_key: "bug.timeout", content: JSON.stringify(own.experience)
      }, undefined, undefined, {} as never);
      expect(result.details).toMatchObject({ authority: "evidence_backed", disabled: 0, scope: "project", scope_id: "demo",
        authorized_by: `evidence:${own.evidence.id}`, citation_type: "evidence", citation_id: own.evidence.id });
      expect(listPiMemoryItems(fixture.db)).toHaveLength(1);
    } finally { await fixture.close(); }
  });

  test("rejects credentials before persisting an action payload or audit event", async () => {
    const fixture = await openFixture();
    try {
      const own = seedMemoryExperience(fixture.db);
      const remember = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle" }), "memory_remember");
      for (const secret of ["password=fixture-secret", '"password":"fixture-secret"', "-----BEGIN PRIVATE KEY-----",
        "ghp_abcdefghijklmnopqrstuvwxyz123456", "密码：fixture-secret"]) {
        const experience = { ...own.experience, failed_attempts: [secret] };
        const result = await remember.execute("secret", {
          kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(experience)
        }, undefined, undefined, {} as never);
        expect(result.details).toMatchObject({ rejected: true, reason: "memory content contains sensitive data" });
      }
      const metadata = await remember.execute("secret-ref", {
        kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(own.experience), evidence_ref: "token=fixture-secret"
      }, undefined, undefined, {} as never);
      expect(metadata.details).toMatchObject({ rejected: true });
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
      expect(listPiActions(fixture.db)).toEqual([]);
      expect(listPiActionEvents(fixture.db)).toEqual([]);
    } finally { await fixture.close(); }
  });

  test("keeps Action Gate authorization and project read/write boundaries", async () => {
    const fixture = await openFixture();
    try {
      const own = seedMemoryExperience(fixture.db);
      const tools = createPiMemoryTools(fixture.db, { projectID: "demo", source: "pi_manager_cycle",
        authorization: { mode: "delegated", allowedActions: ["memory.search"], scope: { project_id: "demo" }, enforceAuthorizedReadScope: true } });
      const denied = await toolByName(tools, "memory_remember").execute("denied", {
        kind: "resolution", memory_key: "bug.timeout", content: JSON.stringify(own.experience)
      }, undefined, undefined, {} as never);
      expect(denied.details).toMatchObject({ decision: "deny" });
      const search = await toolByName(tools, "memory_search").execute("cross-read", {
        scope: "project", scope_id: "other"
      }, undefined, undefined, {} as never);
      expect(search.details).toMatchObject({ decision: "deny" });
      expect(listPiMemoryItems(fixture.db)).toEqual([]);
    } finally { await fixture.close(); }
  });
});

async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-bun-pi-memory-tools-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  return { db, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}

function toolByName(tools: ReturnType<typeof createPiMemoryTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

function validateArgs(tool: ReturnType<typeof toolByName>, args: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
}

function seedMemory(db: RunnerDatabase, item: {
  content: string; id: string; kind: string; scope: string; scope_id: string;
}) {
  return createPiMemoryItem(db, {
    ...item,
    confidence: "high",
    disabled: 0
  });
}

function seedProjectPolicyFixture(db: RunnerDatabase): void {
  seedMemory(db, policyMemory("project-policy-memory", "demo",
    "Prefer verification evidence before marking runner issues done"));
  seedMemory(db, {
    id: "global-user-preference",
    scope: "global",
    scope_id: "runner",
    kind: "user_preference",
    content: "Prefer concise Chinese progress updates"
  });
  seedMemory(db, {
    id: "global-policy-memory",
    scope: "global",
    scope_id: "runner",
    kind: "project_policy_memory",
    content: "Prefer runner-level housekeeping"
  });
  seedMemory(db, policyMemory("other-project-memory", "other", "Prefer broad refactors"));
  seedMemory(db, policyMemory("sensitive-memory", "demo", "XUANWU_AUTH_TOKEN=fixture-secret"));
  seedMemory(db, {
    id: "stale-issue-status",
    scope: "project",
    scope_id: "demo",
    kind: "decision",
    content: "当前 Issue #785 failed，等待人工处理。"
  });
}

function policyMemory(id: string, scopeID: string, content: string) {
  return { id, scope: "project", scope_id: scopeID, kind: "project_policy_memory", content };
}

function itemIds(details: unknown): string[] {
  const items = (details as { items?: Array<{ id: string }> }).items ?? [];
  return items.map((item) => item.id).sort();
}

async function concurrentRemember(root: string, dbPath: string, inputs: Record<string, unknown>[]): Promise<Record<string, any>[]> {
  const prefix = join(root, crypto.randomUUID());
  const worker = `${prefix}.ts`;
  await Bun.write(worker, `
    import { openDatabase } from ${JSON.stringify(join(import.meta.dir, "../db/database.ts"))};
    import { createPiMemoryTools } from ${JSON.stringify(join(import.meta.dir, "memoryTools.ts"))};
    const [dbPath, prefix, index, payload] = process.argv.slice(2);
    const db = await openDatabase({ dbPath, writerBusyTimeoutMs: 10000 });
    try {
      await Bun.write(prefix + '.' + index + '.ready', 'ready');
      while (!await Bun.file(prefix + '.start').exists()) await new Promise(resolve => setTimeout(resolve, 5));
      const remember = createPiMemoryTools(db, { projectID: 'demo', source: 'pi_manager_cycle' }).find(tool => tool.name === 'memory_remember');
      const result = await remember.execute('concurrent', JSON.parse(payload), undefined, undefined, {});
      await Bun.write(prefix + '.' + index + '.result', JSON.stringify(result.details));
    } finally { db.close(); }
  `);
  const children = inputs.map((input, i) => Bun.spawn({
    cmd: [process.execPath, worker, dbPath, prefix, String(i), JSON.stringify(input)], stdout: "pipe", stderr: "pipe"
  }));
  try {
    const deadline = Date.now() + 15000;
    while (!(await Promise.all(inputs.map((_, i) => Bun.file(`${prefix}.${i}.ready`).exists()))).every(Boolean)) {
      if (Date.now() > deadline) throw new Error("memory worker startup timed out");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await Bun.write(`${prefix}.start`, "start");
    const exits = await Promise.all(children.map(async (child) => ({
      code: await child.exited, stderr: await new Response(child.stderr).text()
    })));
    for (const exit of exits) expect(exit.code, exit.stderr).toBe(0);
    return Promise.all(inputs.map((_, i) => Bun.file(`${prefix}.${i}.result`).json()));
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  }
}
