import type { RunnerDatabase } from "../db/database.ts";
import {
  listPiGuardianDecisions,
  upsertPiGuardianDecision,
  type PiGuardianDecision
} from "../db/repositories/pi.ts";
import {
  guardianDecisionBaseKey,
  guardianDecisionMergeMeta,
  mergeEvidenceJson,
  type GuardianDecisionPlan,
  type GuardianDecisionCandidate
} from "./guardianDecisionMerge.ts";

export type GuardianDecisionRateLimitResult =
  | { allowed: true }
  | {
    allowed: false;
    limit: number;
    retry_at: string;
    scope: "global" | "project" | "recovery" | "run_group";
    window_ms: number;
  };
export type DeferredGuardianDecisionInput = {
  candidate: GuardianDecisionCandidate;
  db: RunnerDatabase;
  plan: GuardianDecisionPlan;
  rateLimit: Exclude<GuardianDecisionRateLimitResult, { allowed: true }>;
};

type RecentDecision = Pick<
  PiGuardianDecision,
  "created_at" | "decision_kind" | "evidence_json" | "id" | "issue_id" | "project_id" | "run_group_id" | "state"
>;

const GLOBAL_LIMIT = 10;
const PROJECT_LIMIT = 3;
const RECOVERY_LIMIT = 1;
const RUN_GROUP_LIMIT = 1;
const ONE_MINUTE_MS = 60_000;
const RECOVERY_WINDOW_MS = 300_000;
const RUN_GROUP_WINDOW_MS = 120_000;

export function guardianDecisionRateLimit(
  db: RunnerDatabase,
  candidate: GuardianDecisionCandidate,
  now: Date
): GuardianDecisionRateLimitResult {
  if (bypassesRateLimit(candidate)) return { allowed: true };
  return recoveryLimit(db, candidate, now) ??
    runGroupLimit(db, candidate, now) ??
    projectLimit(db, candidate, now) ??
    globalLimit(db, now) ??
    { allowed: true };
}

export function guardianDecisionRateLimitEvidence(
  result: Exclude<GuardianDecisionRateLimitResult, { allowed: true }>
): Record<string, unknown> {
  return {
    guardian_decision_rate_limit: {
      limit: result.limit,
      retry_at: result.retry_at,
      scope: result.scope,
      window_ms: result.window_ms
    }
  };
}

export function createDeferredGuardianDecision(input: DeferredGuardianDecisionInput): void {
  const { candidate, db, plan, rateLimit } = input;
  const id = deferredDecisionID(candidate, plan);
  upsertPiGuardianDecision(db, {
    authority: "policy",
    conversation_id: candidate.conversation_id,
    cooldown_until: rateLimit.retry_at,
    decision: candidate.decision,
    decision_kind: candidate.decision_kind,
    evidence_json: deferredEvidence(candidate, plan, rateLimit),
    id,
    idempotency_key: id,
    issue_id: candidate.issue_id,
    project_id: candidate.project_id,
    rationale: `backpressure_deferred:${rateLimit.scope} PI decision rate limit`,
    requires_user: candidate.requires_user,
    risk_level: candidate.risk_level,
    run_group_id: candidate.run_group_id,
    source_event_id: candidate.source_event_id,
    source_event_sequence_id: candidate.source_event_sequence_id,
    state: "deferred"
  });
}

export function rescheduleDeferredGuardianDecisions(db: RunnerDatabase, now: Date): number {
  const timestamp = iso(now);
  let rescheduled = 0;
  for (const decision of listPiGuardianDecisions(db, { state: "deferred" })) {
    if (decision.cooldown_until === "" || decision.cooldown_until > timestamp) continue;
    if (!hasRateLimitEvidence(decision)) continue;
    rescheduleDeferredDecision(db, decision, now);
    rescheduled += 1;
  }
  return rescheduled;
}

function recoveryLimit(
  db: RunnerDatabase,
  candidate: GuardianDecisionCandidate,
  now: Date
): GuardianDecisionRateLimitResult | null {
  if (candidate.decision_kind !== "recovery" || candidate.issue_id <= 0) return null;
  const baseKey = guardianDecisionBaseKey(candidate);
  const recent = recentDecisions(db, now, RECOVERY_WINDOW_MS)
    .filter((decision) => recoveryMatches(decision, candidate, baseKey));
  return limited("recovery", RECOVERY_LIMIT, RECOVERY_WINDOW_MS, recent, now);
}

function deferredDecisionID(candidate: GuardianDecisionCandidate, plan: GuardianDecisionPlan): string {
  return `${plan.id}:deferred:${candidate.event_id}`;
}

function deferredEvidence(
  candidate: GuardianDecisionCandidate,
  plan: GuardianDecisionPlan,
  rateLimit: Exclude<GuardianDecisionRateLimitResult, { allowed: true }>
): string {
  return JSON.stringify([
    ...jsonEvidence(mergeEvidenceJson(null, candidate, plan)),
    guardianDecisionRateLimitEvidence(rateLimit)
  ]);
}

function hasRateLimitEvidence(decision: PiGuardianDecision): boolean {
  return jsonEvidence(decision.evidence_json)
    .some((item) => typeof item.guardian_decision_rate_limit === "object");
}

function rescheduleDeferredDecision(db: RunnerDatabase, decision: PiGuardianDecision, now: Date): void {
  db.sqlite.run(`update pi_guardian_decisions set state='proposed', rationale=?, cooldown_until='', updated_at=?
    where id=? and state='deferred'`, [
    "backpressure_deferred cooldown elapsed; rescheduled",
    iso(now),
    decision.id
  ]);
}

function runGroupLimit(
  db: RunnerDatabase,
  candidate: GuardianDecisionCandidate,
  now: Date
): GuardianDecisionRateLimitResult | null {
  if (candidate.decision_kind !== "notification" || candidate.run_group_id === "") return null;
  const recent = recentDecisions(db, now, RUN_GROUP_WINDOW_MS)
    .filter((decision) => decisionMatchesGroup(decision, candidate));
  return limited("run_group", RUN_GROUP_LIMIT, RUN_GROUP_WINDOW_MS, recent, now);
}

function projectLimit(
  db: RunnerDatabase,
  candidate: GuardianDecisionCandidate,
  now: Date
): GuardianDecisionRateLimitResult | null {
  if (!["info", "watch"].includes(candidate.severity) || candidate.project_id === "") return null;
  const recent = recentDecisions(db, now, ONE_MINUTE_MS)
    .filter((decision) => decisionMatchesProject(decision, candidate.project_id));
  return limited("project", PROJECT_LIMIT, ONE_MINUTE_MS, recent, now);
}

function globalLimit(db: RunnerDatabase, now: Date): GuardianDecisionRateLimitResult | null {
  const recent = recentDecisions(db, now, ONE_MINUTE_MS);
  return limited("global", GLOBAL_LIMIT, ONE_MINUTE_MS, recent, now);
}

function recentDecisions(db: RunnerDatabase, now: Date, windowMs: number): RecentDecision[] {
  const start = iso(new Date(now.getTime() - windowMs));
  return db.sqlite.query<RecentDecision, [string]>(
    `select id, decision_kind, evidence_json, issue_id, project_id, run_group_id, state, created_at
      from pi_guardian_decisions where created_at>=? order by created_at asc, id asc`
  ).all(start).filter(countsAsPiTurn);
}

function countsAsPiTurn(decision: RecentDecision): boolean {
  if (["deferred", "skipped", "superseded"].includes(decision.state)) return false;
  if (decision.decision_kind === "approval") return false;
  return guardianDecisionMergeMeta(decision as PiGuardianDecision)?.severity !== "urgent";
}

function recoveryMatches(
  decision: RecentDecision,
  candidate: GuardianDecisionCandidate,
  baseKey: string
): boolean {
  const meta = guardianDecisionMergeMeta(decision as PiGuardianDecision);
  return decision.decision_kind === "recovery" &&
    decision.issue_id === candidate.issue_id &&
    decision.project_id === candidate.project_id &&
    meta?.base_key === baseKey &&
    meta?.severity !== "urgent";
}

function decisionMatchesGroup(decision: RecentDecision, candidate: GuardianDecisionCandidate): boolean {
  return decision.decision_kind === "notification" &&
    decision.project_id === candidate.project_id &&
    decision.run_group_id === candidate.run_group_id;
}

function decisionMatchesProject(decision: RecentDecision, projectID: string): boolean {
  return decision.project_id === projectID;
}

function limited(
  scope: Exclude<GuardianDecisionRateLimitResult, { allowed: true }>["scope"],
  limit: number,
  windowMs: number,
  recent: RecentDecision[],
  now: Date
): GuardianDecisionRateLimitResult | null {
  if (recent.length < limit) return null;
  return {
    allowed: false,
    limit,
    retry_at: retryAt(recent, windowMs, now),
    scope,
    window_ms: windowMs
  };
}

function retryAt(recent: RecentDecision[], windowMs: number, now: Date): string {
  const oldest = Date.parse(recent[0]?.created_at ?? "");
  const retry = Number.isFinite(oldest) ? oldest + windowMs : now.getTime() + windowMs;
  return iso(new Date(Math.max(retry, now.getTime() + 1_000)));
}

function bypassesRateLimit(candidate: GuardianDecisionCandidate): boolean {
  return candidate.severity === "urgent" || candidate.decision_kind === "approval";
}

function jsonEvidence(value: string): Array<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isRecord) : [];
  } catch {
    return [];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function iso(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/, "Z");
}
