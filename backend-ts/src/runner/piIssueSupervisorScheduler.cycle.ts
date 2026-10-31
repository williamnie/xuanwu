import type { ExecutorProviderId } from "../providers/types.ts";
import { applyIssueSupervisorDecisionActions } from "../pi/supervisor/issueSupervisorActions.ts";
import { reconcileCurrentProviderTurn } from "./providerSessionReconciliation.ts";
import { providersForProjectID } from "../nodes/remoteExecution.ts";
import { activeSupervisorIssues } from "./piIssueSupervisorScheduler.model.ts";
import type { PiIssueSupervisorSchedulerInput, PiIssueSupervisorSchedulerResult } from "./piIssueSupervisorScheduler.model.ts";
import { collectTargets } from "./piIssueSupervisorScheduler.targets.ts";
import { recentDecisionExists } from "./piIssueSupervisorScheduler.cooldown.ts";
import { recordTarget, decideTarget, recordFailure } from "./piIssueSupervisorScheduler.decisions.ts";

export async function runPiIssueSupervisorSchedulerOnce(
  input: PiIssueSupervisorSchedulerInput
): Promise<PiIssueSupervisorSchedulerResult> {
  const now = input.now ?? new Date();
  const targets = await collectTargets(input.database, now, input);
  const result: PiIssueSupervisorSchedulerResult = {
    decisions: 0,
    failed: 0,
    scanned: targets.scanned,
    signaled: targets.signaled,
    skipped: 0
  };
  for (const target of targets.ready) {
    const key = `${target.projectID}:${target.issueID}`;
    if (activeSupervisorIssues.has(key)) {
      result.skipped += 1;
      continue;
    }
    activeSupervisorIssues.add(key);
    try {
      if (recentDecisionExists(input, target, now)) {
        result.skipped += 1;
        continue;
      }
      recordTarget(input.database, target, now);
      const decision = await decideTarget(input, target, now);
      result.decisions += 1;
      if (!decision.valid) {
        result.failed += 1;
        continue;
      }
      // PI 思考期间 Provider 可能已完成，不能依据旧摘要再发恢复或人工求助。
      // 远程项目的会话在节点上，经节点读取回合状态。
      const provider = providersForProjectID(input.database, input.providers, target.projectID)?.[String(target.context.latest_run?.provider) as ExecutorProviderId];
      const observed = await reconcileCurrentProviderTurn({
        database: input.database, issueID: target.issueID, provider, bus: input.bus
      });
      if (!["unsupported", "interrupted"].includes(observed)) {
        result.skipped += 1;
        continue;
      }
      await applyIssueSupervisorDecisionActions({
        bus: input.bus,
        context: target.context,
        database: input.database,
        decision: decision.decision,
        now,
        providers: input.providers,
        recordDecision: Boolean(input.runDecision) || decision.recordDecision === true
      });
    } catch (error) {
      result.failed += 1;
      recordFailure(input.database, target, error, now);
    } finally {
      activeSupervisorIssues.delete(key);
    }
  }
  return result;
}
