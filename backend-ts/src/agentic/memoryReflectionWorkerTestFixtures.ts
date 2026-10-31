import { afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { recordIssueEvent } from "../db/repositories/issueEvents.ts";

import { seedMemoryExperience } from "../pi/memory/memoryExperienceTestFixtures.ts";
import { createMemoryReflectionTools } from "../pi/memory/memoryReflectionTools.ts";
import {
  claimMemoryReflection,
  reconcileMemoryReflectionEvents,
  setMemoryReflectionEnabled,
  type MemoryReflection
} from "../pi/memory/memoryReflectionQueue.ts";

import { useFauxPi } from "../testing/fauxPi.ts";

export const roots: string[] = [];

export const databases: RunnerDatabase[] = [];

export const fauxPi = useFauxPi();

afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

export async function fixture(enabled = true, status = "done") {
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

export function rows(db: RunnerDatabase) { return db.sqlite.query<MemoryReflection, []>("select * from pi_memory_reflections order by created_at").all(); }

export async function invoke(tools: ReturnType<typeof createMemoryReflectionTools>, name: string, params = {}) {
  return tools.find(tool => tool.name === name)!.execute("test", params, undefined, undefined, {} as never);
}

export const skip = async () => JSON.stringify({ status: "skipped", reason: "no_new_reusable_experience" });

export function claimTools(db: RunnerDatabase) {
  reconcileMemoryReflectionEvents(db);
  const row = claimMemoryReflection(db)!;
  return createMemoryReflectionTools(db, { id: row.id, token: row.lease_token });
}
