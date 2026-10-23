import { getIssuesByIDs } from "../db/repositories/issues.ts";
import { listAgentProfiles } from "../db/repositories/agentProfiles.ts";
import { getProject } from "../db/repositories/projects.ts";
import { activeExecutorWorkHolders, countActiveExecutorWork, projectExecutionLockKey } from "../db/repositories/issueQueue.ts";
import { readWorkspaceWaits } from "../db/repositories/workspaceWaits.ts";
import { readProjectIssueDependencies } from "../domain/work/issueDependency.ts";
import { issueIDToWorkID, workIDToIssueID } from "../domain/work/issueAdapter.ts";
import type { WorkLedgerEntry } from "../domain/work/contracts.ts";
import { resolveExecutorSelection } from "../pi/runtime/agentOrchestration.ts";
import { isExecutorProviderId } from "../providers/types.ts";
import { readProjectLoopSnapshot } from "../runner/projectLoopManager.ts";
import { evaluateQueueCandidate, providerAvailability, projectCapacityAvailable, type WorkSchedule } from "../runner/queueEligibility.ts";
import type { ReadApiContext } from "./readApiContext.ts";

export type ScheduledWork = WorkLedgerEntry & { schedule?: WorkSchedule };

/** Request-local projection. Dependency/readiness stays on the scheduler's existing read path.
 * HTTP routes and the queue manager share the core process; read its writer-runtime snapshot,
 * while all SQL projections use the read connection. No manager initialization or scheduling. */
export function attachWorkSchedules(context: ReadApiContext, works: WorkLedgerEntry[]): ScheduledWork[] {
  const queued = works.filter(work => work.status === "todo");
  if (!queued.length) return works;
  const db = context.readDatabase ?? context.database;
  const runtime = readProjectLoopSnapshot(context.database);
  // Use the exact provider map passed to projectLoopManager, not a second registry view.
  const providers = context.providers ?? {};
  const availability = new Map(Object.entries(providers).map(([id, provider]) => [id, providerAvailability(id, provider)]));
  const profiles = listAgentProfiles(db);
  const issues = new Map(getIssuesByIDs(db, queued.map(work => workIDToIssueID(work.id))).map(issue => [issue.id, issue]));
  const waits = readWorkspaceWaits(db, [...issues.keys()]);
  const projects = new Map([...new Set(queued.map(work => work.owner.project_id))].map(id => {
    const project = getProject(db, id);
    if (!project) throw new Error("Queued Work project is missing");
    return [id, { project, dependency: readProjectIssueDependencies(db, id),
      busy: projectBusy(activeExecutorWorkHolders(db, id), runtime.activeLockKeys.has(projectExecutionLockKey(db, id))) }];
  }));
  const openRuns = countActiveExecutorWork(db);
  const capacity = projectCapacityAvailable(openRuns, runtime.workers, runtime.maximum);
  return works.map(work => {
    if (work.status !== "todo") return work;
    const id = workIDToIssueID(work.id);
    const issue = issues.get(id);
    const facts = projects.get(work.owner.project_id)!;
    if (!issue || !facts.dependency.has(id)) throw new Error("Queued Work issue is missing");
    const selection = resolveExecutorSelection(db, facts.project, issue, profiles);
    const providerID = isExecutorProviderId(selection.provider) ? selection.provider : facts.project.provider.trim();
    const reasons = evaluateQueueCandidate({ project: facts.project, forceOnce: runtime.forcedProjects.has(facts.project.id),
      dependency: facts.dependency.get(id), workspaceWaiting: waits.get(id)?.state === "released",
      provider: availability.get(providerID) ?? providerAvailability(providerID) });
    if (facts.busy) reasons.push({ code: "project_busy", detail: facts.busy });
    if (!capacity) reasons.push({ code: "capacity_full", detail: {
      source: runtime.source, open_runs: openRuns, workers: runtime.workers, maximum: runtime.maximum
    } });
    return { ...work, schedule: { state: reasons.length ? "waiting" : "runnable", reasons } };
  });
}

/** A needs_user holder keeps the directory until its workspace is released; it is not executing. */
function projectBusy(holders: { id: number; running: boolean }[], lockActive: boolean): Record<string, unknown> | null {
  if (lockActive || holders.some(holder => holder.running)) return { scope: "workspace", holder: "running" };
  if (!holders.length) return null;
  return { scope: "workspace", holder: "awaiting_user", holder_work_ids: holders.map(holder => issueIDToWorkID(holder.id)) };
}
