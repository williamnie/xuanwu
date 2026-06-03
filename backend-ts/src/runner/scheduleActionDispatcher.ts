import type { RunnerDatabase } from "../db/database.ts";
import { enqueueIssue } from "../db/repositories/issueActions.ts";
import { createPiAction, createPiActionEvent, createPiDelegation, isPiHeartbeatPaused, updatePiAction } from "../db/repositories/pi.ts";
import type { CronTask } from "../db/repositories/cronTasks.ts";
import type { EventBus } from "../events/bus.ts";
import { syncCodexProjects } from "../http/projectSync.ts";
import { gatePiActionEnvelope, type PiGatePolicy } from "../pi/actionGate.ts";
import { normalizePiActionEnvelope } from "../pi/actionEnvelope.ts";
import { publishPiActionEvent } from "../pi/actionEngine.ts";
import { runPiHeartbeatOnce } from "../pi/heartbeatOrchestrator.ts";
import { scanProjectFindings } from "../pi/projectFindings.ts";
import { buildPiReport } from "../pi/reports.ts";
import { scheduleRunMode } from "../schedule/cronSchedule.ts";
import type { PiAutoManageProjectCycle } from "./piAutoManageScheduler.ts";

export type ScheduleActionResult = { detail: string; projectIDs?: string[]; skipped?: boolean };
export type ScheduleActionInput = {
  bus?: EventBus;
  codexSessionsDir?: string;
  database: RunnerDatabase;
  now: Date;
  runProjectCycle?: PiAutoManageProjectCycle;
};

const SCHEDULE_ACTION_TYPES = new Set([
  "schedule.check_stale_sessions",
  "schedule.enqueue_issues",
  "schedule.generate_report",
  "schedule.run_heartbeat",
  "schedule.run_pi_cycle",
  "schedule.start_delegation",
  "schedule.sync_projects"
]);

export async function dispatchScheduleAction(
  input: ScheduleActionInput,
  task: CronTask
): Promise<ScheduleActionResult> {
  const actionType = scheduleActionType(task.action);
  const action = createSchedulePiAction(input, task, actionType);
  const decision = gatePiActionEnvelope(scheduleEnvelope(task, actionType), scheduleGatePolicy(task, input.now));
  const gated = updatePiAction(input.database, action.id, {
    gate_decision: decision.decision,
    gate_reason: decision.reason,
    result_json: JSON.stringify({ action_id: action.id, action_type: actionType, decision: decision.decision }),
    status: gateStatus(decision.decision)
  });
  audit(input, gated, "gate_decision", { actor: "gate", decision: decision.decision, reason: decision.reason });
  if (decision.decision !== "execute") throw new Error(`schedule action rejected by action gate: ${decision.reason}`);
  return await executeScheduleAction(input, task, gated);
}

async function executeScheduleAction(input: ScheduleActionInput, task: CronTask, action: ReturnType<typeof createPiAction>) {
  const executing = updatePiAction(input.database, action.id, { status: "executing" });
  audit(input, executing, "execution_started", { actor: "gate", decision: "execute" });
  publishPiActionEvent(input.bus, "pi.action_executing", executing);
  try {
    const result = await executeSupportedScheduleAction(input, task);
    const completed = updatePiAction(input.database, action.id, { result_json: JSON.stringify(result), status: "completed" });
    audit(input, completed, "execution_result", { actor: "executor", result });
    publishPiActionEvent(input.bus, "pi.action_completed", completed);
    return result;
  } catch (error) {
    const failed = updatePiAction(input.database, action.id, { result_json: JSON.stringify({ error: safeError(error) }), status: "failed" });
    audit(input, failed, "execution_error", { actor: "executor", error: safeError(error) });
    publishPiActionEvent(input.bus, "pi.action_failed", failed);
    throw error;
  }
}

async function executeSupportedScheduleAction(input: ScheduleActionInput, task: CronTask): Promise<ScheduleActionResult> {
  switch (task.action) {
    case "triage_to_todo":
    case "enqueue_issues":
      return enqueueDueIssues(input.database, task);
    case "start_delegation":
      return startDelegation(input.database, task, input.now);
    case "run_heartbeat":
      return await runHeartbeat(input, task);
    case "run_pi_cycle":
      return await runPiCycle(input, task);
    case "generate_report":
      return await generateReport(input, task, input.now);
    case "check_stale_sessions":
      return checkStaleSessions(input.database, task, input.now);
    case "sync_projects":
      return syncProjects(input.database);
    default:
      throw new Error(`unsupported cron action ${task.action}`);
  }
}

function createSchedulePiAction(input: ScheduleActionInput, task: CronTask, actionType: string) {
  const action = createPiAction(input.database, {
    id: crypto.randomUUID(),
    action_type: actionType,
    payload_json: JSON.stringify(schedulePayload(task)),
    project_id: task.project_id,
    rationale: `cron task ${task.id} ${task.action}`,
    requires_confirmation: 1,
    risk_level: "medium",
    source: "cron_schedule",
    status: "candidate"
  });
  audit(input, action, "candidate", { actor: "cron", payload: scheduleEnvelope(task, actionType) });
  publishPiActionEvent(input.bus, "pi.action_candidate", action);
  return action;
}

function scheduleEnvelope(task: CronTask, actionType: string) {
  return normalizePiActionEnvelope({
    action_type: actionType,
    goal_id: cronGoalID(task),
    payload: schedulePayload(task),
    project_id: task.project_id,
    rationale: `cron task ${task.id} ${task.action}`,
    requires_confirmation: true,
    risk_level: "medium",
    source: "cron_schedule"
  });
}

function scheduleGatePolicy(task: CronTask, now: Date): PiGatePolicy {
  return {
    allowed_actions: [...SCHEDULE_ACTION_TYPES],
    authorizedActions: [...SCHEDULE_ACTION_TYPES].map((action_type) => ({ action_type, project_id: task.project_id })),
    mode: "delegated",
    now,
    scope: { goal_id: cronGoalID(task), project_id: task.project_id }
  };
}

function enqueueDueIssues(db: RunnerDatabase, task: CronTask): ScheduleActionResult {
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

function startDelegation(db: RunnerDatabase, task: CronTask, now: Date): ScheduleActionResult {
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

async function runHeartbeat(input: ScheduleActionInput, task: CronTask): Promise<ScheduleActionResult> {
  const projectID = requiredProjectID(task);
  if (isProjectHeartbeatPaused(input.database, projectID)) return { detail: "heartbeat paused", skipped: true };
  await runPiHeartbeatOnce({ database: input.database, kind: "cron", now: input.now, projectID, trigger: "cron" });
  return { detail: `ran heartbeat for ${projectID}`, projectIDs: [projectID] };
}

async function runPiCycle(input: ScheduleActionInput, task: CronTask): Promise<ScheduleActionResult> {
  const projectID = requiredProjectID(task);
  if (isProjectHeartbeatPaused(input.database, projectID)) return { detail: "heartbeat paused", skipped: true };
  if (input.runProjectCycle) await input.runProjectCycle({ maxActions: 5, projectId: projectID });
  else await runPiHeartbeatOnce({ database: input.database, kind: "cron", now: input.now, projectID, trigger: "cron" });
  return { detail: `ran PI cycle for ${projectID}`, projectIDs: [projectID] };
}

async function generateReport(input: ScheduleActionInput, task: CronTask, now: Date): Promise<ScheduleActionResult> {
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
  return { detail: `pi report ${report.type} ${reportSummary(report.summary)}` };
}

function checkStaleSessions(db: RunnerDatabase, task: CronTask, now: Date): ScheduleActionResult {
  const projectIDs = task.project_id === "" ? allProjectIDs(db) : [task.project_id];
  const counts = projectIDs.map((id) => [id, scanProjectFindings(db, id, { now }).filter((item) => item.reason === "stale_issue").length]);
  return { detail: `stale sessions ${JSON.stringify(Object.fromEntries(counts))}` };
}

function syncProjects(db: RunnerDatabase): ScheduleActionResult {
  const result = syncCodexProjects(db);
  return { detail: `sync projects created=${result.summary.created} existing=${result.summary.existing} skipped=${result.summary.skipped}` };
}

function scheduleActionType(action: string): string {
  if (action === "triage_to_todo" || action === "enqueue_issues") return "schedule.enqueue_issues";
  if (action === "start_delegation") return "schedule.start_delegation";
  if (action === "run_heartbeat") return "schedule.run_heartbeat";
  if (action === "run_pi_cycle") return "schedule.run_pi_cycle";
  if (action === "generate_report") return "schedule.generate_report";
  if (action === "check_stale_sessions") return "schedule.check_stale_sessions";
  if (action === "sync_projects") return "schedule.sync_projects";
  return "schedule.unsupported";
}

function schedulePayload(task: CronTask): Record<string, unknown> {
  return { action: task.action, cron_task_id: task.id, payload: parsePayload(task), schedule: task.schedule_expr };
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

function reportSummary(summary: Record<string, unknown>): string {
  return `completed=${summary.completed ?? 0} failed=${summary.failed ?? 0} needs_user=${summary.needs_user ?? 0}`;
}

function requiredProjectID(task: CronTask): string {
  if (task.project_id === "") throw new Error(`${task.action} requires project_id`);
  return task.project_id;
}

function isProjectHeartbeatPaused(db: RunnerDatabase, projectID: string): boolean {
  return isPiHeartbeatPaused(db, { scopeId: projectID, scopeType: "project" });
}

function audit(
  input: ScheduleActionInput,
  action: ReturnType<typeof createPiAction>,
  eventType: string,
  data: { actor?: string; decision?: string; error?: string; payload?: unknown; reason?: string; result?: unknown } = {}
): void {
  createPiActionEvent(input.database, {
    action_id: action.id,
    actor: cleanString(data.actor),
    decision: cleanString(data.decision),
    error: cleanString(data.error),
    event_type: eventType,
    payload_json: JSON.stringify(data.payload ?? {}),
    project_id: action.project_id,
    reason: cleanString(data.reason),
    result_json: JSON.stringify(data.result ?? {})
  });
}

function gateStatus(decision: string): string {
  if (decision === "execute") return "approved";
  if (decision === "ask") return "pending";
  if (decision === "snooze") return "snoozed";
  return "denied";
}

function cronGoalID(task: CronTask): string { return `cron:${task.id}`; }
function cleanString(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function safeError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
