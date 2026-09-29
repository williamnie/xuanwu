import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { getIssue, listIssueRuns } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { updateIssue } from "../../db/repositories/issueUpdate.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import {
  canonicalWorkspace, isWorkspaceWaitReleased, readWorkspaceWait, recordWorkspaceWait,
  workspaceExecutionBusy, workspaceExecutionEpoch, workspaceWaitInput, workspaceWaitIssueIDs,
  type WaitWorkspace, type WorkspaceWait
} from "../../db/repositories/workspaceWaits.ts";
import { runGit, withGitWorkspaceObservation } from "../run/gitWorkspaceObservation.ts";
import {
  createHumanReviewRequest, HumanReviewConflictError, readIssueDecisionProjection,
  type HumanReviewRequest
} from "./humanReview.ts";

/** 只接受仓库根目录、干净索引/工作树、无进行中 Git 操作的稳定观察。 */
export async function observeWaitWorkspace(cwd: string): Promise<WaitWorkspace | null> {
  return withGitWorkspaceObservation(cwd, async (directory, deadline) => {
    const text = async (...args: string[]) => {
      const result = await runGit(directory, args, deadline);
      return result ? Buffer.from(result.stdout).toString().trim() : null;
    };
    const root = await text("rev-parse", "--show-toplevel");
    const gitDir = await text("rev-parse", "--absolute-git-dir");
    if (!root || !gitDir || canonicalWorkspace(root) !== directory) return null;
    const operations = ["index.lock", "HEAD.lock", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_START", "rebase-apply", "rebase-merge", "sequencer"];
    const busy = () => operations.some(name => existsSync(join(gitDir, name)));
    if (busy()) return null;
    const head = await text("rev-parse", "--verify", "HEAD^{commit}");
    const branch = await text("rev-parse", "--symbolic-full-name", "HEAD");
    if (!head || !branch) return null;
    const index = await text("ls-files", "-v", "-z");
    const stages = await text("ls-files", "--stage", "-z");
    // 稀疏/assume-unchanged 索引及子模块不能仅靠根目录 status 证明干净。
    if (index === null || stages === null || index.split("\0").some(entry => /^[a-zS] /.test(entry))
      || stages.split("\0").some(entry => entry.startsWith("160000 "))) return null;
    const status = () => text("-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
      "status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none");
    if (await status() !== "" || await status() !== "" || busy()) return null;
    if (await text("rev-parse", "--verify", "HEAD^{commit}") !== head
      || await text("rev-parse", "--symbolic-full-name", "HEAD") !== branch) return null;
    return { cwd: directory, head, branch };
  });
}

export async function refreshSafeWorkspaceWaits(db: RunnerDatabase, projectID?: string): Promise<void> {
  for (const id of workspaceWaitIssueIDs(db, projectID)) {
    if (isWorkspaceWaitReleased(db, id) || workspaceExecutionBusy(db, id)) continue;
    const issue = getIssue(db, id)!;
    const project = getProject(db, issue.project_id);
    const request = readIssueDecisionProjection(db, id).request;
    const run = listIssueRuns(db, id).at(-1);
    // 无结构化问题、历史执行或可靠 CWD 时保持旧锁，不从错误文本猜测可释放性。
    if (!project?.cwd.trim() || !request || request.status !== "open" || !run?.ended_at) continue;
    const input = workspaceWaitInput(db, id);
    const epoch = workspaceExecutionEpoch(db, id);
    const workspace = await observeWaitWorkspace(project.cwd);
    if (!workspace) continue;
    db.transaction(() => {
      if (getIssue(db, id)?.status !== "needs_user" || !currentRequest(db, id, request)
        || workspaceWaitInput(db, id) !== input || workspaceExecutionEpoch(db, id) !== epoch
        || workspaceExecutionBusy(db, id) || isWorkspaceWaitReleased(db, id)) return;
      recordWorkspaceWait(db, id, { state: "released", request_id: request.id, revision: request.revision,
        run_id: run.id, input, workspace });
    }).immediate();
  }
}

export type WorkspaceReacquisition = { wait: WorkspaceWait; epoch: string; input: string };

export async function prepareWorkspaceReacquisition(db: RunnerDatabase, issueID: number,
  request: HumanReviewRequest): Promise<WorkspaceReacquisition | null> {
  const wait = readWorkspaceWait(db, issueID);
  if (!wait || wait.state === "consumed") return null;
  if (getIssue(db, issueID)?.status !== "needs_user" || workspaceExecutionBusy(db, issueID, true)) {
    throw new HumanReviewConflictError("工作目录仍有执行或未释放的等待任务，请稍后重新回答");
  }
  const epoch = workspaceExecutionEpoch(db, issueID);
  const input = workspaceWaitInput(db, issueID);
  const project = getProject(db, getIssue(db, issueID)!.project_id)!;
  const workspace = await observeWaitWorkspace(project.cwd);
  const token = { wait, epoch, input };
  assertWorkspaceReacquisition(db, issueID, request, token);
  if (!workspace) throw new HumanReviewConflictError("工作区不干净或无法核验，保持等待；请处理改动后重新回答");
  if (wait.request_id !== request.id || wait.revision !== request.revision || input !== wait.input
    || listIssueRuns(db, issueID).at(-1)?.id !== wait.run_id
    || !sameWorkspace(workspace, wait.workspace)) {
    db.transaction(() => {
      assertWorkspaceReacquisition(db, issueID, request, token);
      renewReview(db, issueID, request, workspace);
    }).immediate();
    throw new HumanReviewConflictError("工作区或输入版本已变化，原回答已过期；请刷新并重新确认新的审批请求");
  }
  return token;
}

export function assertWorkspaceReacquisition(db: RunnerDatabase, issueID: number,
  request: HumanReviewRequest, token: WorkspaceReacquisition | null): void {
  if (!token) return;
  if (getIssue(db, issueID)?.status !== "needs_user" || !currentRequest(db, issueID, request)
    || workspaceExecutionEpoch(db, issueID) !== token.epoch || workspaceExecutionBusy(db, issueID, true)
    || workspaceWaitInput(db, issueID) !== token.input
    || JSON.stringify(readWorkspaceWait(db, issueID)) !== JSON.stringify(token.wait)) {
    throw new HumanReviewConflictError("工作目录或审批请求在核验期间变化，请稍后重新回答");
  }
}

/** 必须与回答落库及 in_progress 抢占在同一 IMMEDIATE 事务内。 */
export function commitWorkspaceReacquisition(db: RunnerDatabase, issueID: number,
  token: WorkspaceReacquisition | null): void {
  if (!token) return;
  recordWorkspaceWait(db, issueID, { ...token.wait, state: "acquired", input: workspaceWaitInput(db, issueID) });
}

/** 回答之后、实际 Provider 调用之前再次核验；重启也读取同一份持久化凭据。 */
export async function validateReacquiredWorkspace(db: RunnerDatabase, issueID: number, runID: string): Promise<boolean> {
  const wait = readWorkspaceWait(db, issueID);
  if (!wait || wait.state === "consumed") return true;
  const project = getProject(db, getIssue(db, issueID)!.project_id)!;
  const epoch = workspaceExecutionEpoch(db, issueID);
  const workspace = await observeWaitWorkspace(project.cwd);
  return db.transaction(() => {
    const run = listIssueRuns(db, issueID).at(-1);
    if (getIssue(db, issueID)?.status !== "in_progress" || run?.id !== runID || run.ended_at) return false;
    if (wait.state === "acquired" && workspace && sameWorkspace(workspace, wait.workspace)
      && wait.input === workspaceWaitInput(db, issueID) && workspaceExecutionEpoch(db, issueID) === epoch
      && !workspaceExecutionBusy(db, issueID, true, runID)
      && JSON.stringify(readWorkspaceWait(db, issueID)) === JSON.stringify(wait)) {
      recordWorkspaceWait(db, issueID, { ...wait, state: "consumed" });
      return true;
    }
    // 此 Run 尚未调用 Provider；撤销准备并恢复人类确认，不强行解锁、不处置文件。
    if (!closeUnstartedRun(db, issueID, runID)) return false;
    updateIssue(db, issueID, { status: "needs_user" });
    const request = readIssueDecisionProjection(db, issueID).request;
    if (request) renewReview(db, issueID, request, null);
    recordIssueEvent(db, issueID, "issue.workspace_resume_invalidated.v1", { run_id: runID, request_id: wait.request_id });
    return false;
  }).immediate();
}

/** 启动恢复不把已重新抢占但尚未调用 Provider 的 Run 自动重新排队。 */
export function restoreUnstartedWorkspaceWait(db: RunnerDatabase, issueID: number): boolean {
  if (!readWorkspaceWait(db, issueID)) return false;
  return db.transaction(() => {
    const run = listIssueRuns(db, issueID).at(-1);
    if (getIssue(db, issueID)?.status !== "in_progress" || !run || run.ended_at
      || run.provider_session_id || run.provider_turn_id) return false;
    if (!closeUnstartedRun(db, issueID, run.id)) return false;
    updateIssue(db, issueID, { status: "needs_user" });
    const request = readIssueDecisionProjection(db, issueID).request;
    if (request) renewReview(db, issueID, request, null);
    recordIssueEvent(db, issueID, "issue.workspace_resume_invalidated.v1", {
      run_id: run.id, reason: "restart_before_provider_start_requires_reconfirmation"
    });
    return true;
  }).immediate();
}

function closeUnstartedRun(db: RunnerDatabase, issueID: number, runID: string): boolean {
  // 准备取消是 Run 机械事实；不能将 needs_user 写入 Attempt 的终态映射。
  return db.sqlite.query(`update issue_runs set status='cancelled', ended_at=?,
    exit_reason='workspace_resume_invalidated', error='' where id=? and issue_id=?
    and ended_at='' and provider_session_id='' and provider_turn_id='' returning id`)
    .get(new Date().toISOString(), runID, issueID) !== null;
}

function renewReview(db: RunnerDatabase, issueID: number, request: HumanReviewRequest,
  workspace: WaitWorkspace | null): void {
  const fresh = createHumanReviewRequest(db, issueID, { ...request,
    consequences: `${request.consequences}\n工作区或输入版本已变化，必须基于当前版本重新确认。`.trim() });
  recordIssueEvent(db, issueID, "issue.workspace_answer_expired.v1", {
    old_request_id: request.id, old_revision: request.revision, request_id: fresh.id, revision: fresh.revision
  });
  if (workspace) recordWorkspaceWait(db, issueID, { state: "released", request_id: fresh.id,
    revision: fresh.revision, input: workspaceWaitInput(db, issueID), workspace,
    run_id: listIssueRuns(db, issueID).at(-1)!.id });
}

function currentRequest(db: RunnerDatabase, issueID: number, request: HumanReviewRequest): boolean {
  const current = readIssueDecisionProjection(db, issueID);
  return current.owner === "human" && current.request?.status === "open"
    && current.request.id === request.id && current.request.revision === request.revision;
}

function sameWorkspace(a: WaitWorkspace, b: WaitWorkspace): boolean {
  return a.cwd === b.cwd && a.head === b.head && a.branch === b.branch;
}
