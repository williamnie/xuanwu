import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { claimDueCronTasks } from "../db/repositories/cronTaskClaims.ts";
import { recordCronTaskError, recordCronTaskSkip, recordCronTaskSuccess } from "../db/repositories/cronTaskResults.ts";
import type { CronTask } from "../db/repositories/cronTasks.ts";
import { createPiDelegation, isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import type { EventBus } from "../events/bus.ts";
import { syncCodexProjects } from "../http/projectSync.ts";
import { runDelegationHeartbeatsOnce, runPiHeartbeatOnce } from "../pi/heartbeatOrchestrator.ts";
import { scanProjectFindings } from "../pi/projectFindings.ts";
import { buildPiReport } from "../pi/reports.ts";
import type { PiAutoManageProjectCycle } from "./piAutoManageScheduler.ts";
import { startProjectLoop as defaultStartProjectLoop, type ProjectLoopRuntime } from "./projectLoopManager.ts";
import { nextRunAfter, quietHoursResumeAt, scheduleRunMode } from "../schedule/cronSchedule.ts";

export type CronExecutorResult = { executed: number; failed: number; scanned: number; skipped: number };

export type CronExecutorInput = ProjectLoopRuntime & {
  bus?: EventBus;
  codexSessionsDir?: string;
  now?: Date;
  runProjectCycle?: PiAutoManageProjectCycle;
  startProjectLoop?: (runtime: ProjectLoopRuntime, projectID: string) => void;
};

type CronActionResult = { detail: string; projectIDs?: string[]; skipped?: boolean };

const activeCronTasks = new Set<number>();

export async function runDueCronTasks(input: CronExecutorInput): Promise<CronExecutorResult> {
  const now = input.now ?? new Date();
  const tasks = claimDueCronTasks(input.database, now);
  const result: CronExecutorResult = { executed: 0, failed: 0, scanned: tasks.length, skipped: 0 };
  for (const task of tasks) {
    const status = await runCronTask(input, task, now);
    result[status] += 1;
  }
  return result;
}

async function runCronTask(input: CronExecutorInput, task: CronTask, now: Date): Promise<"executed" | "failed" | "skipped"> {
  activeCronTasks.add(task.id);
  try {
    const quietResumeAt = quietHoursResumeAt(task, now);
    if (quietResumeAt !== "") {
      recordCronTaskSkip(input.database, { nextRunAt: quietResumeAt, now, result: `quiet hours until ${quietResumeAt}`, task });
      return "skipped";
    }
    if (shouldSkipMissedRun(task, now)) {
      recordCronTaskSkip(input.database, { nextRunAt: nextRun(task, now), now, result: "missed run skipped by policy", task });
      return "skipped";
    }
    try {
      const actionResult = await executeCronAction(input, task, now);
      if (actionResult.skipped === true) {
        recordCronTaskSkip(input.database, { nextRunAt: nextRun(task, now), now, result: actionResult.detail, task });
        return "skipped";
      }
      recordCronTaskSuccess(input.database, { now, result: actionResult.detail, task });
      kickProjects(input, actionResult.projectIDs ?? []);
      return "executed";
    } catch (error) {
      recordCronTaskError(input.database, { now, result: safeError(error), task });
      return "failed";
    }
  } finally {
    activeCronTasks.delete(task.id);
  }
}

function shouldSkipMissedRun(task: CronTask, now: Date): boolean {
  if (task.missed_run_policy !== "skip" || task.mode === "once") return false;
  const due = Date.parse(task.next_run_at);
  return Number.isFinite(due) && now.getTime() - due > 60_000;
}

async function executeCronAction(input: CronExecutorInput, task: CronTask, now: Date): Promise<CronActionResult> {
  switch (task.action) {
    case "triage_to_todo":
    case "enqueue_issues":
      return enqueueDueIssues(input.database, task);
    case "start_delegation":
      return startDelegation(input.database, task, now);
    case "run_pi_cycle":
      return await runPiCycle(input, task);
    case "generate_report":
      return await generateReport(input, task, now);
    case "check_stale_sessions":
      return checkStaleSessions(input.database, task, now);
    case "sync_projects":
      return syncProjects(input.database);
    default:
      throw new Error(`unsupported cron action ${task.action}`);
  }
}

function enqueueDueIssues(db: RunnerDatabase, task: CronTask): CronActionResult {
  const issues = db.sqlite.query<{ id: number; project_id: string }, string[]>(`
    select id, project_id from issues
    where status='triage' ${task.project_id === "" ? "" : "and project_id=?"}
    order by priority desc, created_at asc, id asc
  `).all(...(task.project_id === "" ? [] : [task.project_id]));
  const projectIDs = new Set<string>();
  for (const issue of issues) {
    enqueueIssue(db, issue.id);
    projectIDs.add(issue.project_id);
  }
  return { detail: `enqueued ${issues.length} issue(s)`, projectIDs: [...projectIDs] };
}

function startDelegation(db: RunnerDatabase, task: CronTask, now: Date): CronActionResult {
  const payload = parsePayload(task);
  const mode = scheduleRunMode(task, now);
  const delegation = createPiDelegation(db, {
    authorization_json: JSON.stringify({ mode, source_cron_task_id: task.id }),
    id: `cron:${task.id}:${crypto.randomUUID()}`,
    intent_json: JSON.stringify({ action: task.action, payload, schedule: task.schedule_expr }),
    next_heartbeat_at: now.toISOString(),
    project_id: requiredProjectID(task),
    status: "active",
    title: cleanString(payload.title) || task.name || "Scheduled delegation"
  });
  return { detail: `started delegation ${delegation.id} mode=${mode}`, projectIDs: [delegation.project_id] };
}

async function runPiCycle(input: CronExecutorInput, task: CronTask): Promise<CronActionResult> {
  const projectID = requiredProjectID(task);
  if (isProjectHeartbeatPaused(input.database, projectID)) return skippedCronResult("heartbeat paused");
  if (input.runProjectCycle) await input.runProjectCycle({ maxActions: 5, projectId: projectID });
  else await runPiHeartbeatOnce({ database: input.database, kind: "cron", projectID, trigger: "cron" });
  return { detail: `ran PI cycle for ${projectID}`, projectIDs: [projectID] };
}

function skippedCronResult(detail: string): CronActionResult {
  return { detail, skipped: true };
}

function isProjectHeartbeatPaused(db: RunnerDatabase, projectID: string): boolean {
  return isPiHeartbeatPaused(db, { scopeId: projectID, scopeType: "project" });
}

async function generateReport(input: CronExecutorInput, task: CronTask, now: Date): Promise<CronActionResult> {
  const payload = parsePayload(task);
  const report = await buildPiReport({
    bus: input.bus,
    codexSessionsDir: input.codexSessionsDir,
    database: input.database,
    now,
    projectID: task.project_id,
    since: cleanString(payload.since),
    type: cleanString(payload.type) || "daily_project_digest",
    until: cleanString(payload.until)
  });
  const summary = report.summary;
  return {
    detail: `pi report ${report.type} completed=${summary.completed ?? 0} failed=${summary.failed ?? 0} needs_user=${summary.needs_user ?? 0}`
  };
}

function checkStaleSessions(db: RunnerDatabase, task: CronTask, now: Date): CronActionResult {
  const projectIDs = task.project_id === "" ? allProjectIDs(db) : [task.project_id];
  const counts = projectIDs.map((projectID) => [projectID, scanProjectFindings(db, projectID, { now }).filter((item) => item.reason === "stale_issue").length]);
  return { detail: `stale sessions ${JSON.stringify(Object.fromEntries(counts))}` };
}

function syncProjects(db: RunnerDatabase): CronActionResult {
  const result = syncCodexProjects(db);
  return { detail: `sync projects created=${result.summary.created} existing=${result.summary.existing} skipped=${result.summary.skipped}` };
}

function nextRun(task: CronTask, now: Date): string {
  if (task.mode === "once") return "";
  return nextRunAfter(task, now);
}

function kickProjects(input: CronExecutorInput, projectIDs: string[]): void {
  const starter = input.startProjectLoop ?? defaultStartProjectLoop;
  for (const projectID of projectIDs) starter(input, projectID);
}

function allProjectIDs(db: RunnerDatabase): string[] {
  return db.sqlite.query<{ id: string }, []>("select id from projects order by sort_order asc, created_at asc, id asc").all().map((row) => row.id);
}

function parsePayload(task: CronTask): Record<string, unknown> {
  try {
    const parsed = JSON.parse(task.action_payload_json || "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function requiredProjectID(task: CronTask): string {
  if (task.project_id === "") throw new Error(`${task.action} requires project_id`);
  return task.project_id;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
