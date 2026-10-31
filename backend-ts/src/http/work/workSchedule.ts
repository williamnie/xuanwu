import { getIssuesByIDs } from "../../db/repositories/issues.ts";
import { listAgentProfiles } from "../../db/repositories/agentProfiles.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { activeExecutorWorkHolders, countActiveExecutorWorkAt, projectExecutionLockKey } from "../../db/repositories/issueQueue.ts";
import { readWorkspaceWaits } from "../../db/repositories/workspaceWaits.ts";
import { readProjectIssueDependencies } from "../../domain/work/issueDependency.ts";
import { issueIDToWorkID, workIDToIssueID } from "../../domain/work/issueAdapter.ts";
import type { WorkLedgerEntry } from "../../domain/work/contracts.ts";
import { resolveExecutorSelection } from "../../pi/runtime/agentOrchestration.ts";
import { isExecutorProviderId, type ExecutorProviderId } from "../../providers/types.ts";
import { readProjectLoopSnapshot } from "../../runner/projectLoopManager.ts";
import { evaluateQueueCandidate, providerAvailability, projectCapacityAvailable, type WorkSchedule } from "../../runner/queueEligibility.ts";
import type { ReadApiContext } from "../readApiContext.ts";
import { executionLocationMaximum, projectExecutionLocation } from "../../nodes/capacity.ts";
import { providersForProjectCwd } from "../../nodes/remoteExecution.ts";
import { projectLocation } from "../../nodes/projectLocation.ts";

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
  const profiles = listAgentProfiles(db);
  const issues = new Map(getIssuesByIDs(db, queued.map(work => workIDToIssueID(work.id))).map(issue => [issue.id, issue]));
  const waits = readWorkspaceWaits(db, [...issues.keys()]);
  const projects = new Map([...new Set(queued.map(work => work.owner.project_id))].map(id => {
    const project = getProject(db, id);
    if (!project) throw new Error("Queued Work project is missing");
    return [id, { project, dependency: readProjectIssueDependencies(db, id),
      busy: projectBusy(activeExecutorWorkHolders(db, id), runtime.activeLockKeys.has(projectExecutionLockKey(db, id))) }];
  }));
  // 名额与编程工具都按项目的执行位置（中心本机或远程节点）判断；每次请求每个位置只算一次。
  const capacities = new Map<string, { available: boolean; maximum: number; openRuns: number; workers: number }>();
  const capacityAt = (projectID: string) => {
    const location = projectExecutionLocation(db, projectID);
    if (!capacities.has(location)) {
      const workers = runtime.workersByLocation.get(location) ?? 0;
      const maximum = executionLocationMaximum(db, location, runtime.maximum);
      const openRuns = countActiveExecutorWorkAt(db, location);
      capacities.set(location, { available: projectCapacityAvailable(openRuns, workers, maximum), maximum, openRuns, workers });
    }
    return capacities.get(location)!;
  };
  const availability = new Map<string, ReturnType<typeof providerAvailability>>();
  const availabilityAt = (cwd: string, providerID: string) => {
    const key = `${projectLocation(cwd).nodeId}\u0000${providerID}`;
    if (!availability.has(key)) {
      availability.set(key, providerAvailability(providerID, providersForProjectCwd(providers, cwd)[providerID as ExecutorProviderId]));
    }
    return availability.get(key)!;
  };
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
      provider: availabilityAt(facts.project.cwd, providerID) });
    if (facts.busy) reasons.push({ code: "project_busy", detail: facts.busy });
    const capacity = capacityAt(facts.project.id);
    if (!capacity.available) reasons.push({ code: "capacity_full", detail: {
      source: runtime.source, open_runs: capacity.openRuns, workers: capacity.workers, maximum: capacity.maximum
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
