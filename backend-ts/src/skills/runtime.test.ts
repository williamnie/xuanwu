import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun } from "../db/repositories/intakeRuns.ts";
import { listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { resolvePiActionDecision } from "../http/piActionDecision.ts";
import { runDomainSkillAndMarkProposal } from "../pi/domainSkillRun.ts";
import type { WorkflowStage } from "../workflows/manifest.ts";
import { DEFAULT_DOMAIN_SKILL_ID } from "./builtinDomainProposal.ts";
import type { SkillMetadata } from "./registry.ts";
import {
  executeSkillRuntime,
  SKILL_RUNTIME_COMPLETED_EVENT,
  SkillRuntimeError,
  type SkillRuntimeHandler
} from "./runtime.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("controlled skill runtime", () => {
  test("runs the real built-in domain skill with schema, evidence, and run audit", async () => {
    const db = await openFixture();
    try {
      const item = seedInboxItem(db, "status_question");
      const result = await runDomainSkillAndMarkProposal(db, item);
      const payload = JSON.parse(result.action.payload_json) as Record<string, any>;
      const events = listPiActionEvents(db, { actionId: result.action.id });

      expect(result.output).toMatchObject({
        item_id: item.id,
        skill_id: DEFAULT_DOMAIN_SKILL_ID
      });
      expect(result.output.action_proposals.map((action) => action.type)).toEqual([
        "issue.status_lookup",
        "message.reply_draft"
      ]);
      expect(result.output.action_proposals.every((action) =>
        action.evidence_refs.every((ref) => item.evidence_refs.includes(ref)))).toBe(true);
      expect(result.runtime).toMatchObject({
        handler: "builtin:pi-domain-proposal",
        sandbox: "capability",
        skill_id: DEFAULT_DOMAIN_SKILL_ID,
        status: "succeeded"
      });
      expect(payload.skill_runtime).toMatchObject({ skill_id: DEFAULT_DOMAIN_SKILL_ID, status: "succeeded" });
      expect(result.action.id).not.toContain("fixture-domain");
      expect(events.map((event) => event.event_type)).toEqual([
        "skill_runtime.started",
        "skill_runtime.completed"
      ]);
      expect(JSON.parse(events.at(-1)?.payload_json ?? "{}")).toMatchObject({
        evidence_validation: "passed",
        input_validation: "passed",
        kind: "domain",
        output_validation: "passed",
        status: "succeeded"
      });
    } finally {
      db.close();
    }
  });

  test("isolates invalid input and invalid output before persistence", async () => {
    const db = await openFixture();
    try {
      let called = false;
      await expectRuntimeError(executeSkillRuntime({
        db,
        handlers: { "test:input": () => { called = true; return {}; } },
        input: {},
        runID: "skill-run-bad-input",
        skill: fixtureSkill("bad-input", "test:input", {
          input_schema: { properties: { inbox_item: { type: "object" } }, required: ["inbox_item"], type: "object" }
        })
      }), "input_schema_invalid");
      expect(called).toBe(false);

      await expectRuntimeError(executeSkillRuntime({
        db,
        handlers: { "test:output": () => ({ action_proposals: "not-an-array" }) },
        input: { inbox_item: { evidence_refs: ["external_event:1"] } },
        runID: "skill-run-bad-output",
        skill: fixtureSkill("bad-output", "test:output", {
          output_schema: {
            properties: { action_proposals: { type: "array" } },
            required: ["action_proposals"],
            type: "object"
          }
        })
      }), "output_schema_invalid");

      await expectRuntimeError(executeSkillRuntime({
        db,
        handlers: { "test:evidence": () => ({
          action_proposals: [{ evidence_refs: ["external_event:forged"] }]
        }) },
        input: { inbox_item: { evidence_refs: ["external_event:1"] } },
        runID: "skill-run-bad-evidence",
        skill: fixtureSkill("bad-evidence", "test:evidence")
      }), "evidence_out_of_scope");

      expect(listPiActions(db)).toEqual([]);
      expect(completedPayload(db, "skill-run-bad-input")).toMatchObject({
        error_code: "input_schema_invalid",
        status: "failed"
      });
      expect(completedPayload(db, "skill-run-bad-output")).toMatchObject({
        error_code: "output_schema_invalid",
        status: "failed"
      });
      expect(completedPayload(db, "skill-run-bad-evidence")).toMatchObject({
        error_code: "evidence_out_of_scope",
        status: "failed"
      });
    } finally {
      db.close();
    }
  });

  test("routes granted write tools into the governed pending Action chain", async () => {
    const db = await openFixture();
    const handler: SkillRuntimeHandler = async (_input, context) => {
      await context.invokeTool("issue_create_proposal", { project_id: "demo", title: "must not write" });
      return { action_proposals: [] };
    };
    try {
      const result = await executeSkillRuntime({
        auditContext: { conversationID: "skill-permission-test" },
        db,
        handlers: { "test:write": handler },
        input: { inbox_item: { evidence_refs: ["external_event:1"] } },
        runID: "skill-run-write-denied",
        skill: fixtureSkill("write-denied", "test:write", {
          permissions: { max_tool_permission: "write" },
          required_tools: ["issue_create_proposal"]
        })
      });

      expect(result.run.status).toBe("succeeded");
      expect(listPiActions(db)).toEqual([
        expect.objectContaining({ action_type: "issue.create", gate_decision: "ask", status: "pending" })
      ]);
      expect(listPiActionEvents(db, { conversationId: "skill-permission-test" }).map((event) => event.event_type))
        .toEqual(expect.arrayContaining(["candidate", "gate_decision", "pending_approval"]));
      expect(completedPayload(db, "skill-run-write-denied")).toMatchObject({
        status: "succeeded"
      });
    } finally {
      db.close();
    }
  });

  test("executes a granted CLI write tool only after the pending Action is approved", async () => {
    const db = await openFixture();
    const connector = await writeCliWriteFixture();
    seedProject(db, "skill-write-project", connector.root);
    const handler: SkillRuntimeHandler = async (_input, context) => ({
      action_proposals: [],
      invocation: await context.invokeTool("skill-write-cli:write-marker", {
        marker: connector.marker,
        value: "approved"
      })
    });
    try {
      const result = await executeSkillRuntime<Record<string, unknown>>({
        auditContext: { conversationID: "skill-cli-write", projectID: "skill-write-project" },
        cliConnectorDirs: [connector.dir],
        db,
        handlers: { "test:cli-write": handler },
        input: { inbox_item: { evidence_refs: ["external_event:1"] } },
        runID: "skill-run-cli-write",
        skill: fixtureSkill("cli-write", "test:cli-write", {
          permissions: { max_tool_permission: "write" },
          required_tools: ["skill-write-cli:write-marker"]
        })
      });

      const [pending] = listPiActions(db, { status: "pending" });
      expect(result.output).toMatchObject({ invocation: { decision: "ask", status: "pending" } });
      expect(pending).toMatchObject({ action_type: "assistant.tool.call", gate_decision: "ask" });
      expect(await Bun.file(connector.marker).exists()).toBe(false);

      const completed = await resolvePiActionDecision({ database: db }, {
        actionID: pending.id,
        actor: "test:user",
        decision: "approve"
      });
      expect(completed.status).toBe("completed");
      expect(await Bun.file(connector.marker).text()).toBe("approved");
      expect(JSON.parse(completed.result_json)).toMatchObject({
        output: { marker: connector.marker, value: "approved" },
        status: "succeeded"
      });
    } finally {
      db.close();
    }
  });

  test("invokes a granted read tool through the shared audited gateway", async () => {
    const db = await openFixture();
    const handler: SkillRuntimeHandler = async (_input, context) => ({
      action_proposals: [],
      projects: await context.invokeTool("project_status")
    });
    try {
      const result = await executeSkillRuntime<Record<string, unknown>>({
        auditContext: { conversationID: "skill-read-test" },
        db,
        handlers: { "test:read": handler },
        input: { inbox_item: { evidence_refs: ["external_event:1"] } },
        runID: "skill-run-read",
        skill: fixtureSkill("read", "test:read", { required_tools: ["project_status"] })
      });

      expect(result.output).toMatchObject({ projects: { items: [] } });
      const audit = listPiActionEvents(db, { conversationId: "skill-read-test" })
        .find((event) => event.event_type === "tool_call_audit");
      expect(JSON.parse(audit?.payload_json ?? "{}")).toMatchObject({
        provider_id: "runner-builtin",
        status: "succeeded",
        tool: "project_status"
      });
    } finally {
      db.close();
    }
  });

  test("times out a handler and closes its capability sandbox", async () => {
    const db = await openFixture();
    const handler: SkillRuntimeHandler = async (_input, context) => {
      await Bun.sleep(30);
      await context.invokeTool("project_status");
      return { action_proposals: [] };
    };
    try {
      await expectRuntimeError(executeSkillRuntime({
        auditContext: { conversationID: "skill-timeout-test" },
        db,
        handlers: { "test:slow": handler },
        input: { inbox_item: { evidence_refs: ["external_event:1"] } },
        runID: "skill-run-timeout",
        skill: fixtureSkill("slow", "test:slow", {
          execution: { adapter: "builtin", handler: "test:slow", sandbox: "capability", timeout_ms: 5 },
          required_tools: ["project_status"]
        })
      }), "skill_timeout");
      await Bun.sleep(40);

      expect(completedPayload(db, "skill-run-timeout")).toMatchObject({
        error_code: "skill_timeout",
        status: "timeout"
      });
      expect(listPiActionEvents(db, { conversationId: "skill-timeout-test" })
        .filter((event) => event.event_type === "tool_call_audit")).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("intersects skill grants with the frozen workflow stage", async () => {
    const db = await openFixture();
    try {
      const skill = fixtureSkill("workflow-bound", "test:workflow", { required_tools: ["project_status"] });
      await expectRuntimeError(executeSkillRuntime({
        db,
        handlers: { "test:workflow": () => ({ action_proposals: [] }) },
        input: { inbox_item: { evidence_refs: ["external_event:1"] } },
        runID: "skill-run-workflow-denied",
        skill,
        workflow: { manifest_ref: "workflow:test@1", stage: workflowStage(skill.id, []) }
      }), "workflow_tool_denied");
      expect(completedPayload(db, "skill-run-workflow-denied")).toMatchObject({
        error_code: "workflow_tool_denied",
        workflow_ref: "workflow:test@1",
        workflow_stage_id: "execute"
      });
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-skill-runtime-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

async function writeCliWriteFixture(): Promise<{ dir: string; marker: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-skill-write-"));
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

function seedProject(db: RunnerDatabase, id: string, cwd: string): void {
  const now = "2026-07-27T00:00:00.000Z";
  db.sqlite.run(
    `insert into projects (id, name, cwd, provider, created_at, updated_at) values (?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, "codex", now, now]
  );
}

function seedInboxItem(db: RunnerDatabase, primaryIntent: string) {
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

function fixtureSkill(
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

function workflowStage(skillID: string, allowedTools: string[]): WorkflowStage {
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

async function expectRuntimeError(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`expected SkillRuntimeError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SkillRuntimeError);
    expect((error as SkillRuntimeError).code).toBe(code);
  }
}

function completedPayload(db: RunnerDatabase, runID: string): Record<string, any> {
  const event = listPiActionEvents(db, { actionId: runID, eventType: SKILL_RUNTIME_COMPLETED_EVENT }).at(-1);
  return JSON.parse(event?.payload_json ?? "{}") as Record<string, any>;
}
