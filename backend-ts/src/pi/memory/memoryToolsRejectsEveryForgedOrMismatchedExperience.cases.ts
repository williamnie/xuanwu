import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
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
} from "../../db/repositories/pi.ts";
import { createPiMemoryTools, PI_MEMORY_TOOL_NAMES } from "./memoryTools.ts";
import { seedMemoryExperience } from "./memoryExperienceTestFixtures.ts";
import { retrievePiMemoryContext } from "./memoryContext.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, openFixture, toolByName, validateArgs, seedMemory, seedProjectPolicyFixture, policyMemory, itemIds, concurrentRemember } from "./memoryToolsTestFixtures.ts";

export function registerRejectsEveryForgedOrMismatchedExperience() {
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

test("lets Pi narrow bounded text candidates and rejects stale, forged or suppressed selections", async () => {
    const fixture = await openFixture();
    try {
      const { experience } = seedMemoryExperience(fixture.db);
      const item = createPiMemoryItem(fixture.db, { id: "selectable", scope: "project", scope_id: "demo", kind: "resolution",
        authority: "evidence_backed", content: JSON.stringify(experience) });
      const search = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo" }), "memory_search");
      const input = { task_description: "async callback timed out", error_text: "ERR_STREAM_WRITE_AFTER_END",
        file_paths: ["src/response.ts"], version: "v0.2.13", token_budget: 4000 };
      expect(validateArgs(search, input)).toEqual(input);
      const result = await search.execute("candidates", input, undefined, undefined, {} as never);
      const candidates = (result.details as { items: Array<{ id: string; revision: number; content_fingerprint: string }> }).items;
      expect(candidates).toHaveLength(1);
      const { id, revision, content_fingerprint } = candidates[0];
      const choice = { id, revision, content_fingerprint, reason: "相同异步超时回调条件，v0.2.13，复核后适用" };
      const selected = await search.execute("select", { ...input, selection: [choice] }, undefined, undefined, {} as never);
      expect((selected.details as { items: unknown[] }).items).toMatchObject([{ id, revision: 1, selection_stage: "pi_selected",
        selection_reason: expect.stringContaining(choice.reason) }]);
      for (const selection of [[], [{ ...choice, id: "invented" }], [{ ...choice, revision: 2 }],
        [{ ...choice, content_fingerprint: "0".repeat(64) }]]) {
        expect(itemIds((await search.execute("reject", { ...input, selection }, undefined, undefined, {} as never)).details)).toEqual([]);
      }
      updatePiMemoryItem(fixture.db, item.id, { content: JSON.stringify({ ...experience, resolution: "先注销回调，再释放响应" }) });
      expect(itemIds((await search.execute("stale", { ...input, selection: [choice] }, undefined, undefined, {} as never)).details)).toEqual([]);
      updatePiMemoryItem(fixture.db, item.id, { disabled: 1 });
      expect(itemIds((await search.execute("disabled", input, undefined, undefined, {} as never)).details)).toEqual([]);
      deletePiMemoryItem(fixture.db, item.id);
      expect(itemIds((await search.execute("forgotten", input, undefined, undefined, {} as never)).details)).toEqual([]);
    } finally { await fixture.close(); }
  });

test("keeps query-only search, treats SQL metacharacters literally and rejects unbound scopes", async () => {
    const fixture = await openFixture();
    try {
      seedProjectPolicyFixture(fixture.db);
      const search = toolByName(createPiMemoryTools(fixture.db, { projectID: "demo", conversationID: "own" }), "memory_search");
      for (const query of ["%", "' OR 1=1 --", "irrelevant-needle"]) {
        expect(itemIds((await search.execute("literal", { query }, undefined, undefined, {} as never)).details)).toEqual([]);
      }
      for (const input of [{ scope: "project", scope_id: "other" }, { scope: "conversation", scope_id: "other" }, { scope: "issue", scope_id: "999" }]) {
        expect((await search.execute("scope", input, undefined, undefined, {} as never)).details).toMatchObject({ rejected: true });
      }
      const result = await search.execute("query-only", { query: "concise" }, undefined, undefined, {} as never);
      expect(itemIds(result.details)).toEqual(["global-user-preference"]);
      expect((result.details as { limits: { token_estimate: number } }).limits.token_estimate).toBeLessThanOrEqual(900);
      expect((await search.execute("empty-budget", { token_budget: 0 }, undefined, undefined, {} as never)).details).toMatchObject({ items: [] });
    } finally { await fixture.close(); }
  });
}
