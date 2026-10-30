import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import type { ExecutorProviderId } from "../providers/types.ts";
import { buildIssueSupervisorRecoveryContextAsync, type IssueSupervisorRecoveryContext } from "../pi/supervisor/issueSupervisorContext.ts";
import { supervisorCandidateReady } from "../pi/supervisor/issueSupervisorSignalCollector.ts";
import { isTransientRecoveryDiagnosis } from "../pi/supervisor/recoveryDiagnosis.ts";
import { iso } from "../pi/heartbeat/heartbeatOrchestratorSupport.ts";
import { reconcileCurrentProviderTurn } from "./providerSessionReconciliation.ts";
import { refreshSupervisorProgressResult } from "./issueSupervisorProgressTracker.ts";
import { cleanString } from "../util/values.ts";
import { providersForProjectID } from "../nodes/remoteExecution.ts";
import { DEFAULT_LIMIT, DEFAULT_STALE_SECONDS } from "./piIssueSupervisorScheduler.model.ts";
import type { PiIssueSupervisorSchedulerInput, SupervisorTarget } from "./piIssueSupervisorScheduler.model.ts";
import { cooldownUntil, boundedLimit } from "./piIssueSupervisorScheduler.cooldown.ts";

export async function collectTargets(
  db: RunnerDatabase,
  now: Date,
  options: Pick<PiIssueSupervisorSchedulerInput, "limit" | "staleAfterSeconds" | "providers" | "bus">
): Promise<{ ready: SupervisorTarget[]; scanned: number; signaled: number }> {
  const issueIDs = scanIssueIDs(db, now, options.limit ?? DEFAULT_LIMIT);
  const staleAfterSeconds = options.staleAfterSeconds ?? DEFAULT_STALE_SECONDS;
  const ready: SupervisorTarget[] = [];
  let signaled = 0;
  for (const issueID of issueIDs) {
    const issue = getIssue(db, issueID);
    if (!issue) continue;
    let context = await buildIssueSupervisorRecoveryContextAsync(db, issueID, {
      includeWorkspaceGit: false,
      now,
      staleAfterSeconds
    });
    if (cleanString(context.policy.mode) === "off") continue;
    if (context.candidates.length > 0) {
      const provider = providersForProjectID(db, options.providers, issue.project_id)?.[String(context.latest_run?.provider) as ExecutorProviderId];
      const observed = await reconcileCurrentProviderTurn({ database: db, issueID, provider, bus: options.bus });
      if (!["unsupported", "interrupted"].includes(observed)) continue;
    }
    if (refreshSupervisorProgressResult({
      context,
      database: db,
      issueID,
      now,
      projectID: issue.project_id,
      staleAfterSeconds: options.staleAfterSeconds
    }) !== null) {
      context = await buildIssueSupervisorRecoveryContextAsync(db, issueID, {
        includeWorkspaceGit: false,
        now,
        staleAfterSeconds
      });
    }
    const dispatchableCandidates = context.candidates.filter((candidate) =>
      supervisorCandidateDispatchable(context, candidate, now, { staleAfterSeconds })
    );
    if (dispatchableCandidates.length > 0) signaled += 1;
    if (dispatchableCandidates.length === 0) continue;
    ready.push({
      candidates: dispatchableCandidates,
      context,
      issueID,
      projectID: issue.project_id
    });
  }
  return { ready, scanned: issueIDs.length, signaled };
}

export function supervisorCandidateDispatchable(
  context: IssueSupervisorRecoveryContext,
  candidate: IssueSupervisorRecoveryContext["candidates"][number],
  now: Date,
  options: Pick<PiIssueSupervisorSchedulerInput, "staleAfterSeconds">
): boolean {
  if (isTransientRecoveryDiagnosis(candidate.diagnosis_code) && cooldownBlocksCandidate(context, candidate, now)) return false;
  if (supervisorCandidateReady(context, candidate, now, { staleAfterSeconds: options.staleAfterSeconds })) return true;
  return candidate.diagnosis_code === "provider_retry_after_waiting" &&
    cleanString(candidate.source_event_type) !== "issue.retry_after_scheduled";
}

export function cooldownBlocksCandidate(
  context: IssueSupervisorRecoveryContext,
  candidate: IssueSupervisorRecoveryContext["candidates"][number],
  now: Date
): boolean {
  if (candidate.diagnosis_code === "provider_retry_after_ready" &&
    cleanString(context.recovery_history.last_action_type) === "issue.retry_after") return false;
  const until = Date.parse(cooldownUntil(context, now));
  return Number.isFinite(until) && until > now.getTime();
}

export function scanIssueIDs(db: RunnerDatabase, now: Date, limit: number): number[] {
  const nowText = iso(now);
  const recentFailedCutoff = iso(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  return db.sqlite.query<{ id: number }, [string, string]>(`
    select distinct i.id from issues i
    left join issue_runs ir on ir.issue_id=i.id
    join project_pi_settings settings on settings.project_id=i.project_id
    join pi_agents supervisor on supervisor.id='runner-default' and supervisor.enabled=1
    where i.status not in ('done', 'cancelled') and (
      i.status='in_progress' or ir.ended_at='' or (i.auto_retry_next_at<>'' and i.auto_retry_next_at<=?)
      or (i.status='failed' and i.updated_at>=?)
    )
    order by i.updated_at asc, i.id asc limit ${boundedLimit(limit)}
  `).all(nowText, recentFailedCutoff).map((row) => row.id);
}
