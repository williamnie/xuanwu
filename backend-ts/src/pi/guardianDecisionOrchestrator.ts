import type { RunnerDatabase } from "../db/database.ts";
import {
  getPiGuardianDecision,
  listPiGuardianDecisions,
  listPiGuardianEvents,
  transitionPiGuardianDecisionState,
  updatePiGuardianEvent,
  upsertPiGuardianDecision,
  type PiGuardianDecision,
  type PiGuardianEvent
} from "../db/repositories/pi.ts";
import {
  guardianDecisionCandidate,
  guardianDecisionBaseKey,
  guardianDecisionMergeMeta,
  guardianDecisionPlan,
  isActiveGuardianDecision,
  mergeEvidenceJson,
  shouldBreakGuardianDecisionWindow,
  type GuardianDecisionCandidate,
  type GuardianDecisionPlan
} from "./guardianDecisionMerge.ts";
import {
  createDeferredGuardianDecision,
  guardianDecisionRateLimit,
  rescheduleDeferredGuardianDecisions
} from "./guardianDecisionRateLimit.ts";

export type GuardianDecisionOrchestratorOptions = {
  limit?: number;
  now?: Date;
};
export type GuardianDecisionOrchestratorSummary = {
  break_window: number;
  bypassed: number;
  cooldown_suppressed: number;
  created: number;
  deferred: number;
  errors: number;
  merged: number;
  rescheduled: number;
  scanned: number;
};

const DEFAULT_LIMIT = 50;

export function runGuardianDecisionOrchestratorOnce(
  db: RunnerDatabase,
  options: GuardianDecisionOrchestratorOptions = {}
): GuardianDecisionOrchestratorSummary {
  const summary = emptySummary();
  const now = options.now ?? new Date();
  summary.rescheduled += rescheduleDeferredGuardianDecisions(db, now);
  const events = pendingEvents(db, options.limit ?? DEFAULT_LIMIT);
  for (const event of events) {
    summary.scanned += 1;
    try {
      processEvent(db, event, now, summary);
    } catch (error) {
      summary.errors += 1;
      updatePiGuardianEvent(db, event.id, {
        error: error instanceof Error ? error.message : "guardian decision orchestration failed",
        status: "failed"
      });
    }
  }
  return summary;
}

function processEvent(
  db: RunnerDatabase,
  event: PiGuardianEvent,
  now: Date,
  summary: GuardianDecisionOrchestratorSummary
): void {
  const candidate = guardianDecisionCandidate(event);
  const current = activeDecisionForCandidate(db, candidate);
  const forceImmediate = Boolean(current && shouldBreakGuardianDecisionWindow(current, candidate));
  if (!forceImmediate && !current && suppressForCooldown(db, candidate, now)) {
    summary.cooldown_suppressed += 1;
    consumeEvent(db, event, now);
    return;
  }
  if (forceImmediate && current) {
    summary.break_window += 1;
    transitionPiGuardianDecisionState(db, current.id, {
      rationale: "severity upgraded inside guardian decision merge window",
      to: "superseded"
    });
  }
  const plan = guardianDecisionPlan(candidate, now, forceImmediate);
  if (opensNewTurn(current, forceImmediate)) {
    const rateLimit = guardianDecisionRateLimit(db, candidate, now);
    if (!rateLimit.allowed) {
      createDeferredGuardianDecision({ candidate, db, plan, rateLimit });
      summary.deferred += 1;
      consumeEvent(db, event, now);
      return;
    }
  }
  const existing = reusableDecision(db, current, plan, forceImmediate);
  writeDecision(db, candidate, plan, existing);
  summary.created += existing ? 0 : 1;
  summary.merged += existing ? 1 : 0;
  summary.bypassed += plan.window_ms === 0 ? 1 : 0;
  consumeEvent(db, event, now);
}

function opensNewTurn(current: PiGuardianDecision | null, forceImmediate: boolean): boolean {
  return forceImmediate || !current;
}

function reusableDecision(
  db: RunnerDatabase,
  current: PiGuardianDecision | null,
  plan: GuardianDecisionPlan,
  forceImmediate: boolean
): PiGuardianDecision | null {
  if (forceImmediate || plan.window_ms === 0) return getPiGuardianDecision(db, plan.id);
  return current ?? getPiGuardianDecision(db, plan.id);
}

function activeDecisionForCandidate(
  db: RunnerDatabase,
  candidate: GuardianDecisionCandidate
): PiGuardianDecision | null {
  const baseKey = guardianDecisionBaseKey(candidate);
  return listPiGuardianDecisions(db, {
    decisionKind: candidate.decision_kind,
    issueId: candidate.issue_id,
    projectId: candidate.project_id
  }).find((decision) => matchesActiveDecision(decision, baseKey)) ?? null;
}

function matchesActiveDecision(decision: PiGuardianDecision, baseKey: string): boolean {
  if (!isActiveGuardianDecision(decision)) return false;
  const meta = guardianDecisionMergeMeta(decision);
  return meta?.base_key === baseKey || decision.idempotency_key.startsWith(`${baseKey}:`);
}

function suppressForCooldown(db: RunnerDatabase, candidate: GuardianDecisionCandidate, now: Date): boolean {
  if (["actionable", "urgent"].includes(candidate.severity) || candidate.decision_kind === "approval") return false;
  const baseKey = guardianDecisionBaseKey(candidate);
  const timestamp = iso(now);
  return listPiGuardianDecisions(db, {
    decisionKind: candidate.decision_kind,
    issueId: candidate.issue_id,
    projectId: candidate.project_id
  }).some((decision) =>
    decision.idempotency_key.startsWith(`${baseKey}:`) &&
    decision.cooldown_until !== "" &&
    decision.cooldown_until > timestamp
  );
}

function writeDecision(
  db: RunnerDatabase,
  candidate: GuardianDecisionCandidate,
  plan: GuardianDecisionPlan,
  existing: PiGuardianDecision | null
): void {
  const effectivePlan = existingPlan(existing, plan);
  upsertPiGuardianDecision(db, {
    authority: "policy",
    conversation_id: candidate.conversation_id,
    cooldown_until: existing?.cooldown_until || effectivePlan.cooldown_until,
    decision: existing?.decision || candidate.decision,
    decision_kind: candidate.decision_kind,
    evidence_json: mergeEvidenceJson(existing, candidate, effectivePlan),
    id: existing?.id || effectivePlan.id,
    idempotency_key: effectivePlan.idempotency_key,
    issue_id: candidate.issue_id,
    project_id: candidate.project_id,
    rationale: existing?.rationale || rationale(candidate, plan),
    requires_user: Math.max(existing?.requires_user ?? 0, candidate.requires_user),
    risk_level: riskLevel(existing?.risk_level, candidate.risk_level),
    run_group_id: candidate.run_group_id,
    source_event_id: candidate.source_event_id,
    source_event_sequence_id: candidate.source_event_sequence_id,
    state: "proposed"
  });
}

function riskLevel(existing: string | undefined, next: string): string {
  const rank: Record<string, number> = { high: 3, low: 1, medium: 2 };
  return (rank[existing ?? ""] ?? 0) > (rank[next] ?? 0) ? existing as string : next;
}

function pendingEvents(db: RunnerDatabase, limit: number): PiGuardianEvent[] {
  return listPiGuardianEvents(db, { status: "pending" }).slice(0, Math.max(1, limit));
}

function existingPlan(existing: PiGuardianDecision | null, plan: GuardianDecisionPlan): GuardianDecisionPlan {
  if (!existing) return plan;
  const meta = guardianDecisionMergeMeta(existing);
  return {
    ...plan,
    cooldown_until: existing.cooldown_until,
    id: existing.id,
    idempotency_key: existing.idempotency_key,
    window_ms: meta?.window_ms ?? plan.window_ms
  };
}

function consumeEvent(db: RunnerDatabase, event: PiGuardianEvent, now: Date): void {
  updatePiGuardianEvent(db, event.id, {
    consumed_at: event.consumed_at || iso(now),
    status: "consumed"
  });
}

function rationale(candidate: GuardianDecisionCandidate, plan: GuardianDecisionPlan): string {
  if (plan.window_ms === 0) return `${candidate.severity} ${candidate.decision_kind} bypasses guardian merge window`;
  return `${candidate.severity} ${candidate.decision_kind} merged by guardian decision window`;
}

function emptySummary(): GuardianDecisionOrchestratorSummary {
  return {
    break_window: 0,
    bypassed: 0,
    cooldown_suppressed: 0,
    created: 0,
    deferred: 0,
    errors: 0,
    merged: 0,
    rescheduled: 0,
    scanned: 0
  };
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
