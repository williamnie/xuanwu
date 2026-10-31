import type { RunnerDatabase } from "../../db/database.ts";
import { listIssueEvents, recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { type IssueRun } from "../../db/repositories/issues.ts";
import { captureGitWorkspaceBaseline, withGitWorkspaceObservation } from "../run/gitWorkspaceObservation.ts";
import type { CapturedGitWorkspaceBaseline } from "../evidence/runGitWorkspaceBaseline.ts";
import { recordExecutionEvidenceContext } from "./executionEvidenceContext.ts";
import { cleanString, nonNegativeInteger, objectValue } from "../../util/values.ts";
import {
  type CompletionCardGit,
  COMPLETION_GIT_OBSERVATION_EVENT_TYPE,
  COMPLETION_GIT_OBSERVATION_CONTRACT,
  gitObjectID,
  gitText,
  gitNullList,
  MAX_CHANGED_FILES,
  parseJson,
  MAX_COMMITS,
  stringArray,
  type CommandObservation
} from "./completionCardModel.ts";

export async function recordCompletionGitObservation(
  db: RunnerDatabase,
  input: { issue_id: number; observed_at: string; repository: string; run: IssueRun }
): Promise<void> {
  let summary: CompletionCardGit;
  try { summary = await liveGitSummary(input.repository, input.run, input.observed_at, true); }
  catch {
    // 观察失败不能阻止 Provider 终态归档，也不能写出假 clean 的观察事实。
    recordIssueEvent(db, input.issue_id, "issue.completion_git_observation_failed.v1", {
      run_id: input.run.id, observed_at: input.observed_at, reason: "Git workspace observation unavailable or exceeded its budget"
    });
    return;
  }
  const { source: _source, ...observation } = summary;
  recordIssueEvent(db, input.issue_id, COMPLETION_GIT_OBSERVATION_EVENT_TYPE, {
    observation: { ...observation, contract: COMPLETION_GIT_OBSERVATION_CONTRACT, run_id: input.run.id }
  });
  recordExecutionEvidenceContext(db, input.issue_id, input.run.id, "terminal");
}

export async function gitRunSummary(
  repository: string,
  run: IssueRun,
  events: ReturnType<typeof listIssueEvents>
): Promise<CompletionCardGit> {
  const observed = terminalGitObservation(events, run);
  if (observed) return observed;
  // Completion Card 只针对最新的已结束 Run 构建。若终态观察事件因异常路径缺失，
  // 必须读取当前工作区作为降级事实，不能把未提交修改伪造为 clean/无改动。
  return liveGitSummary(repository, run, run.ended_at);
}

export async function liveGitSummary(repository: string, run: IssueRun, observedAt: string, includeWorkspace = false): Promise<CompletionCardGit & {
  workspace_snapshot?: CapturedGitWorkspaceBaseline;
}> {
  const baseline = gitObjectID(run.git_base_revision) ? run.git_base_revision.toLowerCase() : "";
  const summary = await withGitWorkspaceObservation(repository, async (cwd, deadline) => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const head = await gitText(cwd, ["rev-parse", "--verify", "HEAD"], deadline, baseline !== "");
      const requireSuccess = gitObjectID(head) || baseline !== "";
      const diffBase = gitObjectID(baseline) ? baseline : gitObjectID(head) ? head : "";
      const tracked = diffBase === "" ? [] : await gitNullList(cwd, ["diff", "--name-only", "-z", diffBase, "--"], deadline, requireSuccess);
      const untracked = await gitNullList(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"], deadline, requireSuccess);
      const changedFiles = [...new Set([...tracked, ...untracked])].sort().slice(0, MAX_CHANGED_FILES);
      const workingTreeDirty = (await gitText(cwd, ["status", "--porcelain=v1", "--untracked-files=all"], deadline, requireSuccess)) !== "";
      const commits = await gitCommitSummary(cwd, baseline, head, deadline);
      const workspace = includeWorkspace && gitObjectID(head) ? await captureGitWorkspaceBaseline(cwd, deadline) : null;
      if (workspace && workspace.base_revision !== head) continue;
      const stableHead = await gitText(cwd, ["rev-parse", "--verify", "HEAD"], deadline, requireSuccess);
      if (stableHead !== head) continue;
      return {
        baseline_revision: baseline, changed_files: changedFiles, commit_count: commits.length, commits,
        final_revision: gitObjectID(head) ? head : "",
        has_diff: changedFiles.length > 0 || (gitObjectID(baseline) && gitObjectID(head) && baseline !== head),
        observed_at: observedAt, source: "session_observation" as const, working_tree_dirty: workingTreeDirty,
        ...(workspace ? { workspace_snapshot: workspace } : {})
      };
    }
    throw new Error("Git HEAD changed repeatedly during workspace observation");
  });
  if (!summary) throw new Error("Git workspace observation timed out while waiting for capacity");
  return summary;
}

function terminalGitObservation(
  events: ReturnType<typeof listIssueEvents>,
  run: IssueRun
): CompletionCardGit | null {
  for (const event of [...events].reverse()) {
    if (event.type !== COMPLETION_GIT_OBSERVATION_EVENT_TYPE) continue;
    const observation = objectValue(objectValue(parseJson(event.payload)).observation);
    if (observation.contract !== COMPLETION_GIT_OBSERVATION_CONTRACT || cleanString(observation.run_id) !== run.id) continue;
    const commits = Array.isArray(observation.commits) ? observation.commits.flatMap((value) => {
      const item = objectValue(value);
      const revision = cleanString(item.revision);
      const subject = cleanString(item.subject);
      const timestamp = cleanString(item.timestamp);
      return gitObjectID(revision) && subject !== "" && Number.isFinite(Date.parse(timestamp))
        ? [{ revision, subject, timestamp }]
        : [];
    }).slice(0, MAX_COMMITS) : [];
    return {
      baseline_revision: gitObjectID(cleanString(observation.baseline_revision)) ? cleanString(observation.baseline_revision) : "",
      changed_files: stringArray(observation.changed_files).slice(0, MAX_CHANGED_FILES),
      commit_count: nonNegativeInteger(observation.commit_count),
      commits,
      final_revision: gitObjectID(cleanString(observation.final_revision)) ? cleanString(observation.final_revision) : "",
      has_diff: observation.has_diff === true,
      observed_at: cleanString(observation.observed_at) || event.created_at,
      source: "terminal_observation",
      working_tree_dirty: observation.working_tree_dirty === true,
      ...(typeof objectValue(observation.workspace_snapshot).snapshot_sha256 === "string"
        ? { workspace_snapshot_ref: `run-git-snapshot:${run.id}:${objectValue(observation.workspace_snapshot).snapshot_sha256}` } : {})
    };
  }
  return null;
}

async function gitCommitSummary(repository: string, baseline: string, final: string, deadline: number): Promise<CompletionCardGit["commits"]> {
  if (!gitObjectID(baseline) || !gitObjectID(final)) return [];
  const fields = await gitNullList(repository, [
    "log", `--max-count=${MAX_COMMITS}`, "--format=%H%x00%cI%x00%s%x00", "-z", `${baseline}..${final}`
  ], deadline, true);
  const commits: CompletionCardGit["commits"] = [];
  for (let index = 0; index + 2 < fields.length && commits.length < MAX_COMMITS; index += 3) {
    commits.push({ revision: fields[index]!, timestamp: fields[index + 1]!, subject: fields[index + 2]! });
  }
  return commits;
}

export function completionWarnings(run: IssueRun, commands: CommandObservation[], changedFiles: string[]): string[] {
  const warnings: string[] = [];
  if (commands.length === 0) warnings.push("No terminal command observations were found for the current Run.");
  if (run.git_base_revision !== "" && changedFiles.length === 0) {
    warnings.push("No committed file changes were attributable between the Run baseline and its end time.");
  }
  return warnings;
}
