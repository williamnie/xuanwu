import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateToolArguments } from "@earendil-works/pi-ai";
import type { RunnerDatabase } from "../../db/database.ts";
import { listAutomations } from "../../db/repositories/automations.ts";
import type { AgentSession } from "../../db/repositories/agentSessions.ts";
import { getIssue, listIssueRuns, listIssues } from "../../db/repositories/issues.ts";
import { listIssueEvents } from "../../db/repositories/issueEvents.ts";
import { createIssueRun } from "../../db/repositories/issueRuns.ts";
import { getPiAction, listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createHumanReviewRequest, readIssueDecisionProjection } from "../../domain/review/humanReview.ts";
import { createPiRunnerActions, type PiRunnerActionLayer } from "./runnerActions.ts";
import { createPiRunnerActionTools, PI_RUNNER_ACTION_TOOL_NAMES } from "./runnerActionTools.ts";
import { insertIssue as insertIssueRow, insertProject, useTestDatabase } from "../../testing/harness.ts";

import { HUMAN_REVIEW, HUMAN_REVIEW_RESPONSE, BATCH, VALID_ARGUMENTS, INVALID_ARGUMENTS, DELEGATED_CALLS, openDatabase, projectIDs, sessionKeys, fakeActions, detailedBatchItem, insertAgentProfile, openFixture, insertIssue, insertAgentSession } from "./runnerActionToolsFixtureHUMAN_REVIEW.ts";
import { toolByName, validateArgs, collectToolText, runTool } from "./runnerActionToolsFixtureToolByName.ts";

export function registerRendersRepoContextPackIntoIssue() {
test("renders repo context pack into issue create proposals and sanitizes payload", async () => {
    const fixture = await openFixture();
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
      project_id: fixture.project.id,
      title: "Repo-aware issue"
    }) as { result?: { id?: number }; status: string };
    const action = listPiActions(fixture.db).find((item) => item.action_type === "issue.create");
    const payload = JSON.parse(action?.payload_json ?? "{}");
    const issue = getIssue(fixture.db, result.result?.id ?? 0);

    expect(result).toMatchObject({ decision: "execute", status: "completed" });
    expect(payload.context_pack).toBeUndefined();
    expect(payload.evidence).toBeUndefined();
    expect(payload.description).toContain("## 一句话目标");
    expect(payload.description).toContain("## 相关证据");
    expect(payload.description).toContain("README.md");
    expect(payload.description).toContain("Feishu request");
    expect(payload.description).not.toContain("super-secret");
    expect(payload.description).not.toContain("must-not-leak");
    expect(issue?.description).toBe(payload.description);
  });

test("normalizes the Chinese context-pack keys emitted by the live PI session without losing detail", async () => {
    const fixture = await openFixture();
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
      project_id: fixture.project.id,
      title: "实现任务后端"
    }) as { result?: { id?: number } };
    const issue = getIssue(fixture.db, result.result?.id ?? 0);

    expect(issue?.description).toContain("按 PRD 建立服装图片生成 MVP。");
    expect(issue?.description).toContain("PRD 第 6 节定义上传、任务与结果流程。");
    expect(issue?.description).toContain("1. 先固定 API 合同。");
    expect(issue?.description).toContain("1. 任务可从 pending 到 succeeded。");
    expect(issue?.description?.match(/任务可从 pending 到 succeeded。/g)).toHaveLength(1);
    expect(issue?.description).toContain("1. 运行真实 Provider smoke。");
    expect(issue?.description).not.toContain("## 相关证据\n- (none)");
    expect(issue?.description).not.toContain("## 做什么\n- (none)");
    expect(() => actions.createIssueProposal({
      context_pack: { unexpected_section: ["must not disappear"] } as never,
      description: "invalid",
      project_id: fixture.project.id,
      title: "invalid"
    })).toThrow(/unsupported fields: unexpected_section/);
  });

test("creates a detailed triage issue batch with an audited dependency DAG and never enqueues it", async () => {
    const fixture = await openFixture();
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
      issue.description.includes("## 做什么") && !issue.description.includes("## 做什么\n- (none)"))).toBe(true);
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
      project_id: fixture.project.id,
      items: [
        { ...detailedBatchItem("a", "A"), depends_on_refs: ["b"] },
        { ...detailedBatchItem("b", "B"), depends_on_refs: ["a"] }
      ]
    })).toThrow(/dependency graph contains a cycle/);
    expect(listPiActions(fixture.db)).toHaveLength(beforeActionCount);
    expect(listIssues(fixture.db, { projectId: fixture.project.id })).toHaveLength(3);
  });

test("orchestrates role workflows through gated PI actions and issue linkage", async () => {
    const fixture = await openFixture();
    insertAgentProfile(fixture.db, {
      id: "reviewer-codex",
      name: "Reviewer Codex",
      skillIntents: "[\"code-review\"]"
    });
    insertAgentProfile(fixture.db, { id: "reporter-codex", name: "Reporter Codex", skillIntents: "[\"xuanwu\"]" });
    const actions = createPiRunnerActions(fixture.db, { project: fixture.project });
    const issueID = insertIssue(fixture.db, { projectID: fixture.project.id, status: "needs_user", title: "Ready" });

    const recommendation = actions.recommendExecutorProfile({ issue_id: issueID, role: "reviewer" });
    const reporter = actions.createReportWorkflow({ report_type: "nightly", title: "Nightly report" }) as { action_id: string };
    const reviewer = actions.createReviewWorkflow({ target_issue_id: issueID, instructions: "review patch" }) as { action_id: string };
    const escalation = actions.escalateNeedsUser({
      issue_id: issueID,
      reason: "missing production smoke",
      requested_action: "provide smoke window"
    }) as { action_id: string };

    expect(recommendation).toMatchObject({ agent_role: "reviewer", profile_id: "reviewer-codex" });
    expect(listPiActions(fixture.db, { status: "completed" })).toContainEqual(expect.objectContaining({
      action_type: "agent.profile_recommend",
      gate_decision: "execute",
      project_id: fixture.project.id
    }));
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
  });
}
