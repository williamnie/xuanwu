import type { RunnerDatabase } from "../db/database.ts";
import { hasActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import {
  createPiHeartbeatRun,
  listActivePiDelegations,
  updatePiHeartbeatRun,
  type PiDelegation
} from "../db/repositories/pi.ts";
import { heartbeatAuthorizationPolicy, heartbeatAuthorizationSummary } from "./heartbeatActionExecution.ts";
import { collectProjectHeartbeatSignals } from "./heartbeatSignals.ts";
import { planHeartbeatActions } from "./heartbeatPlanner.ts";
import {
  guardianSignalsFromHeartbeatActions,
  guardianSignalsFromSupervisorCandidates,
  writeGuardianSignals
} from "./guardianSignals.ts";
import { heartbeatContext, isPaused, iso, recordHeartbeatEvent, safeError, updateDelegationTick } from "./heartbeatOrchestratorSupport.ts";
import type {
  DelegationHeartbeatInput,
  DelegationHeartbeatResult,
  HeartbeatActionCandidate,
  HeartbeatActionSummary,
  HeartbeatInput,
  HeartbeatPolicy,
  HeartbeatResult,
  HeartbeatSignals
} from "./heartbeatTypes.ts";

const activeHeartbeats = new Set<string>();
const NORMAL_NEXT_MS = 60_000;
const ERROR_NEXT_MS = 5 * 60_000;

export async function runPiHeartbeatOnce(input: HeartbeatInput): Promise<HeartbeatResult> {
  const ctx = heartbeatContext(input);
  const lockKeys = heartbeatLockKeys(ctx);
  if (lockKeys.some((key) => activeHeartbeats.has(key))) return skippedResult(ctx, "heartbeat already running");
  lockKeys.forEach((key) => activeHeartbeats.add(key));
  try {
    return await runHeartbeatLocked(input, ctx);
  } finally {
    lockKeys.forEach((key) => activeHeartbeats.delete(key));
  }
}

export async function runDelegationHeartbeatsOnce(input: DelegationHeartbeatInput): Promise<DelegationHeartbeatResult> {
  const now = input.now ?? new Date();
  const delegations = listActivePiDelegations(input.database, iso(now));
  const result: DelegationHeartbeatResult = { runs: [], scanned: delegations.length, skipped: 0, started: 0 };
  for (const delegation of delegations) {
    const run = await runDelegationHeartbeat(input, delegation, now);
    result.runs.push(run);
    if (run.status === "skipped") result.skipped += 1;
    else result.started += 1;
  }
  return result;
}

async function runDelegationHeartbeat(input: DelegationHeartbeatInput, delegation: PiDelegation, now: Date): Promise<HeartbeatResult> {
  try {
    return await runPiHeartbeatOnce({
      database: input.database,
      delegation,
      kind: "delegation",
      now,
      projectID: delegation.project_id,
      trigger: "delegation"
    });
  } catch (error) {
    return persistFailedDelegationHeartbeat(input, delegation, now, safeError(error));
  }
}

function persistFailedDelegationHeartbeat(
  input: DelegationHeartbeatInput,
  delegation: PiDelegation,
  now: Date,
  error: string
): HeartbeatResult {
  const nowText = iso(now);
  const ctx = {
    delegationID: delegation.id,
    heartbeatID: `delegation:${delegation.project_id}:${delegation.id}:${crypto.randomUUID()}`,
    kind: "delegation" as const,
    now,
    nowText,
    projectID: delegation.project_id
  };
  const result = failedResult(ctx, error);
  createPiHeartbeatRun(input.database, {
    id: ctx.heartbeatID,
    kind: ctx.kind,
    project_id: ctx.projectID,
    delegation_id: ctx.delegationID,
    trigger: "delegation",
    started_at: nowText,
    ...storedRunResult(result, nowText)
  });
  recordHeartbeatEvent(input.database, ctx, "error", {}, result.error);
  updateDelegationTick(input.database, delegation, nowText, result.next_tick_at);
  return result;
}

async function runHeartbeatLocked(input: HeartbeatInput, ctx: ReturnType<typeof heartbeatContext>): Promise<HeartbeatResult> {
  if (isPaused(input.database, ctx)) {
    const result = skippedResult(ctx, "heartbeat is paused");
    persistSkippedHeartbeat(input.database, ctx, result);
    return result;
  }
  const run = createPiHeartbeatRun(input.database, {
    id: ctx.heartbeatID,
    kind: ctx.kind,
    project_id: ctx.projectID,
    delegation_id: ctx.delegationID,
    status: "running",
    trigger: input.trigger ?? ctx.kind,
    started_at: ctx.nowText
  });
  try {
    const signals = await collectSignals(input, ctx.projectID);
    recordHeartbeatEvent(input.database, ctx, "collect_signals", signals);
    recordSupervisorSignals(input.database, ctx, signals);
    const policy = evaluatePolicies(input.database, input, ctx);
    recordHeartbeatEvent(input.database, ctx, "evaluate_policies", policy);
    const plan = planHeartbeatActions(signals, { now: ctx.now, projectID: ctx.projectID });
    recordHeartbeatEvent(input.database, ctx, "plan_actions", { count: plan.length });
    recordHeartbeatEvent(input.database, ctx, "authorization_gate", policy.authorization_summary);
    const proposed = writeGuardianSignals(input.database, [
      ...guardianSignalsFromHeartbeatActions(plan, ctx),
      ...guardianSignalsFromSupervisorCandidates(signals.supervisor.candidates, ctx)
    ]);
    if (proposed.length > 0) recordHeartbeatEvent(input.database, ctx, "guardian_signal", { count: proposed.length, signals: proposed });
    const result = completedResult(ctx, signals, policy, plan, proposed);
    recordHeartbeatEvent(input.database, ctx, "audit", {
      actions_executed: result.executed_actions.length,
      actions_proposed: proposed.length
    });
    recordHeartbeatEvent(input.database, ctx, "schedule_next_tick", { next_tick_at: result.next_tick_at });
    updatePiHeartbeatRun(input.database, run.id, storedRunResult(result, ctx.nowText));
    updateDelegationTick(input.database, input.delegation, ctx.nowText, result.next_tick_at);
    return result;
  } catch (error) {
    const result = failedResult(ctx, safeError(error));
    recordHeartbeatEvent(input.database, ctx, "error", {}, result.error);
    recordHeartbeatEvent(input.database, ctx, "audit", { error: result.error, status: "failed" });
    updatePiHeartbeatRun(input.database, run.id, storedRunResult(result, ctx.nowText));
    updateDelegationTick(input.database, input.delegation, ctx.nowText, result.next_tick_at);
    return result;
  }
}


function recordSupervisorSignals(
  db: RunnerDatabase,
  ctx: ReturnType<typeof heartbeatContext>,
  signals: HeartbeatSignals
): void {
  const supervisor = signals.supervisor;
  if (!supervisor || supervisor.candidates.length === 0) return;
  recordHeartbeatEvent(db, ctx, "supervisor_signal", {
    candidates: supervisor.candidates,
    provider_retry_windows: supervisor.provider_retry_windows,
    recovery_budget: supervisor.recovery_budget
  });
}

async function collectSignals(input: HeartbeatInput, projectID: string): Promise<HeartbeatSignals> {
  if (input.collectSignals) return input.collectSignals({ database: input.database, now: input.now ?? new Date(), projectID });
  return collectProjectHeartbeatSignals(input.database, projectID, input.now ?? new Date(), {
    issueIDs: scopedIssueIDs(input.delegation)
  });
}

function scopedIssueIDs(delegation: PiDelegation | undefined): number[] {
  const scope = parseJsonObject(delegation?.scope_json);
  return [...new Set([...numberValues(scope.issue_id), ...numberValues(scope.issue_ids)])];
}

function parseJsonObject(value: string | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function numberValues(value: unknown): number[] {
  if (Array.isArray(value)) return value.flatMap(numberValues);
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return [value];
  if (typeof value !== "string") return [];
  return value.split(",").map((item) => Number.parseInt(item.trim(), 10))
    .filter((item) => Number.isSafeInteger(item) && item > 0);
}

function heartbeatLockKeys(ctx: ReturnType<typeof heartbeatContext>): string[] {
  const keys = [`project:${ctx.projectID}`];
  if (ctx.delegationID !== "") keys.push(`delegation:${ctx.projectID}:${ctx.delegationID}`);
  return keys;
}

function evaluatePolicies(
  db: RunnerDatabase,
  input: HeartbeatInput,
  ctx: ReturnType<typeof heartbeatContext>
): HeartbeatPolicy {
  const executorBusy = hasActiveExecutorWork(db);
  const authorization = heartbeatAuthorizationPolicy(input, ctx);
  return {
    authorization,
    authorization_summary: heartbeatAuthorizationSummary(authorization),
    executor_busy: executorBusy,
    paused: false,
    propose_only: executorBusy
  };
}

function completedResult(
  ctx: ReturnType<typeof heartbeatContext>,
  signals: HeartbeatSignals,
  policy: HeartbeatPolicy,
  plan: HeartbeatActionCandidate[],
  actions: HeartbeatActionSummary[]
): HeartbeatResult {
  return {
    action_candidates: plan,
    action_results: actions,
    actions_proposed: actions.length,
    delegation_id: ctx.delegationID,
    error: "",
    executed_actions: actions.filter((item) => item.status === "completed").map((item) => item.action_id),
    heartbeat_id: ctx.heartbeatID,
    kind: ctx.kind,
    next_tick_at: iso(new Date(ctx.now.getTime() + NORMAL_NEXT_MS)),
    policy,
    project_id: ctx.projectID,
    signals,
    status: "completed"
  };
}


function failedResult(ctx: ReturnType<typeof heartbeatContext>, error: string): HeartbeatResult {
  return {
    action_candidates: [],
    actions_proposed: 0,
    delegation_id: ctx.delegationID,
    error,
    executed_actions: [],
    heartbeat_id: ctx.heartbeatID,
    kind: ctx.kind,
    next_tick_at: iso(new Date(ctx.now.getTime() + ERROR_NEXT_MS)),
    policy: { executor_busy: false, paused: false, propose_only: true },
    project_id: ctx.projectID,
    signals: emptySignals(),
    status: "failed"
  };
}

function skippedResult(ctx: ReturnType<typeof heartbeatContext>, reason: string): HeartbeatResult {
  return {
    action_candidates: [],
    actions_proposed: 0,
    delegation_id: ctx.delegationID,
    error: "",
    executed_actions: [],
    heartbeat_id: ctx.heartbeatID,
    kind: ctx.kind,
    next_tick_at: iso(new Date(ctx.now.getTime() + NORMAL_NEXT_MS)),
    policy: { executor_busy: false, paused: true, propose_only: true },
    project_id: ctx.projectID,
    signals: emptySignals(),
    skip_reason: reason,
    status: "skipped"
  };
}

function emptySignals(): HeartbeatSignals {
  return {
    agent_sessions: { recent: [], status_counts: {}, total: 0 },
    cron: { active: 0, due: 0, total: 0 },
    delegations: { active: 0, due: 0 },
    issues: { status_counts: {}, total: 0 },
    issue_runs: { open: 0, recent: [], status_counts: {}, total: 0 },
    memory: { active: 0, pinned: 0 },
    pi_conversations: { active: 0, total: 0 },
    project_settings: {
      pi_settings: null,
      project: {
        approval_policy: "",
        auto_run: 0,
        cwd: "",
        default_agent_profile_id: "",
        default_mcp_policy: {},
        default_skill_policy: {},
        id: "",
        model: "",
        name: "",
        provider: "",
        provider_config: {},
        sandbox: ""
      }
    },
    provider_health: { provider: "", status: "unknown" },
    supervisor: { candidates: [], provider_retry_windows: [], recovery_budget: [], stale_session_diagnostics: [] },
    usage_cost: { status: "not_configured", total_tokens: 0 }
  };
}

function persistSkippedHeartbeat(db: RunnerDatabase, ctx: ReturnType<typeof heartbeatContext>, result: HeartbeatResult): void {
  createPiHeartbeatRun(db, {
    id: ctx.heartbeatID,
    kind: ctx.kind,
    project_id: ctx.projectID,
    delegation_id: ctx.delegationID,
    status: result.status,
    trigger: ctx.kind,
    started_at: ctx.nowText,
    finished_at: ctx.nowText,
    next_tick_at: result.next_tick_at,
    error: result.skip_reason ?? "",
    result_json: JSON.stringify(result)
  });
  recordHeartbeatEvent(db, ctx, "skipped", { reason: result.skip_reason });
}

function storedRunResult(result: HeartbeatResult, finishedAt: string) {
  return {
    action_plan_json: JSON.stringify(result.action_candidates),
    error: result.error,
    finished_at: finishedAt,
    next_tick_at: result.next_tick_at,
    policy_json: JSON.stringify(result.policy),
    result_json: JSON.stringify(result),
    signals_json: JSON.stringify(result.signals),
    status: result.status
  };
}
