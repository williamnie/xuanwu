import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { RunnerDatabase } from "../database.ts";
import { digest } from "../../domain/acceptance/executionEvidenceContext.ts";
import { getIssue, listIssueRuns } from "./issues.ts";
import { getProject } from "./projects.ts";
import { listIssueEvents, recordIssueEvent } from "./issueEvents.ts";

export const WORKSPACE_WAIT_EVENT = "issue.workspace_wait.v1";
// idle 是 Provider 明确报告的静止状态；仍须同时证明 Run/Attempt 已结束。
const QUIESCENT_SESSION_STATUSES_SQL = "'completed','succeeded','failed','cancelled','interrupted','closed','idle'";
export type WaitWorkspace = { cwd: string; head: string; branch: string };
export type WorkspaceWait = {
  state: "released" | "acquired" | "consumed";
  request_id: string;
  revision: number;
  run_id: string;
  input: string;
  workspace: WaitWorkspace;
};

export function canonicalWorkspace(cwd: string): string {
  try { return realpathSync(cwd.trim()); } catch { return resolve(cwd.trim()); }
}

export function workspaceWaitIssueIDs(db: RunnerDatabase, projectID?: string): number[] {
  const project = projectID ? getProject(db, projectID) : null;
  return db.sqlite.query<{ id: number; project_id: string; cwd: string }, []>(`
    select i.id,i.project_id,p.cwd from issues i join projects p on p.id=i.project_id
    where i.status='needs_user' order by i.id
  `).all().filter(row => !projectID || row.project_id === projectID
    || (project?.cwd.trim() && row.cwd.trim() && canonicalWorkspace(row.cwd) === canonicalWorkspace(project.cwd)))
    .map(row => row.id);
}

export function readWorkspaceWait(db: RunnerDatabase, issueID: number): WorkspaceWait | null {
  const event = listIssueEvents(db, issueID, { types: [WORKSPACE_WAIT_EVENT], limit: 1 }).at(-1);
  if (!event) return null;
  const value = JSON.parse(event.payload) as WorkspaceWait;
  if (!["released", "acquired", "consumed"].includes(value.state) || !value.request_id
    || !Number.isSafeInteger(value.revision) || !value.input || !value.workspace?.cwd
    || !value.workspace.head || !value.workspace.branch || !value.run_id) {
    throw new Error("Invalid workspace wait certificate; directory remains protected");
  }
  return value;
}

export function recordWorkspaceWait(db: RunnerDatabase, issueID: number, wait: WorkspaceWait): void {
  recordIssueEvent(db, issueID, WORKSPACE_WAIT_EVENT, wait);
}

/** 释放凭据只属于原请求和原 Run；工作区随后可由其他任务修改，不能据此认领这些改动。 */
export function isWorkspaceWaitReleased(db: RunnerDatabase, issueID: number): boolean {
  const wait = readWorkspaceWait(db, issueID);
  const issue = getIssue(db, issueID);
  const project = issue && getProject(db, issue.project_id);
  if (!wait || wait.state !== "released" || issue?.status !== "needs_user" || !project
    || canonicalWorkspace(project.cwd) !== wait.workspace.cwd
    || listIssueRuns(db, issueID).at(-1)?.id !== wait.run_id
    || issueHasUnfinishedExecution(db, issueID)) return false;
  const request = listIssueEvents(db, issueID, { types: ["issue.human_review_requested.v1"], limit: 1 }).at(-1);
  const payload = request ? JSON.parse(request.payload) : null;
  return payload?.id === wait.request_id && payload?.revision === wait.revision;
}

export function workspaceWaitInput(db: RunnerDatabase, issueID: number): string {
  const issue = getIssue(db, issueID);
  const project = issue && getProject(db, issue.project_id);
  if (!issue || !project) throw new Error("Workspace wait Issue/Project missing");
  const profile = issue.agent_profile_id || project.default_agent_profile_id;
  const humanInput = db.sqlite.query(`select id,payload from issue_events where issue_id=?
    and type in ('issue.comment','issue.human_review_answered.v1') order by id desc limit 1`).get(issueID);
  return digest({
    issue: { title: issue.title, description: issue.description, source_excerpt: issue.source_excerpt,
      source_session_id: issue.source_session_id, source_turn_id: issue.source_turn_id,
      workflow: issue.workflow_snapshot_json, profile, tier: issue.service_tier,
      skills: [issue.required_skill_intents, issue.recommended_skill_intents],
      mcp: [issue.required_mcp_capabilities, issue.recommended_mcp_capabilities], humanInput },
    project: { id: project.id, cwd: canonicalWorkspace(project.cwd), provider: project.provider,
      config: project.provider_config_json, model: project.model, policy: project.execution_policy_json,
      approval: project.approval_policy, sandbox: project.sandbox, tier: project.default_service_tier,
      skills: project.default_skill_policy, mcp: project.default_mcp_policy },
    profile: profile ? db.sqlite.query("select * from agent_profiles where id=?").get(profile) : null
  });
}

function scopeProjects(db: RunnerDatabase, issueID: number): string[] {
  const issue = getIssue(db, issueID);
  const project = issue && getProject(db, issue.project_id);
  if (!project) throw new Error("Workspace wait Project missing");
  const cwd = canonicalWorkspace(project.cwd);
  return db.sqlite.query<{ id: string; cwd: string }, []>("select id,cwd from projects").all()
    .filter(row => row.id === project.id || (row.cwd.trim() && canonicalWorkspace(row.cwd) === cwd))
    .map(row => row.id);
}

/** 与 Git 异步观察前后的版本对照，捕获观察期间已经开始又结束的竞争执行。 */
export function workspaceExecutionEpoch(db: RunnerDatabase, issueID: number): string {
  return digest(scopeProjects(db, issueID).map(id => ({
    issues: db.sqlite.query("select id,status,updated_at from issues where project_id=? order by id").all(id),
    runs: db.sqlite.query(`select r.id,r.status,r.started_at,r.ended_at,r.provider_session_id,r.provider_turn_id
      from issue_runs r join issues i on i.id=r.issue_id
      where i.project_id=? order by r.id`).all(id),
    attempts: db.sqlite.query(`select a.attempt_id,a.revision,a.status,a.ended_at,a.updated_at
      from run_attempts a join issue_runs r on r.id=a.issue_run_id
      join issues i on i.id=r.issue_id where i.project_id=? order by a.attempt_id`).all(id),
    sessions: db.sqlite.query(`select s.session_key,s.status,s.updated_at from agent_sessions s left join issues i on i.id=s.issue_id
      where s.project_id=? or i.project_id=? order by s.session_key`).all(id, id)
  })));
}

function issueHasUnfinishedExecution(db: RunnerDatabase, issueID: number): boolean {
  return !!db.sqlite.query("select 1 from issue_runs where issue_id=? and ended_at='' limit 1").get(issueID)
    || !!db.sqlite.query(`select 1 from run_attempts a join issue_runs r on r.id=a.issue_run_id
      where r.issue_id=? and (a.ended_at='' or a.status is null or a.status in ('created','running')) limit 1`).get(issueID)
    || !!db.sqlite.query(`select 1 from agent_sessions where issue_id=?
      and status not in (${QUIESCENT_SESSION_STATUSES_SQL}) limit 1`).get(issueID);
}

export function workspaceExecutionBusy(db: RunnerDatabase, issueID: number, protectWaits = false,
  ownReservedRun = ""): boolean {
  for (const projectID of scopeProjects(db, issueID)) {
    const issues = db.sqlite.query<{ id: number; status: string }, [string]>(
      "select id,status from issues where project_id=?"
    ).all(projectID);
    for (const issue of issues) {
      if (issue.id !== issueID && (issue.status === "in_progress"
        || (protectWaits && issue.status === "needs_user" && !isWorkspaceWaitReleased(db, issue.id)))) return true;
      if (db.sqlite.query(`select 1 from issue_runs where issue_id=? and ended_at='' and id<>? limit 1`)
        .get(issue.id, ownReservedRun)) return true;
      if (db.sqlite.query(`select 1 from run_attempts a join issue_runs r on r.id=a.issue_run_id
        where r.issue_id=? and r.id<>?
          and (a.ended_at='' or a.status is null or a.status in ('created','running')) limit 1`)
        .get(issue.id, ownReservedRun)) return true;
    }
    if (db.sqlite.query(`select 1 from agent_sessions s left join issues i on i.id=s.issue_id
      where (s.project_id=? or i.project_id=?)
      and s.status not in (${QUIESCENT_SESSION_STATUSES_SQL}) limit 1`)
      .get(projectID, projectID)) return true;
  }
  return false;
}

/** 所有物化入口共享此检查，retry/PI 续跑也不能绕过人工回答的重新绑定。 */
export function assertWorkspaceWaitCanStart(db: RunnerDatabase, issueID: number): void {
  const wait = readWorkspaceWait(db, issueID);
  if (!wait || wait.state === "consumed") return;
  if (wait.state !== "acquired"
    || listIssueRuns(db, issueID).at(-1)?.id !== wait.run_id
    || workspaceExecutionBusy(db, issueID, true)) {
    throw new Error("Workspace wait requires a current human answer and exclusive directory reacquisition");
  }
}

/** steer / Run resume 不能替代已释放目录的人工回答与准备阶段。 */
export function assertWorkspaceWaitSessionControl(db: RunnerDatabase, provider: string, sessionID: string): void {
  const rows = db.sqlite.query<{ issue_id: number }, [string, string, string, string]>(`
    select issue_id from issue_runs where provider=? and provider_session_id=?
    union select issue_id from agent_sessions where provider=? and provider_session_id=? and issue_id>0
  `).all(provider, sessionID, provider, sessionID);
  for (const { issue_id: issueID } of rows) {
    const wait = readWorkspaceWait(db, issueID);
    if (!wait) continue;
    const run = listIssueRuns(db, issueID).at(-1);
    if (wait.state !== "consumed" || getIssue(db, issueID)?.status !== "in_progress"
      || !run || run.ended_at || run.provider !== provider || run.provider_session_id !== sessionID) {
      throw new Error("Workspace wait requires human review and a prepared current Run before Session control");
    }
  }
}
