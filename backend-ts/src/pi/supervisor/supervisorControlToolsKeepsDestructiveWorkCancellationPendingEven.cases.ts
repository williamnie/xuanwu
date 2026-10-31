import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { getIssue } from "../../db/repositories/issues.ts";
import { listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { createProject, type Project } from "../../db/repositories/projects.ts";
import { getIssueAsWork, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import { listBuiltinAssistantTools } from "../tools/builtinToolRegistry.ts";
import {
  createPiSupervisorControlTools,
  SUPERVISOR_CONTROL_TOOL_NAMES,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
} from "./supervisorControlTools.ts";
import { useDatabaseCleanup } from "../../testing/harness.ts";

import { trackDatabase, tempRoots, openFixture, delegatedAuthorization, insertRun, requireTool, runTool, visibleText, ToolLike, validateArgs } from "./supervisorControlToolsTestFixtures.ts";

export function registerKeepsDestructiveWorkCancellationPendingEven() {
test("keeps destructive Work cancellation pending even with delegated mutation authorization", async () => {
    const fixture = await openFixture();
    const issue = createIssue(fixture.db, {
      project_id: fixture.project.id,
      status: "todo",
      title: "Protected cancellation"
    });
    const work = getIssueAsWork(fixture.db, issue.id)!;
    const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
      authorization: delegatedAuthorization(fixture.project.id, "work.cancel"),
      conversationID: "conv-cancel-pending"
    });

    const result = await runTool(tools, "work_control", {
      action: "cancel",
      expected_revision: work.revision,
      idempotency_key: "cancel-needs-approval",
      reason: "cancel this Work",
      work_id: work.id
    });

    expect(result.details).toMatchObject({
      action_type: "work.cancel",
      decision: "ask",
      risk_level: "high",
      status: "pending"
    });
    expect(getIssue(fixture.db, issue.id)?.status).toBe("todo");
    expect(listIssueEvents(fixture.db, issue.id, { types: ["issue.work_adapter_write"] })).toEqual([]);
    const action = listPiActions(fixture.db)[0]!;
    expect(listPiActionEvents(fixture.db, { actionId: action.id }).map((event) => event.event_type)).toEqual([
      "candidate", "gate_decision", "pending_approval"
    ]);
  });

test("replays exact Work commands once and rejects idempotency-key payload conflicts", async () => {
    const fixture = await openFixture();
    const issue = createIssue(fixture.db, {
      project_id: fixture.project.id,
      status: "triage",
      title: "Idempotent enqueue"
    });
    const work = getIssueAsWork(fixture.db, issue.id)!;
    const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
      authorization: delegatedAuthorization(fixture.project.id, "work.enqueue"),
      conversationID: "conv-idempotent"
    });
    const input = {
      action: "enqueue",
      expected_revision: work.revision,
      idempotency_key: "enqueue-work-once",
      reason: "start this Work",
      work_id: work.id
    };

    const first = await runTool(tools, "work_control", input);
    const replay = await runTool(tools, "work_control", input);

    expect(first.details).toMatchObject({
      action_id: expect.any(String),
      action_type: "work.enqueue",
      decision: "execute",
      result: { mutation: { applied: true }, work: { status: "todo" } },
      status: "completed"
    });
    expect(replay.details).toMatchObject({ action_id: (first.details as any).action_id, status: "completed" });
    expect(getIssue(fixture.db, issue.id)?.status).toBe("todo");
    expect(listPiActions(fixture.db)).toHaveLength(1);
    expect(listIssueEvents(fixture.db, issue.id, { types: ["issue.work_adapter_write"] })).toHaveLength(1);
    await expect(runTool(tools, "work_control", { ...input, reason: "different payload" }))
      .rejects.toThrow("idempotency_key conflicts");
  });

test("lets an autonomous manager idempotently enqueue a todo Work without an active Run", async () => {
    const fixture = await openFixture();
    const issue = createIssue(fixture.db, {
      project_id: fixture.project.id,
      status: "todo",
      title: "Queued without active Run"
    });
    const work = getIssueAsWork(fixture.db, issue.id)!;
    const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
      authorization: delegatedAuthorization(fixture.project.id, "work.enqueue"),
      conversationID: "conv-idempotent-todo-enqueue"
    });

    const result = await runTool(tools, "work_control", {
      action: "enqueue",
      expected_revision: work.revision,
      idempotency_key: "enqueue-existing-todo",
      reason: "wake the queued Work",
      work_id: work.id
    });

    expect(result.details).toMatchObject({
      action_type: "work.enqueue",
      decision: "execute",
      result: { mutation: { applied: true }, work: { status: "todo" } },
      status: "completed"
    });
    expect(listIssueEvents(fixture.db, issue.id, { types: ["issue.work_adapter_write"] }))
      .toHaveLength(1);
  });

test("creates and updates Work only through revisioned audited domain writes", async () => {
    const fixture = await openFixture();
    const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
      authorization: delegatedAuthorization(fixture.project.id, ["work.create", "work.update"]),
      conversationID: "conv-create-update"
    });

    const created = await runTool(tools, "work_create", {
      goal: "Deliver deterministic Supervisor controls",
      idempotency_key: "create-work-once",
      reason: "create requested Work",
      status: "triage",
      title: "Supervisor controls"
    });
    const createdWork = (created.details as any).result.work;
    expect(created.details).toMatchObject({
      action_type: "work.create",
      decision: "execute",
      result: { mutation: { applied: true }, work: { project_id: fixture.project.id, status: "triage" } },
      status: "completed"
    });

    const updated = await runTool(tools, "work_update", {
      expected_revision: createdWork.revision,
      goal: "Deliver audited deterministic Supervisor controls",
      idempotency_key: "update-work-once",
      reason: "clarify acceptance goal",
      title: "Audited Supervisor controls",
      work_id: createdWork.id
    });

    expect(updated.details).toMatchObject({
      action_type: "work.update",
      decision: "execute",
      result: {
        mutation: { applied: true },
        work: { goal: "Deliver audited deterministic Supervisor controls", title: "Audited Supervisor controls" }
      },
      status: "completed"
    });
    expect(listPiActions(fixture.db)).toHaveLength(2);
    expect(listIssueEvents(fixture.db, workIDToIssueID(createdWork.id), {
      types: ["issue.work_adapter_write"]
    })).toHaveLength(1);
  });

test("routes Run retry through the existing command service and records async audit outcome", async () => {
    const fixture = await openFixture();
    const issue = createIssue(fixture.db, {
      project_id: fixture.project.id,
      status: "failed",
      title: "Retry Run"
    });
    const runID = insertRun(fixture.db, issue.id, "failed");
    const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
      authorization: delegatedAuthorization(fixture.project.id, "run.retry"),
      conversationID: "conv-run-retry"
    });

    const result = await runTool(tools, "run_control", {
      action: "retry",
      expected_revision: 0,
      idempotency_key: "retry-run-once",
      reason: "retry failed Run",
      run_id: runID
    });

    expect(result.details).toMatchObject({
      action_type: "run.retry",
      decision: "execute",
      result: {
        mutation: { action: "retry", applied: true, operation: "retry", requested_sequence: 2 },
        run: { id: runID, revision: 1 }
      },
      status: "completed"
    });
    expect(getIssue(fixture.db, issue.id)?.status).toBe("todo");
    const action = listPiActions(fixture.db)[0]!;
    expect(action.result_json).toContain("requested_sequence");
    expect(listPiActionEvents(fixture.db, { actionId: action.id }).map((event) => event.event_type)).toEqual([
      "candidate", "gate_decision", "execution_started", "execution_result"
    ]);
  });
}
