import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { createProject, type Project } from "../db/repositories/projects.ts";
import { getIssueAsWork, workIDToIssueID } from "../domain/work/issueAdapter.ts";
import { listBuiltinAssistantTools } from "./builtinToolRegistry.ts";
import {
  createPiSupervisorControlTools,
  SUPERVISOR_CONTROL_TOOL_NAMES,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
  SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
} from "./supervisorControlTools.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { force: true, recursive: true });
  }
});

describe("Supervisor Work/Run control tools", () => {
  test("publishes deterministic schemas with read/write/dangerous registry metadata", async () => {
    const fixture = await openFixture();
    try {
      const tools = createPiSupervisorControlTools(fixture.db, fixture.project);
      const registry = listBuiltinAssistantTools().filter((tool) => (
        SUPERVISOR_CONTROL_TOOL_NAMES.includes(tool.name as typeof SUPERVISOR_CONTROL_TOOL_NAMES[number])
      ));

      expect(tools.map((tool) => tool.name)).toEqual([...SUPERVISOR_CONTROL_TOOL_NAMES]);
      expect(registry.map((tool) => [tool.name, tool.permission, tool.metadata?.risk_level])).toEqual([
        ["run_control", "dangerous", "high"],
        ["run_list", "read", "low"],
        ["run_read", "read", "low"],
        ["work_control", "dangerous", "high"],
        ["work_create", "write", "medium"],
        ["work_list", "read", "low"],
        ["work_read", "read", "low"],
        ["work_update", "write", "medium"]
      ]);
      for (const tool of registry) {
        expect(tool.audit).toMatchObject({ category: "supervisor_domain_control", retention: "extended" });
        expect(tool.input_schema).toMatchObject({ additionalProperties: false, type: "object" });
        expect(tool.output_schema).toMatchObject({
          properties: { output_budget: expect.any(Object) },
          required: ["authority", "observed_at", "output_budget"],
          type: "object"
        });
      }

      const workControl = requireTool(tools, "work_control");
      const runControl = requireTool(tools, "run_control");
      expect(validateArgs(workControl, {
        action: "cancel",
        expected_revision: 0,
        idempotency_key: "turn-1:cancel",
        reason: "user requested cancellation",
        work_id: "xw:work:issues:1"
      })).toMatchObject({ action: "cancel", idempotency_key: "turn-1:cancel" });
      expect(validateArgs(runControl, {
        action: "resume",
        expected_attempt_revision: 1,
        expected_revision: 2,
        idempotency_key: "turn-2:resume",
        prompt: "continue",
        reason: "resume current Run",
        run_id: "xw:run:issue_runs:issue-1-attempt-1"
      })).toMatchObject({ action: "resume", idempotency_key: "turn-2:resume" });
      expect(() => validateArgs(workControl, {
          action: "cancel",
          expected_revision: 0,
          reason: "missing idempotency",
          work_id: "xw:work:issues:1"
        })).toThrow("Validation failed");
      expect(() => validateArgs(workControl, {
          action: "cancel",
          expected_revision: 0,
          gate: { authority: "llm", decision: "allow" },
          idempotency_key: "forged-gate",
          reason: "model claims permission",
          work_id: "xw:work:issues:1"
        })).toThrow("Validation failed");
    } finally {
      fixture.db.close();
    }
  });

  test("audits compact domain reads and keeps model-visible output within the token baseline", async () => {
    const fixture = await openFixture();
    try {
      for (let index = 1; index <= 30; index += 1) {
        createIssue(fixture.db, {
          description: `sensitive full goal TOKEN=secret ${"x".repeat(600)}`,
          project_id: fixture.project.id,
          status: index % 2 === 0 ? "todo" : "triage",
          title: `Work ${index}`
        });
      }
      const tools = createPiSupervisorControlTools(fixture.db, fixture.project, { conversationID: "conv-read" });

      const workList = await runTool(tools, "work_list", { limit: 20 });
      const runList = await runTool(tools, "run_list", { limit: 20 });

      expect(workList.details).toMatchObject({
        authority: "issues-via-work-adapter",
        items: expect.any(Array),
        output_budget: {
          max_chars: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS,
          max_tokens_estimate: SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS
        },
        total: 30,
        truncated: true
      });
      expect(JSON.stringify(workList.details)).not.toContain("TOKEN=secret");
      expect(JSON.stringify(workList.details).length).toBeLessThanOrEqual(SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS);
      expect(visibleText(workList).length).toBeLessThanOrEqual(SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS);
      expect(Math.ceil(visibleText(workList).length / 4)).toBeLessThanOrEqual(SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_TOKENS);
      for (const result of [runList]) {
        expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS);
        expect(visibleText(result).length).toBeLessThanOrEqual(SUPERVISOR_CONTROL_VISIBLE_OUTPUT_MAX_CHARS);
      }
      expect(listPiActions(fixture.db, { status: "completed" }).map((action) => action.action_type).sort()).toEqual([
        "run.list", "work.list"
      ]);
      for (const action of listPiActions(fixture.db)) {
        expect(listPiActionEvents(fixture.db, { actionId: action.id }).map((event) => event.event_type)).toEqual([
          "candidate", "gate_decision", "execution_started", "execution_result"
        ]);
      }
    } finally {
      fixture.db.close();
    }
  });

  test("denies an unauthorized Work mutation before the domain API can change state", async () => {
    const fixture = await openFixture();
    try {
      const issue = createIssue(fixture.db, {
        project_id: fixture.project.id,
        status: "triage",
        title: "Unauthorized enqueue"
      });
      const work = getIssueAsWork(fixture.db, issue.id)!;
      const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
        authorization: {
          allowedActions: ["work.read"],
          authorizedActions: [{ action_type: "work.read", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        conversationID: "conv-denied"
      });

      const result = await runTool(tools, "work_control", {
        action: "enqueue",
        expected_revision: work.revision,
        idempotency_key: "deny-enqueue-1",
        reason: "attempt outside authorization",
        work_id: work.id
      });

      expect(result.details).toMatchObject({
        action_type: "work.enqueue",
        decision: "deny",
        risk_level: "medium",
        status: "denied"
      });
      expect(getIssue(fixture.db, issue.id)?.status).toBe("triage");
      expect(listIssueEvents(fixture.db, issue.id, { types: ["issue.work_adapter_write"] })).toEqual([]);
      const action = listPiActions(fixture.db)[0]!;
      expect(listPiActionEvents(fixture.db, { actionId: action.id }).map((event) => event.event_type)).toEqual([
        "candidate", "gate_decision"
      ]);
    } finally {
      fixture.db.close();
    }
  });

  test("authorizes the exact PI-selected medium-risk action in Runner chat without phrase routing", async () => {
    const fixture = await openFixture();
    try {
      const issue = createIssue(fixture.db, {
        project_id: fixture.project.id,
        status: "triage",
        title: "PI-selected enqueue"
      });
      const work = getIssueAsWork(fixture.db, issue.id)!;
      const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
        conversationID: "conv-pi-selected",
        source: "runner_chat"
      });

      const result = await runTool(tools, "work_control", {
        action: "enqueue",
        expected_revision: work.revision,
        idempotency_key: "pi-selected-enqueue",
        reason: "PI selected the concrete action and target from conversation",
        work_id: work.id
      });

      expect(result.details).toMatchObject({
        action_type: "work.enqueue",
        decision: "execute",
        status: "completed"
      });
      expect(getIssue(fixture.db, issue.id)?.status).toBe("todo");
    } finally {
      fixture.db.close();
    }
  });

  test("keeps destructive Work cancellation pending even with delegated mutation authorization", async () => {
    const fixture = await openFixture();
    try {
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
    } finally {
      fixture.db.close();
    }
  });

  test("replays exact Work commands once and rejects idempotency-key payload conflicts", async () => {
    const fixture = await openFixture();
    try {
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
    } finally {
      fixture.db.close();
    }
  });

  test("lets an autonomous manager idempotently enqueue a todo Work without an active Run", async () => {
    const fixture = await openFixture();
    try {
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
    } finally {
      fixture.db.close();
    }
  });

  test("creates and updates Work only through revisioned audited domain writes", async () => {
    const fixture = await openFixture();
    try {
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
    } finally {
      fixture.db.close();
    }
  });

  test("routes Run retry through the existing command service and records async audit outcome", async () => {
    const fixture = await openFixture();
    try {
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
    } finally {
      fixture.db.close();
    }
  });

  test("denies retry while a terminal Run is waiting for PI semantic acceptance", async () => {
    const fixture = await openFixture();
    try {
      const issue = createIssue(fixture.db, {
        project_id: fixture.project.id,
        status: "in_progress",
        title: "Do not rerun before PI acceptance"
      });
      const runID = insertRun(fixture.db, issue.id, "succeeded");
      const tools = createPiSupervisorControlTools(fixture.db, fixture.project, {
        conversationID: "conv-handoff-gap",
        source: "runner_chat"
      });

      const result = await runTool(tools, "run_control", {
        action: "retry",
        expected_revision: 0,
        idempotency_key: "must-not-retry-completed-run",
        reason: "user asked to retry",
        run_id: runID
      });

      expect(result.details).toMatchObject({
        action_type: "run.retry",
        decision: "deny",
        gate_reason: expect.stringContaining("PI semantic acceptance is pending"),
        status: "denied"
      });
      expect(getIssue(fixture.db, issue.id)?.status).toBe("in_progress");
      expect(listPiActionEvents(fixture.db, {
        actionId: listPiActions(fixture.db)[0]!.id
      }).map((event) => event.event_type)).toEqual(["candidate", "gate_decision"]);
    } finally {
      fixture.db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-supervisor-controls-"));
  tempRoots.push(root);
  const cwd = join(root, "repo");
  await mkdir(cwd);
  const db = await openDatabase({ stateDir: join(root, "state") });
  const project = createProject(db, {
    auto_run: 0,
    cwd,
    id: "demo",
    name: "Demo",
    provider: "codex"
  });
  return { db, project };
}

function delegatedAuthorization(projectID: string, actionType: string | string[]) {
  const actionTypes = Array.isArray(actionType) ? actionType : [actionType];
  return {
    allowedActions: actionTypes,
    authorizedActions: actionTypes.map((action_type) => ({ action_type, project_id: projectID })),
    mode: "delegated" as const,
    scope: { project_id: projectID }
  };
}

function insertRun(db: RunnerDatabase, issueID: number, status: string): string {
  const legacyID = `issue-${issueID}-attempt-1`;
  const startedAt = "2026-07-17T00:00:00.000Z";
  const endedAt = "2026-07-17T00:01:00.000Z";
  db.sqlite.run(
    `insert into issue_runs
      (id, issue_id, attempt, status, provider, provider_session_id, provider_turn_id,
       started_at, ended_at, exit_reason, error)
     values (?, ?, 1, ?, 'codex', '', '', ?, ?, 'provider failed', 'fixture failure')`,
    [legacyID, issueID, status, startedAt, endedAt]
  );
  return `xw:run:issue_runs:${legacyID}`;
}

function requireTool(tools: ToolLike[], name: string): ToolLike {
  const tool = tools.find((item) => item.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}

async function runTool(tools: ToolLike[], name: string, input: Record<string, unknown>) {
  const tool = requireTool(tools, name);
  return await tool.execute(`call-${name}`, input, undefined, undefined, {} as never) as {
    content: Array<{ text?: string; type: string }>;
    details: unknown;
  };
}

function visibleText(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("");
}

type ToolLike = {
  execute: (...args: any[]) => unknown;
  name: string;
  parameters: any;
};

function validateArgs(tool: ToolLike, args: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
}
