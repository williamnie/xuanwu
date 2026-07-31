import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssueRuns, listIssues, type Issue } from "../db/repositories/issues.ts";
import { getProjectPiSettings, isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import {
  buildIssueCompletionCard,
  readCurrentIssueCompletionCard,
  recordIssueCompletionCard,
  type CompletionCard
} from "../domain/acceptance/completionCard.ts";
import { createHumanReviewRequest, readIssueVerificationProjection } from "../domain/review/humanReview.ts";
import {
  readPiVerificationActivity,
  recordPiVerificationActivity
} from "../domain/review/piVerificationActivity.ts";
import type { EventBus } from "../events/bus.ts";
import type { PiAcceptanceRuntimeResult } from "../pi/issueAcceptance.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { applyPiAcceptanceDecision } from "./piAcceptanceApplication.ts";

export type PiIssueAcceptanceRunner = (card: CompletionCard) => Promise<PiAcceptanceRuntimeResult>;

export type PiVerificationCoordinatorInput = {
  bus?: Pick<EventBus, "publish">;
  cooldownMs?: number;
  database: RunnerDatabase;
  decideIssueAcceptance: PiIssueAcceptanceRunner;
  now?: Date;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  source?: string;
};

export type PiVerificationCoordinatorResult = {
  failed: number;
  issues: number;
  projects: number;
  skipped: number;
  started: number;
};

const activeIssues = new Set<number>();
const DEFAULT_COOLDOWN_MS = 30_000;
const MAX_DECISION_ATTEMPTS_PER_CARD = 2;

export async function runPiVerificationCoordinatorOnce(
  input: PiVerificationCoordinatorInput
): Promise<PiVerificationCoordinatorResult> {
  const now = input.now ?? new Date();
  const issues = dueIssues(input.database, now, input.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const result: PiVerificationCoordinatorResult = {
    failed: 0,
    issues: issues.length,
    projects: new Set(issues.map((issue) => issue.project_id)).size,
    skipped: 0,
    started: 0
  };
  for (const issue of issues) {
    if (activeIssues.has(issue.id)) {
      result.skipped += 1;
      continue;
    }
    result.started += 1;
    const outcome = await dispatchIssueAcceptance(input, issue, now);
    if (!outcome.ok) result.failed += 1;
  }
  return result;
}

export function requestPiVerificationCycle(
  input: PiVerificationCoordinatorInput & { issueID: number }
): void {
  const issue = getIssue(input.database, input.issueID);
  if (!issue || !piOwnedPending(input.database, issue) || activeIssues.has(issue.id)) return;
  void dispatchIssueAcceptance(input, issue, input.now ?? new Date());
}

async function dispatchIssueAcceptance(
  input: PiVerificationCoordinatorInput,
  issue: Issue,
  now: Date
): Promise<{ error: string; ok: boolean }> {
  if (activeIssues.has(issue.id)) return { error: "", ok: true };
  activeIssues.add(issue.id);
  let card: CompletionCard | undefined;
  const previous = readPiVerificationActivity(input.database, issue.id);
  let attemptKey = preCardAttemptKey(input.database, issue);
  let attempt = previous?.card_fingerprint === attemptKey ? previous.attempt + 1 : 1;
  try {
    card = readCurrentIssueCompletionCard(input.database, issue.id)
      ?? await buildIssueCompletionCard(input.database, issue.id, { now });
    recordIssueCompletionCard(input.database, card, input.source ?? "pi-acceptance-coordinator");
    attemptKey = card.fingerprint;
    attempt = previous?.card_fingerprint === card.fingerprint ? previous.attempt + 1 : 1;
    if (attempt > MAX_DECISION_ATTEMPTS_PER_CARD) {
      escalateDecisionFailure(input, issue, card, previous?.error || "PI acceptance did not produce an applicable decision");
      return { error: "PI acceptance circuit breaker opened", ok: false };
    }
    recordPiVerificationActivity(input.database, issue.id, "running", {
      attempt,
      card_fingerprint: card.fingerprint,
      project_id: issue.project_id,
      source: input.source ?? "pi-acceptance-coordinator"
    });
    const result = await input.decideIssueAcceptance(card);
    const decision = result.valid ? result.decision : {
      ...result.decision,
      decision: "needs_user" as const,
      rationale: result.error || result.decision.rationale
    };
    const updated = await applyPiAcceptanceDecision({
      bus: input.bus,
      database: input.database,
      providers: input.providers
    }, card, decision);
    recordPiVerificationActivity(input.database, issue.id, "completed", {
      attempt,
      card_fingerprint: card.fingerprint,
      decision: decision.decision,
      project_id: issue.project_id,
      source: input.source ?? "pi-acceptance-coordinator"
    });
    return { error: "", ok: terminalOrProgressing(updated.status) };
  } catch (error) {
    const message = safeError(error);
    recordPiVerificationActivity(input.database, issue.id, "failed", {
      attempt,
      card_fingerprint: card?.fingerprint ?? attemptKey,
      error: message,
      project_id: issue.project_id,
      source: input.source ?? "pi-acceptance-coordinator"
    });
    if (attempt >= MAX_DECISION_ATTEMPTS_PER_CARD) {
      escalateDecisionFailure(input, issue, card, message);
    }
    return { error: message, ok: false };
  } finally {
    activeIssues.delete(issue.id);
  }
}

function dueIssues(db: RunnerDatabase, now: Date, cooldownMs: number): Issue[] {
  return listIssues(db, { status: "pending_verification" }).filter((issue) => {
    if (!piOwnedPending(db, issue)) return false;
    const activity = readPiVerificationActivity(db, issue.id);
    if (!activity) return true;
    if (activity.status === "completed") {
      const currentCard = readCurrentIssueCompletionCard(db, issue.id);
      return currentCard?.fingerprint !== activity.card_fingerprint;
    }
    if (activity.status === "queued" || activity.status === "running") {
      return ageMs(activity.updated_at, now) >= Math.max(cooldownMs, 10 * 60_000);
    }
    return ageMs(activity.updated_at, now) >= cooldownMs;
  });
}

function piOwnedPending(db: RunnerDatabase, issue: Issue): boolean {
  return issue.status === "pending_verification"
    && Boolean(getProjectPiSettings(db, issue.project_id))
    && !isPiHeartbeatPaused(db, { scopeId: issue.project_id, scopeType: "project" })
    && readIssueVerificationProjection(db, issue.id).owner === "pi";
}

function escalateDecisionFailure(
  input: PiVerificationCoordinatorInput,
  issue: Issue,
  card: CompletionCard | undefined,
  error: string
): void {
  if (readIssueVerificationProjection(input.database, issue.id).owner === "human") return;
  const latestRun = listIssueRuns(input.database, issue.id).at(-1);
  createHumanReviewRequest(input.database, issue.id, {
    acceptance_summary: card
      ? [`Run ${card.run.id}`, `${card.commands.total} command observations`]
      : [`Issue #${issue.id}`, latestRun ? `Run ${latestRun.id}` : "No canonical Run was available"],
    consequences: "PI issue-scoped acceptance reached its bounded retry limit; automatic retries are stopped.",
    evidence_refs: card
      ? [`completion-card:${card.fingerprint}`, `run:${card.run.id}`]
      : [latestRun ? `run:${latestRun.id}` : `issue:${issue.id}`],
    kind: "acceptance",
    question: `PI 验收连续失败，已停止自动重试：${error}`,
    recommendation: "请查看小结卡片，选择接受、要求调整或拒绝。"
  }, { bus: input.bus });
}

function preCardAttemptKey(db: RunnerDatabase, issue: Issue): string {
  const run = listIssueRuns(db, issue.id).at(-1);
  return `precard:${issue.id}:${issue.updated_at}:${run?.id ?? "none"}:${run?.ended_at ?? ""}`;
}

function terminalOrProgressing(status: string): boolean {
  return status === "done" || status === "in_progress" || status === "pending_verification";
}

function ageMs(value: string, now: Date): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : Number.POSITIVE_INFINITY;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
