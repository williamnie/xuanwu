import { join } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import type { AgentSession } from "../../db/repositories/agentSessions.ts";
import { listIssues } from "../../db/repositories/issues.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { createHumanReviewRequest } from "../../domain/review/humanReview.ts";
import { type PiRunnerActionLayer } from "./runnerActions.ts";
import { insertIssue as insertIssueRow, insertProject, useTestDatabase } from "../../testing/harness.ts";

export const HUMAN_REVIEW = {
  acceptance_summary: ["Node/TypeScript/PostgreSQL", "OIDC"],
  evidence_refs: ["docs/architecture/0001.md"],
  excluded_scope: ["安装数据库"],
  issue_id: 815,
  kind: "decision",
  question: "是否接受这些技术和产品取舍？",
  recommendation: "接受"
};

export const HUMAN_REVIEW_RESPONSE = {
  action: "accept",
  comment: "真实 smoke 后续由用户手动执行",
  issue_id: 827,
  review_request_id: "human-review-827",
  review_revision: 1
};

export const BATCH = { items: [detailedBatchItem("foundation", "建立工程基线"), detailedBatchItem("ui", "实现前端流程")], project_id: "demo" };

export const VALID_ARGUMENTS: Array<[string, Record<string, unknown>]> = [
  ["issue_list", { limit: 3, scope: "global", status: "todo" }],
  ["issue_read", { id: 1 }],
  ["issue_status_summary", { project_id: "demo", scope: "project", status: "todo" }],
  ["issue_execution_status", { id: 1 }],
  ["issue_cancel", { issue_ids: [812, 813, 814], rationale: "不再做" }],
  ["issue_delete", { issue_ids: [812, 813], reason: "用户确认永久删除" }],
  ["issue_status_update", { issue_ids: [812, 813, 814], reason: "用户要求重新排队", status: "todo" }],
  ["issue_acceptance_request", { issue_id: 1, rationale: "补齐交付记录" }],
  ["human_review_request_create", HUMAN_REVIEW],
  ["human_review_response", HUMAN_REVIEW_RESPONSE],
  ["issue_completion_watch_create", { issue_ids: [7, 8], note: "提醒我", project_id: "demo", target_channel: "feishu", target_chat_id: "oc_group" }],
  ["issue_completion_watch_list", { project_id: "demo", status: "active" }],
  ["issue_completion_watch_cancel", { reason: "done", watch_id: "watch-1" }],
  ["issue_enqueue_batch_triage", { issue_ids: [387, 388], project_id: "demo", user_phrase: "把 #387-#388 都开始做" }],
  ["issue_enqueue_batch_triage", { user_phrase: "这些都开始" }],
  ["issue_enqueue_next_triage", { project_id: "demo" }],
  ["runner_settings_read", {}],
  ["runner_settings_update", { codex_server_mode: "app", max_parallel_projects: 3, reason: "修改运行配置" }],
  ["system_restart", { reason: "应用配置" }],
  ["agent_profile_recommend", { issue_id: 1, role: "executor" }],
  ["issue_state_diagnose", { project_id: "demo" }],
  ["issue_state_repair_proposal", { diagnosis_code: "done_missing_verification_evidence", issue_id: 1, operation: "patch_status" }],
  ["issue_schedule_enqueue", { issue_id: 1, next_run_at: "2999-01-01T00:00:00.000Z" }],
  ["repo_search", { query: "Accordion", max_results: 3 }],
  ["repo_read_excerpt", { path: "src/App.tsx", start_line: 2, max_lines: 4 }],
  ["repo_tree", { path: "src", max_depth: 2 }],
  ["issue_create_proposal", { description: "Missing current-turn project", title: "Must ask first" }],
  ["session_steer_proposal", { session_key: "codex:thread-1", prompt: "adjust" }]
];

export const INVALID_ARGUMENTS: Array<[string, Record<string, unknown>]> = [
  ["issue_create_batch_proposal", { items: [{ ...detailedBatchItem("foundation", "建立工程基线"), evidence: [] }, detailedBatchItem("ui", "实现前端流程")] }],
  ["issue_read", { id: "bad" }],
  ["issue_read", { id: 1, unexpected: true }],
  ["issue_enqueue_batch_triage", { max_count: 3, user_phrase: "这些都开始" }],
  ["session_steer_proposal", { session_key: "codex:thread-1", prompt: " " }]
];

export const DELEGATED_CALLS: Array<[string, keyof PiRunnerActionLayer, Record<string, unknown>]> = [
  ["agent_profile_recommend", "recommendExecutorProfile", { issue_id: 1, role: "executor" }],
  ["issue_list", "listIssues", { limit: 3, status: "todo" }],
  ["issue_read", "readIssue", { id: 7 }],
  ["issue_cancel", "cancelIssues", { issue_ids: [812, 813, 814], rationale: "不再做" }],
  ["issue_status_update", "updateIssueStatuses", { issue_ids: [812, 813, 814], reason: "用户要求重新排队", status: "todo" }],
  ["issue_create_batch_proposal", "createIssueBatchProposal", BATCH],
  ["issue_status_summary", "issueStatusSummary", { status: "todo" }],
  ["issue_execution_status", "issueExecutionStatus", { id: 7 }],
  ["issue_completion_watch_create", "createIssueCompletionWatch", { issue_ids: [7, 8], note: "提醒我", project_id: "demo", target_channel: "feishu" }],
  ["issue_completion_watch_list", "listIssueCompletionWatches", { project_id: "demo", status: "active" }],
  ["issue_completion_watch_cancel", "cancelIssueCompletionWatch", { reason: "user_cancel", watch_id: "watch-1" }],
  ["issue_enqueue_batch_triage", "enqueueBatchTriageIssues", { issue_ids: [387, 388], project_id: "demo", user_phrase: "把 #387-#388 都开始做" }],
  ["issue_enqueue_next_triage", "enqueueNextTriageIssue", { project_id: "demo" }],
  ["issue_acceptance_request", "requestIssueAcceptanceAction", { issue_id: 7, rationale: "补齐交付记录" }],
  ["human_review_request_create", "createHumanReviewRequest", HUMAN_REVIEW],
  ["human_review_response", "respondToHumanReview", HUMAN_REVIEW_RESPONSE],
  ["issue_state_diagnose", "diagnoseIssueState", { project_id: "demo" }],
  ["issue_state_repair_proposal", "createIssueStateRepairProposal", { diagnosis_code: "done_missing_verification_evidence", issue_id: 1, operation: "patch_status" }],
  ["repo_search", "searchRepo", { query: "Accordion", max_results: 3 }],
  ["repo_read_excerpt", "readRepoExcerpt", { path: "src/App.tsx" }],
  ["repo_tree", "readRepoTree", { path: "src" }],
  ["issue_schedule_enqueue", "scheduleIssueEnqueue", { issue_id: 3, next_run_at: "2999-01-01T00:00:00.000Z" }],
  ["session_steer_proposal", "createSessionSteerProposal", { session_key: "codex:thread-1", prompt: "adjust" }]
];

export const openDatabase = useTestDatabase("xuanwu-bun-pi-action-tools-");

export function projectIDs(result: unknown): string[] {
  return (result as { items: Project[] }).items.map((project) => project.id);
}

export function sessionKeys(result: unknown): string[] {
  return (result as { items: AgentSession[] }).items.map((session) => session.session_key);
}

export function fakeActions(calls: Array<[string, unknown]>): PiRunnerActionLayer {
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
    diagnoseIssueState: record("diagnoseIssueState"),
    escalateNeedsUser: record("escalateNeedsUser"),
    createSessionSteerProposal: record("createSessionSteerProposal"),
    enqueueBatchTriageIssues: record("enqueueBatchTriageIssues"),
    enqueueNextTriageIssue: record("enqueueNextTriageIssue"),
    enqueueIssueProposal: record("enqueueIssueProposal"),
    cancelIssueCompletionWatch: record("cancelIssueCompletionWatch"),
    listIssues: record("listIssues"),
    listAgentCatalog: record("listAgentCatalog"),
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

export function detailedBatchItem(ref: string, title: string) {
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

export function insertAgentProfile(
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

export async function openFixture(): Promise<{ db: RunnerDatabase; project: Project }> {
  const db = await openDatabase();
  insertProject(db, "demo", { name: "Demo", cwd: join(db.path, "..", "..", "project"), sort_order: 1 });
  return { db, project: getProject(db, "demo")! };
}

export function insertIssue(
  db: RunnerDatabase,
  input: { createdAt?: string; description?: string; priority?: number; projectID: string; status: string; title: string }
): number {
  const createdAt = input.createdAt ?? "2026-01-01T00:00:00Z";
  return insertIssueRow(db, {
    created_at: createdAt, description: input.description ?? "", priority: input.priority ?? 0,
    project_id: input.projectID, status: input.status, title: input.title, updated_at: createdAt
  });
}

export function insertAgentSession(db: RunnerDatabase, input: { projectID: string; role?: string; sessionKey: string }): void {
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
