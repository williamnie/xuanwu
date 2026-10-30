import { expect, test } from "bun:test";

import { listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { resolvePiActionDecision } from "../http/pi/piActionDecision.ts";
import { runDomainSkillAndMarkProposal } from "../pi/tools/domainSkillRun.ts";

import { DEFAULT_DOMAIN_SKILL_ID } from "./builtinDomainProposal.ts";

import { executeSkillRuntime, type SkillRuntimeHandler } from "./runtime.ts";

import {
  openFixture,
  writeCliWriteFixture,
  seedProject,
  seedInboxItem,
  fixtureSkill,
  expectRuntimeError,
  completedPayload
} from "./runtimeTestFixtures.ts";

export function registerRuntimeRuntimeCases() {
  test("runs the real built-in domain skill with schema, evidence, and run audit", async () => {
    const db = await openFixture();
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
  });

  test("isolates invalid input and invalid output before persistence", async () => {
    const db = await openFixture();
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
  });

  test("routes granted write tools into the governed pending Action chain", async () => {
    const db = await openFixture();
    const handler: SkillRuntimeHandler = async (_input, context) => {
      await context.invokeTool("issue_create_proposal", { project_id: "demo", title: "must not write" });
      return { action_proposals: [] };
    };
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
  });

  test("invokes a granted read tool through the shared audited gateway", async () => {
    const db = await openFixture();
    const handler: SkillRuntimeHandler = async (_input, context) => ({
      action_proposals: [],
      projects: await context.invokeTool("project_status")
    });
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
  });
}
