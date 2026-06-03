import type { RunnerDatabase } from "../db/database.ts";
import { hasActiveExecutorWork } from "../db/repositories/issueQueue.ts";
import {
  createPiAction,
  createPiHeartbeatRun,
  listActivePiDelegations,
  updatePiHeartbeatRun
} from "../db/repositories/pi.ts";
import { collectProjectHeartbeatSignals } from "./heartbeatSignals.ts";
import { normalizePiActionEnvelope } from "./actionEnvelope.ts";
import { heartbeatContext, isPaused, iso, recordHeartbeatEvent, safeError, updateDelegationTick } from "./heartbeatOrchestratorSupport.ts";
import type {
  DelegationHeartbeatInput,
  DelegationHeartbeatResult,
  HeartbeatActionCandidate,
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
  if (activeHeartbeats.has(ctx.key)) return skippedResult(ctx, "heartbeat already running");
  activeHeartbeats.add(ctx.key);
  try {
    return runHeartbeatLocked(input, ctx);
  } finally {
    activeHeartbeats.delete(ctx.key);
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

async function runDelegationHeartbeat(input: DelegationHeartbeatInput, delegation: { id: string; project_id: string }, now: Date): Promise<HeartbeatResult> {
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
  delegation: { id: string; project_id: string },
  now: Date,
  error: string
): HeartbeatResult {
  const nowText = iso(now);
  const ctx = {
    delegationID: delegation.id,
    heartbeatID: `delegation:${delegation.project_id}:${delegation.id}:${crypto.randomUUID()}`,
    key: `delegation:${delegation.project_id}:${delegation.id}`,
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
    status: result.status,
    trigger: "delegation",
    started_at: nowText,
    ...storedRunResult(result, nowText)
  });
  recordHeartbeatEvent(input.database, ctx, "error", {}, result.error);
  updateDelegationTick(input.database, delegation, nowText, result.next_tick_at);
  return result;
}

function runHeartbeatLocked(input: HeartbeatInput, ctx: ReturnType<typeof heartbeatContext>): HeartbeatResult {
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
    const signals = collectSignals(input, ctx.projectID);
    recordHeartbeatEvent(input.database, ctx, "collect_signals", signals);
    const policy = evaluatePolicies(input.database);
    recordHeartbeatEvent(input.database, ctx, "evaluate_policies", policy);
    const plan = planActions(signals, ctx.projectID);
    recordHeartbeatEvent(input.database, ctx, "plan_actions", { count: plan.length });
    recordHeartbeatEvent(input.database, ctx, "authorization_gate", policy);
    const proposed = proposeActions(input.database, ctx, plan);
    const result = completedResult(ctx, signals, policy, plan, proposed.map((item) => item.id));
    recordHeartbeatEvent(input.database, ctx, "audit", { actions_proposed: proposed.length });
    recordHeartbeatEvent(input.database, ctx, "schedule_next_tick", { next_tick_at: result.next_tick_at });
    updatePiHeartbeatRun(input.database, run.id, storedRunResult(result, ctx.nowText));
    updateDelegationTick(input.database, input.delegation, ctx.nowText, result.next_tick_at);
    return result;
  } catch (error) {
    const result = failedResult(ctx, safeError(error));
    recordHeartbeatEvent(input.database, ctx, "error", {}, result.error);
    updatePiHeartbeatRun(input.database, run.id, storedRunResult(result, ctx.nowText));
    updateDelegationTick(input.database, input.delegation, ctx.nowText, result.next_tick_at);
    return result;
  }
}

function collectSignals(input: HeartbeatInput, projectID: string): HeartbeatSignals {
  if (input.collectSignals) return input.collectSignals({ database: input.database, now: input.now ?? new Date(), projectID });
  return collectProjectHeartbeatSignals(input.database, projectID, input.now ?? new Date());
}

function evaluatePolicies(db: RunnerDatabase): HeartbeatPolicy {
  return { executor_busy: hasActiveExecutorWork(db), paused: false, propose_only: true };
}

function planActions(signals: HeartbeatSignals, projectID: string): HeartbeatActionCandidate[] {
  return (signals.project?.findings ?? []).flatMap((finding) => {
    if (!finding.action_candidate) return [];
    return [normalizePiActionEnvelope({
      action_type: finding.action_candidate.action_type,
      payload: finding.action_candidate.payload,
      issue_id: finding.issue_id > 0 ? finding.issue_id : undefined,
      project_id: projectID,
      rationale: finding.action_candidate.rationale,
      risk_level: "medium",
      source: "pi_heartbeat"
    })];
  });
}

function proposeActions(db: RunnerDatabase, ctx: ReturnType<typeof heartbeatContext>, plan: HeartbeatActionCandidate[]) {
  return plan.map((candidate) => {
    const action = createPiAction(db, {
      action_type: candidate.action_type,
      delegation_id: ctx.delegationID,
      heartbeat_id: ctx.heartbeatID,
      id: crypto.randomUUID(),
      issue_id: candidate.issue_id ?? 0,
      payload_json: JSON.stringify(candidate.payload),
      project_id: candidate.project_id,
      rationale: candidate.rationale,
      requires_confirmation: 1,
      result_json: JSON.stringify({ delegation_id: ctx.delegationID, heartbeat_id: ctx.heartbeatID, source: "pi_heartbeat" }),
      risk_level: candidate.risk_level,
      source: candidate.source,
      status: "pending"
    });
    recordHeartbeatEvent(db, ctx, "action_proposed", candidate);
    return action;
  });
}

function completedResult(
  ctx: ReturnType<typeof heartbeatContext>,
  signals: HeartbeatSignals,
  policy: HeartbeatPolicy,
  plan: HeartbeatActionCandidate[],
  actionIDs: string[]
): HeartbeatResult {
  return {
    action_candidates: plan,
    actions_proposed: actionIDs.length,
    delegation_id: ctx.delegationID,
    error: "",
    executed_actions: [],
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
    cron: { active: 0, due: 0, total: 0 },
    delegations: { active: 0, due: 0 },
    issues: { status_counts: {}, total: 0 },
    memory: { active: 0, pinned: 0 },
    pi_conversations: { active: 0, total: 0 },
    provider_health: { provider: "", status: "unknown" },
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
