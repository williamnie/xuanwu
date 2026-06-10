import { getProject } from "../db/repositories/projects.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { issueTimestamp } from "../db/repositories/issueCreate.ts";
import { updateIssueRuntime } from "../db/repositories/issueRuns.ts";
import { failIssueExecution } from "./statusGate.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { Issue } from "../db/repositories/issues.ts";
import type { Project } from "../db/repositories/projects.ts";
import type { RunnerDatabase } from "../db/database.ts";
import type { ExecutorProvider, ExecutorProviderId, ProviderRecoveryInput, ProviderRunResult, SessionRef } from "../providers/types.ts";

export type RecoveryInput = {
  database: RunnerDatabase;
  providers: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
};

export type RecoveryResult = { failed: number; recovered: number };

const STATUS_IN_PROGRESS = "in_progress";

export async function recoverInProgressIssues(input: RecoveryInput): Promise<RecoveryResult> {
  const result = { failed: 0, recovered: 0 };
  const issues = listIssues(input.database, { status: STATUS_IN_PROGRESS });
  for (const issue of issues) {
    const recovered = await recoverIssue(input, issue);
    recovered ? result.recovered += 1 : result.failed += 1;
  }
  return result;
}

async function recoverIssue(input: RecoveryInput, issue: Issue): Promise<boolean> {
  const session = recoverableSession(issue);
  if (!session) {
    markRecoveryFailed(input.database, issue.id, "missing provider_session_id; issue marked failed after restart");
    return false;
  }
  const provider = input.providers[session.provider];
  if (!provider?.recover) {
    markRecoveryFailed(input.database, issue.id, `provider ${session.provider} does not support recovery`);
    return false;
  }
  const project = getProject(input.database, issue.project_id);
  if (!project) {
    markRecoveryFailed(input.database, issue.id, `project ${issue.project_id} not found`);
    return false;
  }
  recordRecoveryEvent(input.database, issue.id, "issue.recovery_started", recoveryPayload(session));
  try {
    const run = await provider.recover(recoveryInput(project, issue, session));
    persistRecoveredRuntime(input.database, issue.id, run);
    recordRecoveryEvent(input.database, issue.id, "issue.recovery_turn_started", recoveryPayload(run.session ?? session));
    return true;
  } catch (error) {
    markRecoveryFailed(input.database, issue.id, error);
    return false;
  }
}

function recoveryInput(project: Project, issue: Issue, session: SessionRef): ProviderRecoveryInput {
  const serviceTier = recoveryServiceTier(project, issue);
  return {
    issueId: issue.id,
    projectId: project.id,
    cwd: project.cwd,
    prompt: recoveryPrompt(project, issue),
    model: project.model,
    approvalPolicy: project.approval_policy,
    serviceTier: serviceTier.value,
    serviceTierSource: serviceTier.source,
    sandbox: project.sandbox,
    session
  };
}

function recoveryServiceTier(project: Project, issue: Issue): { source: string; value: string } {
  const issueTier = cleanString(issue.service_tier);
  if (issueTier !== "") return { source: "issue", value: issueTier };
  const projectTier = cleanString(project.default_service_tier);
  if (projectTier !== "") return { source: "project", value: projectTier };
  return { source: "standard", value: "" };
}

function recoverableSession(issue: Issue): SessionRef | null {
  const run = issue.latest_run;
  const provider = run?.provider === "codex" || run?.provider === "claude" || run?.provider === "fake-execution-only"
    ? run.provider
    : "codex";
  const sessionId = run?.provider_session_id || issue.codex_thread_id;
  const turnId = run?.provider_turn_id || issue.codex_turn_id;
  if (sessionId === "") return null;
  return { provider, sessionId, ...(turnId === "" ? {} : { turnId }) };
}

function persistRecoveredRuntime(db: RunnerDatabase, issueID: number, result: ProviderRunResult): void {
  if (!result.session) return;
  updateIssueRuntime(db, issueID, {
    provider: result.session.provider,
    provider_session_id: result.session.sessionId,
    provider_turn_id: result.session.turnId ?? "",
    metadata: { run_id: result.runId, recovery: true }
  });
}

function markRecoveryFailed(db: RunnerDatabase, issueID: number, error: unknown): void {
  failIssueExecution(db, issueID, error);
  recordRecoveryEvent(db, issueID, "issue.recovery_failed", {
    error: redactSensitiveText(error instanceof Error ? error.message : String(error))
  });
}

function recordRecoveryEvent(db: RunnerDatabase, issueID: number, type: string, payload: Record<string, string>): void {
  db.sqlite.run(
    `insert into issue_events (issue_id, type, payload, created_at) values (?, ?, ?, ?)`,
    [issueID, type, JSON.stringify(payload), issueTimestamp()]
  );
}

function recoveryPayload(session: SessionRef): Record<string, string> {
  return { provider: session.provider, session_id: session.sessionId, turn_id: session.turnId ?? "" };
}

function recoveryPrompt(project: Project, issue: Issue): string {
  return `服务重启后继续处理 issue #${issue.id}。\n\n项目路径：${project.cwd}\n\n在继续前必须先检查当前工作区、issue 状态和最近日志，避免重复已完成操作。完成后仍然必须执行 codex-issue-runner issue update 回写最终状态。`;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
