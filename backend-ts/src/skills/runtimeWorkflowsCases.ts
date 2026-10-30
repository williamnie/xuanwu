import { expect, test } from "bun:test";

import { listPiActionEvents } from "../db/repositories/pi.ts";

import { executeSkillRuntime, type SkillRuntimeHandler } from "./runtime.ts";

import {
  openFixture,
  fixtureSkill,
  workflowStage,
  expectRuntimeError,
  completedPayload
} from "./runtimeTestFixtures.ts";

export function registerRuntimeWorkflowsCases() {
  test("times out a handler and closes its capability sandbox", async () => {
    const db = await openFixture();
    const handler: SkillRuntimeHandler = async (_input, context) => {
      await Bun.sleep(30);
      await context.invokeTool("project_status");
      return { action_proposals: [] };
    };
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
  });

  test("intersects skill grants with the frozen workflow stage", async () => {
    const db = await openFixture();
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
  });
}
