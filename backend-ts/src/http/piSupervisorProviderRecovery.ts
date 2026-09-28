import { getIssue } from "../db/repositories/issues.ts";
import { getProject } from "../db/repositories/projects.ts";
import { resolveExecutorSelection } from "../pi/agentOrchestration.ts";
import { recoverIssueWithProvider } from "../runner/providerRuntime.ts";
import type { ExecutorProvider, SessionMessageResult, SessionRef } from "../providers/types.ts";
import type { SupervisorDispatchContext } from "./piSupervisorActionDispatch.ts";

/** 复用正常 Issue 执行的证据、权限及终态处理，不能用普通聊天消息旁路续跑。 */
export async function recoverSupervisorIssue(
  context: SupervisorDispatchContext,
  provider: ExecutorProvider,
  input: { issueID: number; runID: string; sessionID: string; previousTurnID: string; prompt: string },
  onStarted: (result: SessionMessageResult) => void
): Promise<SessionMessageResult> {
  const issue = getIssue(context.database, input.issueID);
  const project = issue && getProject(context.database, issue.project_id);
  if (!issue || !project || !provider.recover) throw new Error("managed provider recovery is unavailable");
  const selection = resolveExecutorSelection(context.database, project, issue);
  let started: SessionMessageResult | undefined;
  const start = (session: SessionRef | undefined) => {
    if (started || !session?.turnId || session.turnId === input.previousTurnID) return;
    const result = { provider: provider.id, provider_session_id: session.sessionId, sessionId: session.sessionId, turn_id: session.turnId };
    onStarted(result);
    started = result;
  };
  const result = await recoverIssueWithProvider({
    id: provider.id, capabilities: provider.capabilities, manifest: provider.manifest,
    policyAdapter: provider.policyAdapter, runtimeStatus: provider.runtimeStatus?.bind(provider),
    async recover(runtimeInput) {
      const recovered = await provider.recover!({
        ...runtimeInput,
        onEvent(event) {
          // Provider 可能在 recover 返回前就完成：先绑定新 Attempt，再处理证据。
          start(event.session);
          runtimeInput.onEvent?.(event);
        }
      });
      start(recovered.session);
      return recovered;
    }
  }, {
    database: context.database, bus: context.bus, issueId: issue.id, issueRunId: input.runID,
    cwd: project.cwd, projectId: project.id, prompt: input.prompt,
    agentProfileId: selection.profile_id, agentRole: selection.agent_role,
    approvalPolicy: selection.approval_policy || project.approval_policy,
    executionPolicyRequest: selection.execution_policy, executionPolicyResolutionSource: selection.execution_policy_source,
    model: selection.model, reasoningEffort: selection.reasoning_effort,
    sandbox: selection.sandbox || project.sandbox, selectionReason: selection.selection_reason,
    serviceTier: issue.service_tier || project.default_service_tier,
    session: { provider: provider.id, sessionId: input.sessionID, turnId: input.previousTurnID }
  });
  if (!started || !result.session?.turnId) throw new Error("managed recovery did not return a new provider turn");
  return started;
}
