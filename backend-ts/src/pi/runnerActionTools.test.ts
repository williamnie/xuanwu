import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listAutomations } from "../db/repositories/automations.ts";
import type { AgentSession } from "../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns, listIssues } from "../db/repositories/issues.ts";
import { listIssueEvents } from "../db/repositories/issueEvents.ts";
import { createIssueRun } from "../db/repositories/issueRuns.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { getProject, type Project } from "../db/repositories/projects.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../domain/review/humanReview.ts";
import { createPiRunnerActions, type PiRunnerActionLayer } from "./runnerActions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "./runnerActionTools.ts";

describe("PI runner action tools", () => {
  test("defines schemas and delegates tool calls to the action layer", async () => {
    const calls: Array<[string, unknown]> = [];
    const tools = createPiRunnerActionTools(fakeActions(calls));
    const recommendProfile = toolByName(tools, "agent_profile_recommend");
    const verifier = toolByName(tools, "verification_workflow_request");
    const issueRead = toolByName(tools, "issue_read");
    const diagnose = toolByName(tools, "issue_state_diagnose");
    const schedule = toolByName(tools, "issue_schedule_enqueue");
    const steer = toolByName(tools, "session_steer_proposal");
    const repoSearch = toolByName(tools, "repo_search");
    const repoRead = toolByName(tools, "repo_read_excerpt");
    const repoTree = toolByName(tools, "repo_tree");
    const issueCreate = toolByName(tools, "issue_create_proposal");
    const issueBatchCreate = toolByName(tools, "issue_create_batch_proposal");
    const issueCancel = toolByName(tools, "issue_cancel");
    const issueDelete = toolByName(tools, "issue_delete");
    const issueStatusUpdate = toolByName(tools, "issue_status_update");
    const runnerSettingsRead = toolByName(tools, "runner_settings_read");
    const runnerSettingsUpdate = toolByName(tools, "runner_settings_update");
    const systemRestart = toolByName(tools, "system_restart");
    const repair = toolByName(tools, "issue_state_repair_proposal");
    const batchTriage = toolByName(tools, "issue_enqueue_batch_triage");
    const nextTriage = toolByName(tools, "issue_enqueue_next_triage");
    const issueList = toolByName(tools, "issue_list");
    const issueStatus = toolByName(tools, "issue_status_summary");
    const issueExecution = toolByName(tools, "issue_execution_status");
    const completionReconcile = toolByName(tools, "issue_acceptance_request");
    const humanReview = toolByName(tools, "human_review_request_create");
    const humanReviewResponse = toolByName(tools, "human_review_response");
    const watchCreate = toolByName(tools, "issue_completion_watch_create");
    const watchList = toolByName(tools, "issue_completion_watch_list");
    const watchCancel = toolByName(tools, "issue_completion_watch_cancel");

    expect(tools.map((tool) => tool.name).sort()).toEqual([...PI_RUNNER_ACTION_TOOL_NAMES].sort());
    expect(validateArgs(issueList, { limit: 3, status: "todo" })).toEqual({ limit: 3, status: "todo" });
    expect(validateArgs(issueRead, { id: 1 })).toEqual({ id: 1 });
    expect(validateArgs(issueStatus, { status: "todo" })).toEqual({ status: "todo" });
    expect(validateArgs(issueExecution, { id: 1 })).toEqual({ id: 1 });
    expect(validateArgs(issueCancel, { issue_ids: [812, 813, 814], rationale: "不再做" }))
      .toEqual({ issue_ids: [812, 813, 814], rationale: "不再做" });
    expect(validateArgs(issueDelete, { issue_ids: [812, 813], reason: "用户确认永久删除" }))
      .toEqual({ issue_ids: [812, 813], reason: "用户确认永久删除" });
    expect(validateArgs(issueStatusUpdate, {
      issue_ids: [812, 813, 814],
      reason: "用户要求重新排队",
      status: "todo"
    })).toEqual({ issue_ids: [812, 813, 814], reason: "用户要求重新排队", status: "todo" });
    expect(validateArgs(completionReconcile, { issue_id: 1, rationale: "补齐交付记录" }))
      .toEqual({ issue_id: 1, rationale: "补齐交付记录" });
    expect(validateArgs(humanReview, {
      acceptance_summary: ["Node/TypeScript/PostgreSQL", "OIDC"],
      evidence_refs: ["docs/architecture/0001.md"],
      excluded_scope: ["安装数据库"],
      issue_id: 815,
      kind: "decision",
      question: "是否接受这些技术和产品取舍？",
      recommendation: "接受"
    })).toEqual({
      acceptance_summary: ["Node/TypeScript/PostgreSQL", "OIDC"],
      evidence_refs: ["docs/architecture/0001.md"],
      excluded_scope: ["安装数据库"],
      issue_id: 815,
      kind: "decision",
      question: "是否接受这些技术和产品取舍？",
      recommendation: "接受"
    });
    expect(validateArgs(humanReviewResponse, {
      action: "accept",
      comment: "真实 smoke 后续由用户手动执行",
      issue_id: 827,
      review_request_id: "human-review-827",
      review_revision: 1
    })).toEqual({
      action: "accept",
      comment: "真实 smoke 后续由用户手动执行",
      issue_id: 827,
      review_request_id: "human-review-827",
      review_revision: 1
    });
    expect(validateArgs(watchCreate, {
      issue_ids: [7, 8],
      note: "提醒我",
      project_id: "demo",
      target_channel: "feishu",
      target_chat_id: "oc_group"
    })).toEqual({
      issue_ids: [7, 8],
      note: "提醒我",
      project_id: "demo",
      target_channel: "feishu",
      target_chat_id: "oc_group"
    });
    expect(validateArgs(watchList, { project_id: "demo", status: "active" })).toEqual({
      project_id: "demo",
      status: "active"
    });
    expect(validateArgs(watchCancel, { reason: "done", watch_id: "watch-1" })).toEqual({
      reason: "done",
      watch_id: "watch-1"
    });
    expect(validateArgs(batchTriage, { issue_ids: [387, 388], project_id: "demo", user_phrase: "把 #387-#388 都开始做" }))
      .toEqual({ issue_ids: [387, 388], project_id: "demo", user_phrase: "把 #387-#388 都开始做" });
    expect(validateArgs(nextTriage, { project_id: "demo" })).toEqual({ project_id: "demo" });
    expect(validateArgs(runnerSettingsRead, {})).toEqual({});
    expect(validateArgs(runnerSettingsUpdate, {
      codex_server_mode: "app",
      max_parallel_projects: 3,
      reason: "修改运行配置"
    })).toEqual({ codex_server_mode: "app", max_parallel_projects: 3, reason: "修改运行配置" });
    expect(validateArgs(systemRestart, { reason: "应用配置" })).toEqual({ reason: "应用配置" });
    expect(validateArgs(recommendProfile, { issue_id: 1, role: "executor" })).toEqual({ issue_id: 1, role: "executor" });
    expect(validateArgs(verifier, { target_issue_id: 1, instructions: "verify" })).toEqual({
      target_issue_id: 1,
      instructions: "verify"
    });
    expect(validateArgs(diagnose, { project_id: "demo" })).toEqual({ project_id: "demo" });
    expect(validateArgs(repair, { diagnosis_code: "done_missing_verification_evidence", issue_id: 1, operation: "patch_status" }))
      .toEqual({ diagnosis_code: "done_missing_verification_evidence", issue_id: 1, operation: "patch_status" });
    expect(validateArgs(schedule, { issue_id: 1, next_run_at: "2999-01-01T00:00:00.000Z" })).toEqual({
      issue_id: 1,
      next_run_at: "2999-01-01T00:00:00.000Z"
    });
    expect(validateArgs(repoSearch, { query: "Accordion", max_results: 3 })).toEqual({
      query: "Accordion",
      max_results: 3
    });
    expect(validateArgs(repoRead, { path: "src/App.tsx", start_line: 2, max_lines: 4 })).toEqual({
      path: "src/App.tsx",
      start_line: 2,
      max_lines: 4
    });
    expect(validateArgs(repoTree, { path: "src", max_depth: 2 })).toEqual({ path: "src", max_depth: 2 });
    expect(validateArgs(issueCreate, {
      context_pack: {
        evidence: [{ path: "src/App.tsx", source_kind: "code", summary: "owner" }],
        intent: "Add panel",
        project: { id: "demo" }
      },
      description: "Need repo context",
      evidence: [{ source_kind: "message", summary: "IM request" }],
      open_questions: ["默认展开吗？"],
      title: "Repo-aware issue"
    })).toMatchObject({
      context_pack: {
        evidence: [{ path: "src/App.tsx", source_kind: "code", summary: "owner" }],
        intent: "Add panel",
        project: { id: "demo" }
      },
      evidence: [{ source_kind: "message", summary: "IM request" }],
      open_questions: ["默认展开吗？"]
    });
    expect(validateArgs(issueBatchCreate, {
      project_id: "demo",
      items: [
        detailedBatchItem("foundation", "建立工程基线"),
        { ...detailedBatchItem("ui", "实现前端流程"), depends_on_refs: ["foundation"] }
      ]
    })).toMatchObject({
      items: [
        expect.objectContaining({ ref: "foundation" }),
        expect.objectContaining({ depends_on_refs: ["foundation"], ref: "ui" })
      ]
    });
    expect(() => validateArgs(issueBatchCreate, {
      items: [
        { ...detailedBatchItem("foundation", "建立工程基线"), evidence: [] },
        detailedBatchItem("ui", "实现前端流程")
      ]
    })).toThrow(/Validation failed/);
    expect(validateArgs(steer, { session_key: "codex:thread-1", prompt: "adjust" })).toEqual({
      session_key: "codex:thread-1",
      prompt: "adjust"
    });
    expect(() => validateArgs(issueRead, { id: "bad" })).toThrow(/Validation failed/);
    expect(() => validateArgs(issueRead, { id: 1, unexpected: true })).toThrow(/Validation failed/);
    expect(validateArgs(batchTriage, { user_phrase: "这些都开始" })).toEqual({ user_phrase: "这些都开始" });
    expect(() => validateArgs(batchTriage, { max_count: 3, user_phrase: "这些都开始" })).toThrow(/Validation failed/);
    expect(() => validateArgs(steer, { session_key: "codex:thread-1", prompt: " " })).toThrow(/Validation failed/);

    await recommendProfile.execute("tool-profile", { issue_id: 1, role: "executor" }, undefined, undefined, {} as never);
    await verifier.execute("tool-verifier", { target_issue_id: 1, instructions: "verify" }, undefined, undefined, {} as never);
    await issueList.execute("tool-list", { limit: 3, status: "todo" }, undefined, undefined, {} as never);
    await issueRead.execute("tool-1", { id: 7 }, undefined, undefined, {} as never);
    await issueCancel.execute("tool-cancel", {
      issue_ids: [812, 813, 814],
      rationale: "不再做"
    }, undefined, undefined, {} as never);
    await issueStatusUpdate.execute("tool-status-update", {
      issue_ids: [812, 813, 814],
      reason: "用户要求重新排队",
      status: "todo"
    }, undefined, undefined, {} as never);
    await issueBatchCreate.execute("tool-batch-create", {
      items: [detailedBatchItem("foundation", "建立工程基线"), detailedBatchItem("ui", "实现前端流程")]
    }, undefined, undefined, {} as never);
    await issueStatus.execute("tool-status", { status: "todo" }, undefined, undefined, {} as never);
    await issueExecution.execute("tool-execution", { id: 7 }, undefined, undefined, {} as never);
    await watchCreate.execute("tool-watch-create", {
      issue_ids: [7, 8],
      note: "提醒我",
      project_id: "demo",
      target_channel: "feishu"
    }, undefined, undefined, {} as never);
    await watchList.execute("tool-watch-list", { project_id: "demo", status: "active" }, undefined, undefined, {} as never);
    await watchCancel.execute("tool-watch-cancel", { reason: "user_cancel", watch_id: "watch-1" }, undefined, undefined, {} as never);
    await batchTriage.execute("tool-batch-triage", {
      issue_ids: [387, 388],
      project_id: "demo",
      user_phrase: "把 #387-#388 都开始做"
    }, undefined, undefined, {} as never);
    await nextTriage.execute("tool-next-triage", { project_id: "demo" }, undefined, undefined, {} as never);
    await completionReconcile.execute("tool-completion-reconcile", {
      issue_id: 7,
      rationale: "补齐交付记录"
    }, undefined, undefined, {} as never);
    await humanReview.execute("tool-human-review", {
      acceptance_summary: ["Node/TypeScript/PostgreSQL", "OIDC"],
      evidence_refs: ["docs/architecture/0001.md"],
      excluded_scope: ["安装数据库"],
      issue_id: 815,
      kind: "decision",
      question: "是否接受这些技术和产品取舍？",
      recommendation: "接受"
    }, undefined, undefined, {} as never);
    await humanReviewResponse.execute("tool-human-review-response", {
      action: "accept",
      comment: "真实 smoke 后续由用户手动执行",
      issue_id: 827,
      review_request_id: "human-review-827",
      review_revision: 1
    }, undefined, undefined, {} as never);
    await diagnose.execute("tool-diagnose", { project_id: "demo" }, undefined, undefined, {} as never);
    await repair.execute("tool-repair", {
      diagnosis_code: "done_missing_verification_evidence",
      issue_id: 1,
      operation: "patch_status"
    }, undefined, undefined, {} as never);
    await repoSearch.execute("tool-repo-search", { query: "Accordion", max_results: 3 }, undefined, undefined, {} as never);
    await repoRead.execute("tool-repo-read", { path: "src/App.tsx" }, undefined, undefined, {} as never);
    await repoTree.execute("tool-repo-tree", { path: "src" }, undefined, undefined, {} as never);
    await schedule.execute("tool-schedule", {
      issue_id: 3,
      next_run_at: "2999-01-01T00:00:00.000Z"
    }, undefined, undefined, {} as never);
    await steer.execute("tool-2", { session_key: "codex:thread-1", prompt: "adjust" }, undefined, undefined, {} as never);

    expect(calls).toEqual([
      ["recommendExecutorProfile", { issue_id: 1, role: "executor" }],
      ["createVerificationWorkflow", { target_issue_id: 1, instructions: "verify" }],
      ["listIssues", { limit: 3, status: "todo" }],
      ["readIssue", { id: 7 }],
      ["cancelIssues", { issue_ids: [812, 813, 814], rationale: "不再做" }],
      ["updateIssueStatuses", { issue_ids: [812, 813, 814], reason: "用户要求重新排队", status: "todo" }],
      ["createIssueBatchProposal", {
        items: [detailedBatchItem("foundation", "建立工程基线"), detailedBatchItem("ui", "实现前端流程")]
      }],
      ["issueStatusSummary", { status: "todo" }],
      ["issueExecutionStatus", { id: 7 }],
      ["createIssueCompletionWatch", { issue_ids: [7, 8], note: "提醒我", project_id: "demo", target_channel: "feishu" }],
      ["listIssueCompletionWatches", { project_id: "demo", status: "active" }],
      ["cancelIssueCompletionWatch", { reason: "user_cancel", watch_id: "watch-1" }],
      ["enqueueBatchTriageIssues", { issue_ids: [387, 388], project_id: "demo", user_phrase: "把 #387-#388 都开始做" }],
      ["enqueueNextTriageIssue", { project_id: "demo" }],
      ["requestIssueAcceptanceAction", { issue_id: 7, rationale: "补齐交付记录" }],
      ["createHumanReviewRequest", {
        acceptance_summary: ["Node/TypeScript/PostgreSQL", "OIDC"],
        evidence_refs: ["docs/architecture/0001.md"],
        excluded_scope: ["安装数据库"],
        issue_id: 815,
        kind: "decision",
        question: "是否接受这些技术和产品取舍？",
        recommendation: "接受"
      }],
      ["respondToHumanReview", {
        action: "accept",
        comment: "真实 smoke 后续由用户手动执行",
        issue_id: 827,
        review_request_id: "human-review-827",
        review_revision: 1
      }],
      ["diagnoseIssueState", { project_id: "demo" }],
      ["createIssueStateRepairProposal", { diagnosis_code: "done_missing_verification_evidence", issue_id: 1, operation: "patch_status" }],
      ["searchRepo", { query: "Accordion", max_results: 3 }],
      ["readRepoExcerpt", { path: "src/App.tsx" }],
      ["readRepoTree", { path: "src" }],
      ["scheduleIssueEnqueue", { issue_id: 3, next_run_at: "2999-01-01T00:00:00.000Z" }],
      ["createSessionSteerProposal", { session_key: "codex:thread-1", prompt: "adjust" }]
    ]);
  });

  test("creates high-risk proposals without mutating issues or sessions", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      const tools = createPiRunnerActionTools(actions);
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Queue me" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "verifier", sessionKey: "codex:thread-1" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "reporter", sessionKey: "codex:thread-2" });

      const createIssue = await runTool(tools, "issue_create_proposal", {
        description: "New scoped issue",
        title: "New issue"
      });
      const enqueue = await runTool(tools, "issue_enqueue_proposal", { issue_id: issueID, rationale: "ready" });
      const steer = await runTool(tools, "session_steer_proposal", {
        session_key: "codex:thread-1",
        prompt: "Please adjust the plan"
      });

      expect(createIssue.details).toMatchObject({
        action_type: "issue.create",
        requires_confirmation: true,
        status: "pending"
      });
      expect(enqueue.details).toMatchObject({
        action_type: "issue.enqueue",
        issue_id: issueID,
        requires_confirmation: true,
        status: "pending"
      });
      expect(steer.details).toMatchObject({
        action_type: "session.steer",
        requires_confirmation: true,
        status: "pending"
      });
      expect(getIssue(fixture.db, issueID)?.status).toBe("triage");
      expect(getIssue(fixture.db, issueID)?.description).toBe("");
      expect(listIssues(fixture.db, { projectId: fixture.project.id })).toHaveLength(1);
      expect(listPiActions(fixture.db).map((action) => action.action_type).sort()).toEqual([
        "issue.create",
        "issue.enqueue",
        "session.steer"
      ]);
      const steerAction = listPiActions(fixture.db).find((action) => action.action_type === "session.steer");
      expect(JSON.parse(steerAction?.payload_json ?? "{}")).toMatchObject({
        progress_context: expect.stringContaining("state=active")
      });
    } finally {
      await fixture.close();
    }
  });

  test("exposes destructive issue deletion and Runner administration only as high-risk proposals", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "triage",
        title: "Delete only after approval"
      });
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });

      const deletion = actions.deleteIssues({ issue_ids: [issueID], reason: "用户确认永久删除" }) as {
        action_id: string; status: string;
      };
      const settings = actions.updateRunnerSettings({
        max_parallel_projects: 2,
        reason: "用户要求修改并发"
      }) as { action_id: string; status: string };
      const restart = actions.restartSystem({ reason: "用户要求重启" }) as {
        action_id: string; status: string;
      };

      expect([deletion.status, settings.status, restart.status]).toEqual(["pending", "pending", "pending"]);
      expect(getIssue(fixture.db, issueID)).not.toBeNull();
      expect([deletion, settings, restart].map((item) => getPiAction(fixture.db, item.action_id)?.risk_level))
        .toEqual(["high", "high", "high"]);
      expect(actions.readRunnerSettings({})).toMatchObject({ max_parallel_projects: 1 });
    } finally {
      await fixture.close();
    }
  });

  test("caps model-visible tool result content while preserving full details", async () => {
    const tools = createPiRunnerActionTools({
      ...fakeActions([]),
      listIssues: () => ({ items: [{ description: "x".repeat(20_000), id: 1, title: "Huge" }] })
    });

    const result = await runTool(tools, "issue_list", {});
    const text = collectToolText(result.content);

    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain("[tool result truncated");
    expect(JSON.stringify(result.details)).toContain("x".repeat(20_000));
  });

  test("global Runner project_status summarizes all projects without project_id", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db);

      expect(actions.projectStatus({})).toMatchObject({
        items: [{ id: fixture.project.id, name: fixture.project.name, status: "active" }]
      });
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "project.status",
        project_id: "",
        payload_json: "{}"
      }));
    } finally {
      await fixture.close();
    }
  });

  test("executes safe reads and low-risk comments through the action layer", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Read me" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "verifier", sessionKey: "codex:thread-1" });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, role: "reporter", sessionKey: "codex:thread-2" });

      expect(actions.listIssues({ status: "todo" })).toMatchObject({ items: [{ id: issueID, title: "Read me" }] });
      expect(actions.readIssue({ id: issueID })).toMatchObject({ id: issueID, title: "Read me" });
      expect(projectIDs(actions.listProjects({}))).toContain(fixture.project.id);
      expect(sessionKeys(actions.listSessions({ role: "verifier" }))).toEqual(["codex:thread-1"]);
      expect(actions.readSessionSummary({ session_key: "codex:thread-1" })).toMatchObject({
        progress: expect.objectContaining({ progress_state: "active" })
      });

      const comment = actions.commentIssue({ issue_id: issueID, body: "Looks actionable." });

      expect(comment).toMatchObject({ type: "issue.comment", issue_id: issueID });
      const completedActions = listPiActions(fixture.db, { status: "completed" });
      expect(completedActions.map((action) => action.action_type).sort()).toEqual([
        "issue.comment", "issue.list", "issue.read", "project.list", "session.list", "session.read_summary"
      ]);
      expect(completedActions).toContainEqual(expect.objectContaining({
        action_type: "issue.comment",
        issue_id: issueID,
        result_json: expect.stringContaining("issue.comment"),
        risk_level: "low"
      }));
      const commentAction = completedActions.find((action) => action.action_type === "issue.comment");
      expect(getPiAction(fixture.db, commentAction?.id ?? "")).toMatchObject({
        action_type: "issue.comment",
        gate_decision: "execute",
        issue_id: issueID,
        result_json: expect.stringContaining("issue.comment"),
        source: "pi_tool",
        status: "completed"
      });
      expect(listPiActionEvents(fixture.db, { actionId: commentAction?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
      expect(listIssueEvents(fixture.db, issueID).map((event) => event.type)).toEqual([
        "issue.comment"
      ]);
      expect(listIssues(fixture.db, { projectId: fixture.project.id })[0]?.comment_count).toBe(1);
    } finally {
      await fixture.close();
    }
  });

  test("accepts an open human review without creating a retry Run or Provider Session", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "needs_user",
        title: "Completed implementation awaiting smoke decision"
      });
      const run = createIssueRun(fixture.db, issueID);
      fixture.db.sqlite.run(
        "update issue_runs set status='succeeded', ended_at=? where id=?",
        ["2026-08-01T00:00:00Z", run.id]
      );
      const request = createHumanReviewRequest(fixture.db, issueID, {
        question: "是否接受离线实现，并由用户后续手动执行真实 smoke？"
      });
      const actions = createPiRunnerActions(fixture.db, {
        project: fixture.project,
        source: "runner_chat"
      });

      await actions.respondToHumanReview({
        action: "accept",
        comment: "接受当前离线实现；真实 smoke 后续手动执行。",
        issue_id: issueID,
        review_request_id: request.id,
        review_revision: request.revision
      });

      expect(getIssue(fixture.db, issueID)?.status).toBe("in_progress");
      expect(listIssueRuns(fixture.db, issueID)).toHaveLength(1);
      expect(readIssueDecisionProjection(fixture.db, issueID)).toMatchObject({
        owner: "pi",
        phase: "pi_queued",
        request: { id: request.id, status: "accepted" }
      });
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "human_review.respond",
        issue_id: issueID
      }));
    } finally {
      await fixture.close();
    }
  });

  test("returns compact issue list and status summary without full issue details", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      insertIssue(fixture.db, {
        description: "large detail TOKEN=secret " + "x".repeat(2000),
        projectID: fixture.project.id,
        status: "todo",
        title: "First todo"
      });
      insertIssue(fixture.db, { projectID: fixture.project.id, status: "todo", title: "Second todo" });
      insertIssue(fixture.db, { projectID: fixture.project.id, status: "done", title: "Done item" });

      const list = actions.listIssues({}) as {
        items: Array<Record<string, unknown>>;
        limit: number;
        status_counts: Record<string, number>;
        total: number;
        truncated: boolean;
      };
      const summary = actions.issueStatusSummary({}) as {
        status_counts: Record<string, number>;
        total: number;
        unfinished_total: number;
      };

      expect(list).toMatchObject({
        limit: 50,
        status_counts: { done: 1, todo: 2 },
        total: 3,
        truncated: false
      });
      expect(list.items).toHaveLength(3);
      expect(list.items).toContainEqual(expect.objectContaining({ id: 1, status: "todo", title: "First todo" }));
      expect(JSON.stringify(list)).not.toContain("description");
      expect(JSON.stringify(list)).not.toContain("TOKEN=secret");
      expect(summary).toMatchObject({
        status_counts: { done: 1, todo: 2 },
        total: 3,
        unfinished_total: 2
      });
      expect(JSON.stringify(summary)).not.toContain("First todo");

      const limited = actions.listIssues({ limit: 1 }) as { items: unknown[]; limit: number; truncated: boolean };
      expect(limited).toMatchObject({ limit: 1, truncated: true });
      expect(limited.items).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  test("returns compact execution status for one issue without description or raw logs", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      const issueID = insertIssue(fixture.db, {
        description: "full issue body should stay out TOKEN=secret",
        projectID: fixture.project.id,
        status: "failed",
        title: "Broken issue"
      });
      fixture.db.sqlite.run(
        `insert into issue_runs
          (id, issue_id, attempt, status, provider, provider_session_id, started_at, ended_at, exit_reason, error)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "issue-1-attempt-1", issueID, 1, "failed", "codex", "thread-1",
          "2026-01-01T01:00:00Z", "2026-01-01T01:05:00Z", "error", "context window TOKEN=secret"
        ]
      );
      fixture.db.sqlite.run(
        `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
        [issueID, "issue.log", JSON.stringify({ text: "last useful line TOKEN=secret" }), "2026-01-01T01:04:00Z"]
      );

      const status = actions.issueExecutionStatus({ id: issueID }) as {
        issue: Record<string, unknown>;
        latest_run: Record<string, unknown>;
        recent_events: Array<Record<string, unknown>>;
      };

      expect(status.issue).toMatchObject({ id: issueID, status: "failed", title: "Broken issue" });
      expect(status.latest_run).toMatchObject({ attempt: 1, status: "failed", provider: "codex" });
      expect(status.recent_events).toEqual([
        expect.objectContaining({ type: "issue.log", payload_preview: expect.stringContaining("TOKEN=[redacted]") })
      ]);
      expect(JSON.stringify(status)).not.toContain("full issue body");
      expect(JSON.stringify(status)).not.toContain("TOKEN=secret");
    } finally {
      await fixture.close();
    }
  });

  test("repo read-only actions are scoped, bounded, redacted, and audited", async () => {
    const fixture = await openFixture();
    try {
      mkdirSync(fixture.project.cwd, { recursive: true });
      writeFileSync(join(fixture.project.cwd, "README.md"), "# Demo\nTOKEN=secret\nneedle line\n");
      mkdirSync(join(fixture.project.cwd, "src"), { recursive: true });
      writeFileSync(join(fixture.project.cwd, "src", "App.tsx"), "export const App = 'needle';\n");
      mkdirSync(join(fixture.project.cwd, ".git"), { recursive: true });
      writeFileSync(join(fixture.project.cwd, ".git", "config"), "[core]\n");
      writeFileSync(join(fixture.project.cwd, "large.txt"), "x".repeat(4097));
      writeFileSync(join(fixture.project.cwd, "secret.token"), "needle\n");
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });

      expect(actions.readRepoTree({ path: ".", max_depth: 2 })).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ path: "README.md", source: "repo_tree" }),
          expect.objectContaining({ path: "src", type: "directory" })
        ]),
        skipped: expect.arrayContaining([
          expect.objectContaining({ path: ".git", reason: expect.stringContaining("sensitive") }),
          expect.objectContaining({ path: "secret.token", reason: expect.stringContaining("sensitive") })
        ])
      });
      const searchResult = actions.searchRepo({ query: "needle", max_results: 5 });
      expect(searchResult).toMatchObject({
        truncated: false,
        results: [
          expect.objectContaining({ line_range: { end: 3, start: 3 }, path: "README.md", source: "repo_search" }),
          expect.objectContaining({ path: "src/App.tsx", source: "repo_search" })
        ],
        skipped: expect.arrayContaining([
          expect.objectContaining({ path: "large.txt", reason: expect.stringContaining("exceeds") }),
          expect.objectContaining({ path: "secret.token", reason: expect.stringContaining("sensitive") })
        ])
      });
      expect(actions.searchRepo({ query: "needle", max_results: 1 })).toMatchObject({
        results: [expect.objectContaining({ path: "README.md" })],
        truncated: true
      });
      const excerpt = actions.readRepoExcerpt({ path: "README.md", start_line: 1, max_lines: 3 });
      expect(excerpt).toMatchObject({
        excerpt: expect.stringContaining("TOKEN=[redacted]"),
        line_range: { end: 3, start: 1 },
        path: "README.md",
        source: "repo_read_excerpt"
      });
      expect(JSON.stringify(excerpt)).not.toContain("TOKEN=secret");
      expect(() => actions.readRepoExcerpt({ path: "../outside.txt" })).toThrow(/project scope/);
      expect(() => actions.readRepoExcerpt({ path: join(fixture.project.cwd, "README.md") })).toThrow(/absolute/);
      expect(() => actions.readRepoExcerpt({ path: ".git/config" })).toThrow(/sensitive/);
      expect(() => actions.readRepoExcerpt({ path: "large.txt" })).toThrow(/exceeds/);
      expect(readFileSync(join(fixture.project.cwd, "README.md"), "utf8")).toBe("# Demo\nTOKEN=secret\nneedle line\n");
      const repoActions = listPiActions(fixture.db).filter((action) => action.action_type.startsWith("repo."));

      expect(repoActions.map((action) => action.action_type).sort()).toEqual([
        "repo.read_excerpt",
        "repo.read_excerpt",
        "repo.read_excerpt",
        "repo.read_excerpt",
        "repo.read_excerpt",
        "repo.search",
        "repo.search",
        "repo.tree"
      ]);
      expect(repoActions.every((action) => !action.result_json.includes("TOKEN=secret"))).toBe(true);
      const auditedSearch = repoActions.find((action) => action.payload_json.includes('"max_results":5'));
      expect(JSON.parse(auditedSearch?.payload_json ?? "{}")).toEqual({
        max_results: 5,
        query: "needle"
      });
    } finally {
      await fixture.close();
    }
  });

  test("read-only action gate does not create pending approvals under narrow mutation policy", async () => {
    const fixture = await openFixture();
    try {
      mkdirSync(fixture.project.cwd, { recursive: true });
      writeFileSync(join(fixture.project.cwd, "README.md"), "# Demo\nneedle\n");
      const issueID = insertIssue(fixture.db, {
        projectID: fixture.project.id,
        status: "todo",
        title: "Read-only issue"
      });
      insertAgentSession(fixture.db, { projectID: fixture.project.id, sessionKey: "codex:thread-readonly" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          allowed_actions: ["issue.enqueue"],
          authorizedActions: [{ action_type: "issue.enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      });

      actions.projectStatus({});
      actions.readRepoTree({ path: ".", max_depth: 1 });
      actions.searchRepo({ query: "needle", max_results: 3 });
      actions.readRepoExcerpt({ path: "README.md", max_lines: 2 });
      actions.readIssue({ id: issueID });
      actions.issueExecutionStatus({ id: issueID });
      actions.listSessions({});
      actions.readSessionSummary({ session_key: "codex:thread-readonly" });
      actions.listSkills({});
      actions.listMcpRegistry({});

      const actionsAfterReads = listPiActions(fixture.db);
      expect(actionsAfterReads.map((action) => action.status)).not.toContain("pending");
      expect(actionsAfterReads.map((action) => action.gate_decision)).toEqual(
        actionsAfterReads.map(() => "execute")
      );
      expect(listPiActionEvents(fixture.db).map((event) => event.event_type)).not.toContain("pending_approval");

      const sideEffect = actions.commentIssue({ issue_id: issueID, body: "requires explicit mutation coverage" }) as {
        decision: string;
        status: string;
      };
      expect(sideEffect).toMatchObject({ decision: "deny", status: "denied" });
      expect(getIssue(fixture.db, issueID)?.comment_count).toBe(0);
    } finally {
      await fixture.close();
    }
  });

  test("keeps confirm-required actions pending and records rationale/result", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, {
        conversationID: "conv-1",
        project: fixture.project
      });
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Queue me" });

      const action = actions.enqueueIssueProposal({ issue_id: issueID, rationale: "ready to run" }) as {
        action_id: string;
      };
      const stored = getPiAction(fixture.db, action.action_id);

      expect(stored).toMatchObject({
        action_type: "issue.enqueue",
        conversation_id: "conv-1",
        issue_id: issueID,
        payload_json: JSON.stringify({ issue_id: issueID }),
        project_id: fixture.project.id,
        rationale: "ready to run",
        requires_confirmation: 1,
        result_json: expect.stringContaining("pending"),
        risk_level: "medium",
        status: "pending"
      });
      expect(action).toMatchObject({
        action_type: "issue.enqueue",
        decision: "ask",
        requires_confirmation: true,
        risk_level: "medium",
        status: "pending"
      });
      expect(listPiActionEvents(fixture.db, { actionId: action.action_id }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "pending_approval"
      ]);
    } finally {
      await fixture.close();
    }
  });

  test("delegated runner chat can schedule one issue enqueue through a real once cron", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Schedule me" });
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.schedule_enqueue", issue_id: issueID, project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        conversationID: "conv-chat",
        project: fixture.project
      });

      const result = actions.scheduleIssueEnqueue({
        issue_id: issueID,
        next_run_at: "2999-01-01T00:00:00.000Z",
        rationale: "user picked later"
      }) as { action_id: string; decision: string; status: string };
      const automation = listAutomations(fixture.db).find((item) => item.id.startsWith("automation:issue-"));

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(getPiAction(fixture.db, result.action_id)).toMatchObject({
        action_type: "issue.schedule_enqueue",
        conversation_id: "conv-chat",
        gate_decision: "execute",
        issue_id: issueID,
        status: "completed"
      });
      expect(automation).toMatchObject({
        mode: "execute_allowed",
        next_run_at: "2999-01-01T00:00:00.000Z",
        owner: { kind: "project", project_id: fixture.project.id },
        status: "active"
      });
      expect(automation?.workflow_ref).toBe("workflow:implement@1");
      expect(getIssue(fixture.db, issueID)?.status).toBe("triage");
    } finally {
      await fixture.close();
    }
  });

  test("delegated runner chat issue creation returns the created issue id", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.create", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        conversationID: "conv-chat",
        project: fixture.project
      });

      const result = actions.createIssueProposal({
        description: "Create and then ask when to run",
        title: "Chat-created issue"
      }) as { result?: { id?: number }; status: string };

      expect(result).toMatchObject({
        decision: "execute",
        result: { id: 1, status: "triage", title: "Chat-created issue" },
        status: "completed"
      });
      expect(getIssue(fixture.db, 1)).toMatchObject({ title: "Chat-created issue" });
    } finally {
      await fixture.close();
    }
  });

  test("delegated runner chat enqueues exactly one next triage issue for the current project", async () => {
    const fixture = await openFixture();
    const kickedProjects: string[] = [];
    try {
      fixture.db.sqlite.run(
        `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        ["other", "Other", `${fixture.project.cwd}-other`, 2, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
      );
      const otherProjectIssue = insertIssue(fixture.db, {
        createdAt: "2026-01-01T00:00:00Z",
        priority: 99,
        projectID: "other",
        status: "triage",
        title: "Other project should not run"
      });
      insertIssue(fixture.db, {
        createdAt: "2026-01-03T00:00:00Z",
        priority: 10,
        projectID: fixture.project.id,
        status: "triage",
        title: "High but later"
      });
      const selected = insertIssue(fixture.db, {
        createdAt: "2026-01-02T00:00:00Z",
        priority: 10,
        projectID: fixture.project.id,
        status: "triage",
        title: "Selected next"
      });
      const tiedLaterID = insertIssue(fixture.db, {
        createdAt: "2026-01-02T00:00:00Z",
        priority: 10,
        projectID: fixture.project.id,
        status: "triage",
        title: "Same rank later id"
      });
      insertIssue(fixture.db, {
        createdAt: "2026-01-01T00:00:00Z",
        priority: 1,
        projectID: fixture.project.id,
        status: "triage",
        title: "Low priority first created"
      });
      const actions = createPiRunnerActions(fixture.db, {
        onIssueEnqueued: (projectID) => kickedProjects.push(projectID),
        project: fixture.project,
        source: "runner_chat"
      });

      const result = actions.enqueueNextTriageIssue({ rationale: "继续做下一个" }) as {
        decision: string;
        issue_id: number;
        result?: { id?: number; status?: string; title?: string };
        status: string;
      };

      expect(result).toMatchObject({
        decision: "execute",
        issue_id: selected,
        result: { id: selected, status: "todo", title: "Selected next" },
        status: "completed"
      });
      expect(getIssue(fixture.db, selected)).toMatchObject({ status: "todo" });
      expect(getIssue(fixture.db, tiedLaterID)).toMatchObject({ status: "triage" });
      expect(getIssue(fixture.db, otherProjectIssue)).toMatchObject({ status: "triage" });
      expect(listIssues(fixture.db, { projectId: fixture.project.id, status: "todo" })).toHaveLength(1);
      expect(listIssues(fixture.db, { projectId: fixture.project.id, status: "triage" })).toHaveLength(3);
      expect(listIssues(fixture.db, { projectId: "other", status: "todo" })).toHaveLength(0);
      expect(kickedProjects).toEqual([fixture.project.id]);
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "issue.enqueue",
        issue_id: selected,
        payload_json: JSON.stringify({ issue_id: selected })
      }));
    } finally {
      await fixture.close();
    }
  });

  test("delegated runner chat batch-enqueues all matching triage issues for the current project", async () => {
    const fixture = await openFixture();
    const kickedProjects: string[] = [];
    try {
      fixture.db.sqlite.run(
        `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?)`,
        ["other", "Other", `${fixture.project.cwd}-other`, 2, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
      );
      const otherProjectIssue = insertIssue(fixture.db, {
        createdAt: "2026-01-01T00:00:00Z",
        priority: 99,
        projectID: "other",
        status: "triage",
        title: "Other project should not run"
      });
      const selectedA = insertIssue(fixture.db, {
        createdAt: "2026-01-01T00:00:00Z",
        priority: 10,
        projectID: fixture.project.id,
        status: "triage",
        title: "First selected"
      });
      const selectedB = insertIssue(fixture.db, {
        createdAt: "2026-01-02T00:00:00Z",
        priority: 10,
        projectID: fixture.project.id,
        status: "triage",
        title: "Second selected"
      });
      const skippedByLimit = insertIssue(fixture.db, {
        createdAt: "2026-01-03T00:00:00Z",
        priority: 10,
        projectID: fixture.project.id,
        status: "triage",
        title: "Skipped by limit"
      });
      insertIssue(fixture.db, {
        createdAt: "2026-01-01T00:00:00Z",
        priority: 20,
        projectID: fixture.project.id,
        status: "todo",
        title: "Already todo"
      });
      const actions = createPiRunnerActions(fixture.db, {
        onIssueEnqueued: (projectID) => kickedProjects.push(projectID),
        project: fixture.project,
        source: "runner_chat"
      });

      const result = actions.enqueueBatchTriageIssues({
        rationale: "开始这25个issue",
        user_phrase: "开始这25个issue"
      }) as {
        enqueued_count: number;
        enqueued: Array<{ id: number; status: string; title: string }>;
        skipped: Array<{ count: number; reason: string }>;
        status: string;
      };

      expect(result).toMatchObject({
        enqueued_count: 3,
        enqueued: [
          { id: selectedA, status: "todo", title: "First selected" },
          { id: selectedB, status: "todo", title: "Second selected" },
          { id: skippedByLimit, status: "todo", title: "Skipped by limit" }
        ],
        project_id: fixture.project.id,
        skipped: [],
        status: "completed"
      });
      expect(getIssue(fixture.db, selectedA)).toMatchObject({ status: "todo" });
      expect(getIssue(fixture.db, selectedB)).toMatchObject({ status: "todo" });
      expect(getIssue(fixture.db, skippedByLimit)).toMatchObject({ status: "todo" });
      expect(getIssue(fixture.db, otherProjectIssue)).toMatchObject({ status: "triage" });
      expect(kickedProjects).toEqual([fixture.project.id]);
      expect(listPiActions(fixture.db, { status: "completed" }).filter((action) => action.action_type === "issue.enqueue"))
        .toHaveLength(3);
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "issue.enqueue",
        issue_id: selectedA
      }));
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "issue.enqueue",
        issue_id: selectedB
      }));
      const payloads = listPiActions(fixture.db, { status: "completed" })
        .filter((action) => action.action_type === "issue.enqueue")
        .map((action) => JSON.parse(action.payload_json));
      const runGroupIDs = new Set(payloads.map((payload) => payload.run_group_id));
      expect(runGroupIDs.size).toBe(1);
      expect(payloads).toContainEqual(expect.objectContaining({ issue_id: selectedA, run_group_id: expect.any(String) }));
      expect(payloads).toContainEqual(expect.objectContaining({ issue_id: selectedB, run_group_id: expect.any(String) }));
    } finally {
      await fixture.close();
    }
  });

  test("batch triage enqueue keeps ordinary chat behind approval gate without a count cap", async () => {
    const fixture = await openFixture();
    const kickedProjects: string[] = [];
    try {
      const issueIDs = Array.from({ length: 6 }, (_unused, index) => insertIssue(fixture.db, {
        createdAt: `2026-01-0${index + 1}T00:00:00Z`,
        priority: 1,
        projectID: fixture.project.id,
        status: "triage",
        title: `Candidate ${index + 1}`
      }));
      const actions = createPiRunnerActions(fixture.db, {
        onIssueEnqueued: (projectID) => kickedProjects.push(projectID),
        project: fixture.project
      });

      const result = actions.enqueueBatchTriageIssues({
        rationale: "完成所有 issue",
        user_phrase: "完成所有 issue"
      }) as {
        enqueued_count: number;
        pending_count: number;
        skipped: Array<{ count: number; reason: string }>;
        status: string;
      };

      expect(result).toMatchObject({
        enqueued_count: 0,
        pending_count: 6,
        skipped: [
          { count: 6, reason: "approval_required" }
        ],
        status: "pending"
      });
      expect(issueIDs.map((id) => getIssue(fixture.db, id)?.status)).toEqual([
        "triage", "triage", "triage", "triage", "triage", "triage"
      ]);
      expect(kickedProjects).toEqual([]);
      expect(listPiActions(fixture.db, { status: "pending" })
        .filter((action) => action.action_type === "issue.enqueue")).toHaveLength(6);
    } finally {
      await fixture.close();
    }
  });

  test("batch triage enqueue trusts agent intent instead of re-parsing ambiguous phrases", async () => {
    const fixture = await openFixture();
    try {
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "triage", title: "Should stay triage" });
      const actions = createPiRunnerActions(fixture.db, {
        project: fixture.project,
        source: "runner_chat"
      });

      const result = actions.enqueueBatchTriageIssues({ user_phrase: "开始做吧" }) as {
        enqueued_count: number;
        status: string;
      };

      expect(result).toMatchObject({
        enqueued_count: 1,
        status: "completed"
      });
      expect(getIssue(fixture.db, issueID)).toMatchObject({ status: "todo" });
      expect(listPiActions(fixture.db, { status: "completed" })).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  test("next triage enqueue reports no candidate without mutating issues", async () => {
    const fixture = await openFixture();
    try {
      insertIssue(fixture.db, { projectID: fixture.project.id, status: "done", title: "Already done" });
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });

      const result = actions.enqueueNextTriageIssue({}) as {
        message: string;
        project_id: string;
        source: string;
        status: string;
      };

      expect(result).toEqual({
        message: "没有可继续的 triage issue",
        project_id: fixture.project.id,
        source: "issue_enqueue_next_triage",
        status: "no_candidate"
      });
      expect(listIssues(fixture.db, { projectId: fixture.project.id, status: "todo" })).toHaveLength(0);
      expect(listPiActions(fixture.db)).toHaveLength(0);
    } finally {
      await fixture.close();
    }
  });

  test("renders repo context pack into issue create proposals and sanitizes payload", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.create", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        conversationID: "conv-chat",
        project: fixture.project
      });

      const result = actions.createIssueProposal({
        acceptance_criteria: ["任务可从 pending 到 succeeded。"],
        context_pack: {
          intent: "实现折叠面板",
          project: { id: "demo" },
          evidence: [{
            source_kind: "code",
            path: "README.md",
            summary: "existing docs mention panel",
            excerpt: "TOKEN=super-secret\npanel docs"
          }],
          relevant_files: [{ path: "README.md", reason: "docs", symbols: ["Panel"] }],
          proposed_changes: ["Add toggle state"],
          acceptance_criteria: ["Panel can collapse"],
          validation: ["bun test src/panel.test.ts"],
          open_questions: ["默认展开吗？"]
        },
        description: "用户要求实现折叠面板\nAPI_KEY=must-not-leak",
        evidence: [{ source_kind: "message", summary: "Feishu request" }],
        title: "Repo-aware issue"
      }) as { result?: { id?: number }; status: string };
      const action = listPiActions(fixture.db).find((item) => item.action_type === "issue.create");
      const payload = JSON.parse(action?.payload_json ?? "{}");
      const issue = getIssue(fixture.db, result.result?.id ?? 0);

      expect(result).toMatchObject({ decision: "execute", status: "completed" });
      expect(payload.context_pack).toBeUndefined();
      expect(payload.evidence).toBeUndefined();
      expect(payload.description).toContain("## 需求理解");
      expect(payload.description).toContain("## 相关证据");
      expect(payload.description).toContain("README.md");
      expect(payload.description).toContain("Feishu request");
      expect(payload.description).not.toContain("super-secret");
      expect(payload.description).not.toContain("must-not-leak");
      expect(issue?.description).toBe(payload.description);
    } finally {
      await fixture.close();
    }
  });

  test("normalizes the Chinese context-pack keys emitted by the live PI session without losing detail", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.create", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        project: fixture.project
      });

      const result = actions.createIssueProposal({
        context_pack: {
          "需求理解": "按 PRD 建立服装图片生成 MVP。",
          "相关证据": ["PRD 第 6 节定义上传、任务与结果流程。", "用户要求使用真实 Provider。"],
          "建议改动": ["先固定 API 合同。", "再实现异步任务状态机。"],
          "验收标准": ["任务可从 pending 到 succeeded。"],
          "验证建议": ["运行真实 Provider smoke。"],
          "未确认问题": ["供应商 endpoint 待用户配置。"]
        },
        description: "实现任务后端",
        title: "实现任务后端"
      }) as { result?: { id?: number } };
      const issue = getIssue(fixture.db, result.result?.id ?? 0);

      expect(issue?.description).toContain("Supervisor 理解：按 PRD 建立服装图片生成 MVP。");
      expect(issue?.description).toContain("PRD 第 6 节定义上传、任务与结果流程。");
      expect(issue?.description).toContain("1. 先固定 API 合同。");
      expect(issue?.description).toContain("1. 任务可从 pending 到 succeeded。");
      expect(issue?.description?.match(/任务可从 pending 到 succeeded。/g)).toHaveLength(1);
      expect(issue?.description).toContain("1. 运行真实 Provider smoke。");
      expect(issue?.description).not.toContain("## 相关证据\n- (none)");
      expect(issue?.description).not.toContain("## 建议改动\n- (none)");
      expect(() => actions.createIssueProposal({
        context_pack: { unexpected_section: ["must not disappear"] } as never,
        description: "invalid",
        title: "invalid"
      })).toThrow(/unsupported fields: unexpected_section/);
    } finally {
      await fixture.close();
    }
  });

  test("creates a detailed triage issue batch with an audited dependency DAG and never enqueues it", async () => {
    const fixture = await openFixture();
    try {
      const actions = createPiRunnerActions(fixture.db, {
        authorization: {
          authorizedActions: [{ action_type: "issue.create", project_id: fixture.project.id }],
          mode: "delegated",
          scope: { project_id: fixture.project.id }
        },
        conversationID: "conv-prd-batch",
        project: fixture.project
      });

      const result = actions.createIssueBatchProposal({
        project_id: fixture.project.id,
        rationale: "用户要求按 PRD 创建后先 review",
        items: [
          detailedBatchItem("contract", "固定 API 与状态合同"),
          { ...detailedBatchItem("provider", "接入真实图片 Provider"), depends_on_refs: ["contract"] },
          { ...detailedBatchItem("journey", "验证端到端生成链路"), depends_on_refs: ["contract", "provider"] }
        ]
      }) as { result?: { count?: number; items?: Array<{ id: number; ref: string }> }; status: string };
      const issues = listIssues(fixture.db, { projectId: fixture.project.id });
      const action = listPiActions(fixture.db).find((item) => item.action_type === "issue.create");
      const refs = Object.fromEntries((result.result?.items ?? []).map((item) => [item.ref, item.id]));

      expect(result).toMatchObject({ status: "completed", result: { count: 3, status: "created" } });
      expect(issues).toHaveLength(3);
      expect(issues.map((issue) => issue.status)).toEqual(["triage", "triage", "triage"]);
      expect(issues.every((issue) => issue.description.includes("## 相关证据") &&
        issue.description.includes("## 建议改动") && !issue.description.includes("## 建议改动\n- (none)"))).toBe(true);
      expect(action).toMatchObject({ conversation_id: "conv-prd-batch", status: "completed" });
      expect(JSON.parse(action?.payload_json ?? "{}").batch_items).toHaveLength(3);
      expect(fixture.db.sqlite.query<{ dependency_issue_ids_json: string }, [number]>(
        "select dependency_issue_ids_json from issues where id=?"
      ).get(refs.provider)?.dependency_issue_ids_json).toBe(JSON.stringify([refs.contract]));
      expect(fixture.db.sqlite.query<{ dependency_issue_ids_json: string }, [number]>(
        "select dependency_issue_ids_json from issues where id=?"
      ).get(refs.journey)?.dependency_issue_ids_json).toBe(JSON.stringify([refs.contract, refs.provider]));
      expect(listIssueEvents(fixture.db, refs.contract).map((event) => event.type)).toEqual(["issue.created"]);

      const beforeActionCount = listPiActions(fixture.db).length;
      expect(() => actions.createIssueBatchProposal({
        items: [
          { ...detailedBatchItem("a", "A"), depends_on_refs: ["b"] },
          { ...detailedBatchItem("b", "B"), depends_on_refs: ["a"] }
        ]
      })).toThrow(/dependency graph contains a cycle/);
      expect(listPiActions(fixture.db)).toHaveLength(beforeActionCount);
      expect(listIssues(fixture.db, { projectId: fixture.project.id })).toHaveLength(3);
    } finally {
      await fixture.close();
    }
  });

  test("orchestrates role workflows through gated PI actions and issue linkage", async () => {
    const fixture = await openFixture();
    try {
      insertAgentProfile(fixture.db, {
        id: "verifier-codex",
        name: "Verifier Codex",
        skillIntents: "[\"verification-before-completion\"]"
      });
      insertAgentProfile(fixture.db, { id: "reporter-codex", name: "Reporter Codex", skillIntents: "[\"codex-issue-runner\"]" });
      const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
      const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "pending_verification", title: "Ready" });

      const recommendation = actions.recommendExecutorProfile({ issue_id: issueID, role: "verifier" });
      const verifier = actions.createVerificationWorkflow({
        target_issue_id: issueID,
        instructions: "Check tests and evidence",
        verification_plan: "bun test",
        rationale: "ready for verifier"
      }) as { action_id: string };
      const reporter = actions.createReportWorkflow({ report_type: "nightly", title: "Nightly report" }) as { action_id: string };
      const reviewer = actions.createReviewWorkflow({ target_issue_id: issueID, instructions: "review patch" }) as { action_id: string };
      const escalation = actions.escalateNeedsUser({
        issue_id: issueID,
        reason: "missing production smoke",
        requested_action: "provide smoke window"
      }) as { action_id: string };

      expect(recommendation).toMatchObject({ agent_role: "verifier", profile_id: "verifier-codex" });
      expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
        action_type: "agent.profile_recommend",
        gate_decision: "execute",
        project_id: fixture.project.id
      }));
      expect(getPiAction(fixture.db, verifier.action_id)).toMatchObject({
        action_type: "agent.workflow_request",
        issue_id: issueID,
        status: "pending"
      });
      expect(JSON.parse(getPiAction(fixture.db, verifier.action_id)?.payload_json ?? "{}")).toMatchObject({
        agent_profile_id: "verifier-codex",
        source_excerpt: expect.stringContaining(`parent_issue_id=${issueID}`),
        workflow_snapshot_json: expect.stringContaining("\"agent_role\":\"verifier\"")
      });
      expect(JSON.parse(getPiAction(fixture.db, reporter.action_id)?.payload_json ?? "{}")).toMatchObject({
        title: "Nightly report",
        workflow_snapshot_json: expect.stringContaining("\"agent_role\":\"reporter\"")
      });
      expect(JSON.parse(getPiAction(fixture.db, reviewer.action_id)?.payload_json ?? "{}")).toMatchObject({
        title: expect.stringContaining(`Reviewer: #${issueID}`),
        workflow_snapshot_json: expect.stringContaining("\"agent_role\":\"reviewer\"")
      });
      expect(getPiAction(fixture.db, escalation.action_id)).toMatchObject({
        action_type: "needs_user.escalate",
        issue_id: issueID,
        status: "pending"
      });
      expect(getIssue(fixture.db, issueID)?.comment_count).toBe(0);
    } finally {
      await fixture.close();
    }
  });
});
function projectIDs(result: unknown): string[] {
  return (result as { items: Project[] }).items.map((project) => project.id);
}
function sessionKeys(result: unknown): string[] {
  return (result as { items: AgentSession[] }).items.map((session) => session.session_key);
}
function fakeActions(calls: Array<[string, unknown]>): PiRunnerActionLayer {
  const record = (name: string) => (input: unknown) => {
    calls.push([name, input]);
    return { ok: true };
  };
  return {
    cancelIssues: record("cancelIssues"),
    deleteIssues: record("deleteIssues"),
    updateIssueStatuses: record("updateIssueStatuses"),
    commentIssue: record("commentIssue"),
    assignExecutorProfileProposal: record("assignExecutorProfileProposal"),
    createExecutorIssueProposal: record("createExecutorIssueProposal"),
    createIssueCompletionWatch: record("createIssueCompletionWatch"),
    createIssueBatchProposal: record("createIssueBatchProposal"),
    createIssueProposal: record("createIssueProposal"),
    createHumanReviewRequest: record("createHumanReviewRequest"),
    respondToHumanReview: record("respondToHumanReview"),
    requestIssueAcceptanceAction: record("requestIssueAcceptanceAction"),
    createIssueStateRepairProposal: record("createIssueStateRepairProposal"),
    createReportWorkflow: record("createReportWorkflow"),
    createReviewWorkflow: record("createReviewWorkflow"),
    createVerificationWorkflow: record("createVerificationWorkflow"),
    diagnoseIssueState: record("diagnoseIssueState"),
    escalateNeedsUser: record("escalateNeedsUser"),
    createSessionSteerProposal: record("createSessionSteerProposal"),
    enqueueBatchTriageIssues: record("enqueueBatchTriageIssues"),
    enqueueNextTriageIssue: record("enqueueNextTriageIssue"),
    enqueueIssueProposal: record("enqueueIssueProposal"),
    cancelIssueCompletionWatch: record("cancelIssueCompletionWatch"),
    listIssues: record("listIssues"),
    listIssueCompletionWatches: record("listIssueCompletionWatches"),
    listMcpRegistry: record("listMcpRegistry"),
    listMcpResources: record("listMcpResources"),
    listProjects: record("listProjects"),
    listSessions: record("listSessions"),
    projectStatus: record("projectStatus"),
    listSkills: record("listSkills"),
    readIssue: record("readIssue"),
    readRunnerSettings: record("readRunnerSettings"),
    readMcpCapability: record("readMcpCapability"),
    readMcpResource: record("readMcpResource"),
    readRepoExcerpt: record("readRepoExcerpt"),
    readRepoTree: record("readRepoTree"),
    readSessionSummary: record("readSessionSummary"),
    readSkill: record("readSkill"),
    scheduleIssueEnqueue: record("scheduleIssueEnqueue"),
    searchRepo: record("searchRepo"),
    recommendExecutorProfile: record("recommendExecutorProfile"),
    recommendMcpRequirements: record("recommendMcpRequirements"),
    recommendSkills: record("recommendSkills"),
    auditSkillIntents: record("auditSkillIntents"),
    issueExecutionStatus: record("issueExecutionStatus"),
    issueStatusSummary: record("issueStatusSummary"),
    runManualContextIntake: record("runManualContextIntake"),
    restartSystem: record("restartSystem"),
    updateRunnerSettings: record("updateRunnerSettings")
  };
}

function detailedBatchItem(ref: string, title: string) {
  return {
    acceptance_criteria: [`${title} 可以独立验收。`],
    description: `${title}，保持单一主要交付目标。`,
    evidence: [`PRD 明确要求：${title}`],
    proposed_changes: [`实施 ${title}。`],
    ref,
    title,
    validation: [`运行 ${ref} focused test。`]
  };
}

function insertAgentProfile(
  db: RunnerDatabase,
  input: { id: string; name: string; skillIntents: string }
): void {
  db.sqlite.run(
    `insert into agent_profiles (id, name, provider, model, reasoning_effort,
      approval_policy, sandbox, skill_intents_json, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.id, input.name, "codex", "gpt-test", "high", "never",
      "workspace-write", input.skillIntents, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
    ]
  );
}
async function openFixture(): Promise<{ close(): Promise<void>; db: RunnerDatabase; project: Project }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-action-tools-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    ["demo", "Demo", join(root, "project"), 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
  const project = getProject(db, "demo");
  if (!project) throw new Error("missing fixture project");
  return { db, project, close: async () => { db.close(); await rm(root, { recursive: true, force: true }); } };
}
function insertIssue(
  db: RunnerDatabase,
  input: { createdAt?: string; description?: string; priority?: number; projectID: string; status: string; title: string }
): number {
  const createdAt = input.createdAt ?? "2026-01-01T00:00:00Z";
  db.sqlite.run(
    `insert into issues (project_id, title, description, status, priority, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    [
      input.projectID, input.title, input.description ?? "", input.status,
      input.priority ?? 0, createdAt, createdAt
    ]
  );
  const row = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get();
  if (!row) throw new Error("missing issue id");
  return row.id;
}
function insertAgentSession(db: RunnerDatabase, input: { projectID: string; role?: string; sessionKey: string }): void {
  const [, sessionID] = input.sessionKey.split(":");
  db.sqlite.run(
    `insert into agent_sessions
      (session_key, provider, provider_session_id, agent_role, project_id, title, status, raw_ref, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.sessionKey, "codex", sessionID, input.role ?? "", input.projectID, "Thread 1", "running",
      '{"provider_turn_id":"turn-1"}', "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"
    ]
  );
}
function toolByName(tools: ReturnType<typeof createPiRunnerActionTools>, name: string) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`missing tool ${name}`);
  return tool;
}
function validateArgs(tool: ReturnType<typeof toolByName>, args: Record<string, unknown>) {
  return validateToolArguments(tool as never, { name: tool.name, arguments: args } as never);
}
function collectToolText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "object" && block && "text" in block && typeof block.text === "string") return block.text;
    return "";
  }).join("\n");
}
async function runTool(
  tools: ReturnType<typeof createPiRunnerActionTools>,
  name: string,
  params: Record<string, unknown>
) {
  return toolByName(tools, name).execute("tool-call", params as never, undefined, undefined, {} as never);
}
