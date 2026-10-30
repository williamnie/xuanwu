import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun } from "../db/repositories/intakeRuns.ts";
import { listPiActionEvents } from "../db/repositories/pi.ts";

import type { WorkflowStage } from "../workflows/manifest.ts";

import type { SkillMetadata } from "./registry.ts";
import { SKILL_RUNTIME_COMPLETED_EVENT, SkillRuntimeError } from "./runtime.ts";
import { useDatabaseCleanup } from "../testing/harness.ts";

export const trackDatabase = useDatabaseCleanup();

export const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

export async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-skill-runtime-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") }).then(trackDatabase);
}

export async function writeCliWriteFixture(): Promise<{ dir: string; marker: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-skill-write-"));
  tempRoots.push(root);
  const dir = join(root, "connectors");
  const marker = join(root, "approved.txt");
  const script = join(dir, "write-marker.mjs");
  await mkdir(dir, { recursive: true });
  await writeFile(script, `
import { writeFile } from "node:fs/promises";
const mode = process.argv[2];
if (mode === "health") console.log(JSON.stringify({ ok: true }));
else {
  await writeFile(process.argv[3], process.argv[4], "utf8");
  console.log(JSON.stringify({ marker: process.argv[3], value: process.argv[4] }));
}
`, "utf8");
  await writeFile(join(dir, "skill-write-cli.json"), JSON.stringify({
    commands: [{
      command: { args: [script, "write", "{{input.marker}}", "{{input.value}}"], executable: process.execPath },
      description: "Write a marker file for the governed Skill runtime test.",
      exit_codes: { success: [0] },
      input_schema: {
        properties: { marker: { type: "string" }, value: { type: "string" } },
        required: ["marker", "value"],
        type: "object"
      },
      name: "write-marker",
      output_schema: {
        properties: { marker: { type: "string" }, value: { type: "string" } },
        type: "object"
      },
      permission: "write",
      stdout: { mode: "json" }
    }],
    health: {
      command: { args: [script, "health"], executable: process.execPath },
      exit_codes: { success: [0] },
      stdout: { mode: "json" }
    },
    id: "skill-write-cli",
    kind: "cli",
    manifest_version: "pi-cli-connector.v0",
    name: "Skill Write CLI"
  }, null, 2), "utf8");
  return { dir, marker, root };
}

export function seedProject(db: RunnerDatabase, id: string, cwd: string): void {
  const now = "2026-07-27T00:00:00.000Z";
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, "codex", now, now]
  );
}

export function seedInboxItem(db: RunnerDatabase, primaryIntent: string) {
  const event = createExternalEvent(db, {
    actor: "tester",
    content: "请同步当前进展。",
    external_id: "skill-runtime-1",
    occurred_at: "2026-07-17T00:00:00Z",
    provider: "fixture",
    received_at: "2026-07-17T00:00:01Z",
    source: "runtime-test"
  });
  const bundle = createContextBundle(db, {
    context: [],
    created_by: "system",
    event_refs: [event.id],
    evidence_refs: [`external_event:${event.id}`],
    reason: "skill runtime smoke",
    source: "runtime-test",
    trigger: "manual",
    window: { from: event.occurred_at, to: event.occurred_at }
  });
  const intake = createIntakeRun(db, { bundle_id: bundle.id, skill_id: "pi-llm-intake", status: "succeeded" });
  return createAttentionInboxItem(db, {
    bundle_id: bundle.id,
    confidence: 0.95,
    evidence_refs: [`external_event:${event.id}`],
    intake_run_id: intake.id,
    primary_intent: primaryIntent,
    source: "runtime-test",
    suggested_actions: ["issue.status_lookup"],
    summary: "请同步当前进展。",
    target_hints: [],
    title: "当前进展"
  });
}

export function fixtureSkill(
  id: string,
  handler: string,
  overrides: Partial<SkillMetadata> = {}
): SkillMetadata {
  return {
    allowed_roles: ["executor"],
    description: `${id} runtime fixture`,
    execution: { adapter: "builtin", handler, sandbox: "capability", timeout_ms: 1000 },
    id,
    instruction_bytes: 32,
    instruction_sha256: "fixture-instruction-sha256",
    instructions: "# Fixture skill instructions",
    input_object: "inbox_item",
    input_schema: { type: "object" },
    intent_tags: [],
    kind: "domain",
    name: id,
    output_objects: ["action_proposals"],
    output_schema: { type: "object" },
    permissions: { max_tool_permission: "read" },
    primary_intents: ["other"],
    required_tools: [],
    risk_level: "low",
    runtime_manifest_path: `fixture:${id}/manifest.json`,
    source_path: `fixture:${id}/SKILL.md`,
    summary: `${id} runtime fixture`,
    trigger_rules: `Use ${id} in tests.`,
    version: "1.0.0",
    ...overrides
  };
}

export function workflowStage(skillID: string, allowedTools: string[]): WorkflowStage {
  return {
    agent: { required_skill_ids: [skillID], role: "executor" },
    approval: { mode: "none" },
    handoff: { mode: "local_changes", project_override_modes: ["local_changes"], required: true },
    id: "execute",
    name: "Execute",
    permissions: { allowed_actions: [], allowed_tools: allowedTools, max_tool_permission: "read" },
    retry: { backoff_seconds: [], max_attempts: 1 },
    verification_policy_ref: "verification-policy:test@1"
  };
}

export async function expectRuntimeError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected SkillRuntimeError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SkillRuntimeError);
    expect((error as SkillRuntimeError).code).toBe(code);
  }
}

export function completedPayload(db: RunnerDatabase, runID: string): Record<string, any> {
  const event = listPiActionEvents(db, { actionId: runID, eventType: SKILL_RUNTIME_COMPLETED_EVENT }).at(-1);
  return JSON.parse(event?.payload_json ?? "{}") as Record<string, any>;
}
