import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssueRuns, listIssues, type Issue } from "../db/repositories/issues.ts";
import { getProjectPiSettings, isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import {
  buildIssueCompletionCard,
  readCurrentIssueCompletionCard,
  recordIssueCompletionCard,
  type CompletionCard
} from "../domain/acceptance/completionCard.ts";
import { readIssueDecisionProjection } from "../domain/review/humanReview.ts";
import { listIssueEvents, recordIssueEvent } from "../db/repositories/issueEvents.ts";
import {
  readPiAcceptanceActivity,
  recordPiAcceptanceActivity
} from "../domain/review/piAcceptanceActivity.ts";
import type { EventBus } from "../events/bus.ts";
import type { PiAcceptanceRuntimeResult } from "../pi/issueAcceptance.ts";
import type { ExecutorProvider, ExecutorProviderId } from "../providers/types.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { applyPiAcceptanceDecision } from "./piAcceptanceApplication.ts";
import { startProjectLoop } from "./projectLoopManager.ts";

export type PiIssueAcceptanceRunner = (card: CompletionCard) => Promise<PiAcceptanceRuntimeResult>;

export type PiAcceptanceCoordinatorInput = {
  bus?: Pick<EventBus, "publish">;
  cooldownMs?: number;
  database: RunnerDatabase;
  decideIssueAcceptance: PiIssueAcceptanceRunner;
  now?: Date;
  providers?: Partial<Record<ExecutorProviderId, ExecutorProvider>>;
  source?: string;
};

export type PiAcceptanceCoordinatorResult = {
  failed: number;
  issues: number;
  projects: number;
  skipped: number;
  started: number;
};

const activeIssues = new Set<number>();
const DEFAULT_COOLDOWN_MS = 30_000;
const SESSION_READ_TIMEOUT_MS = 10_000;

export async function runPiAcceptanceCoordinatorOnce(
  input: PiAcceptanceCoordinatorInput
): Promise<PiAcceptanceCoordinatorResult> {
  const now = input.now ?? new Date();
  const issues = dueIssues(input.database, now, input.cooldownMs ?? DEFAULT_COOLDOWN_MS);
  const result: PiAcceptanceCoordinatorResult = {
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

export function requestPiAcceptanceCycle(
  input: PiAcceptanceCoordinatorInput & { issueID: number }
): void {
  const issue = getIssue(input.database, input.issueID);
  if (!issue || !piOwnedPending(input.database, issue) || activeIssues.has(issue.id)) return;
  void dispatchIssueAcceptance(input, issue, input.now ?? new Date());
}

async function dispatchIssueAcceptance(
  input: PiAcceptanceCoordinatorInput,
  issue: Issue,
  now: Date
): Promise<{ error: string; ok: boolean }> {
  if (activeIssues.has(issue.id)) return { error: "", ok: true };
  activeIssues.add(issue.id);
  let card: CompletionCard | undefined;
  const previous = readPiAcceptanceActivity(input.database, issue.id);
  let attemptKey = preCardAttemptKey(input.database, issue);
  let attempt = previous?.card_fingerprint === attemptKey ? previous.attempt + 1 : 1;
  try {
    const built = await buildIssueCompletionCard(input.database, issue.id, {
      now,
      session: await completionSessionInput(input, issue)
    });
    const current = readCurrentIssueCompletionCard(input.database, issue.id);
    card = current?.fingerprint === built.fingerprint ? current : built;
    recordIssueCompletionCard(input.database, card, input.source ?? "pi-acceptance-coordinator");
    attemptKey = card.fingerprint;
    attempt = previous?.card_fingerprint === card.fingerprint ? previous.attempt + 1 : 1;
    recordPiAcceptanceActivity(input.database, issue.id, "running", {
      attempt,
      card_fingerprint: card.fingerprint,
      project_id: issue.project_id,
      source: input.source ?? "pi-acceptance-coordinator"
    });
    const result = await input.decideIssueAcceptance(card);
    if (!result.valid) throw new Error(result.error || "PI acceptance returned an invalid decision");
    const decision = result.decision;
    const updated = await applyPiAcceptanceDecision({
      bus: input.bus,
      database: input.database,
      providers: input.providers
    }, card, decision);
    if (updated.status === "done" || updated.status === "failed" || updated.status === "cancelled") {
      startProjectLoop({
        bus: input.bus,
        database: input.database,
        providers: input.providers
      }, updated.project_id);
    }
    recordPiAcceptanceActivity(input.database, issue.id, "completed", {
      attempt,
      card_fingerprint: card.fingerprint,
      decision: decision.decision,
      project_id: issue.project_id,
      source: input.source ?? "pi-acceptance-coordinator"
    });
    return { error: "", ok: terminalOrProgressing(updated.status) };
  } catch (error) {
    const message = safeError(error);
    recordPiAcceptanceActivity(input.database, issue.id, "failed", {
      attempt,
      card_fingerprint: card?.fingerprint ?? attemptKey,
      error: message,
      project_id: issue.project_id,
      source: input.source ?? "pi-acceptance-coordinator"
    });
    recordDecisionRuntimeFailure(input, issue, card, message, attempt);
    return { error: message, ok: false };
  } finally {
    activeIssues.delete(issue.id);
  }
}

async function completionSessionInput(
  input: PiAcceptanceCoordinatorInput,
  issue: Issue
): Promise<{ error?: string; summary?: Record<string, unknown> } | undefined> {
  const run = listIssueRuns(input.database, issue.id).at(-1);
  if (!run || run.provider_session_id === "") return undefined;
  const providerID = run.provider as ExecutorProviderId;
  const provider = input.providers?.[providerID];
  if (!provider?.readSession) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`session read timed out after ${SESSION_READ_TIMEOUT_MS}ms`)), SESSION_READ_TIMEOUT_MS);
    });
    const summary = await Promise.race([provider.readSession(run.provider_session_id), timeout]);
    return { summary };
  } catch (error) {
    return { error: safeError(error) };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function dueIssues(db: RunnerDatabase, now: Date, cooldownMs: number): Issue[] {
  return listIssues(db, { status: "in_progress" }).filter((issue) => {
    if (!piOwnedPending(db, issue)) return false;
    const activity = readPiAcceptanceActivity(db, issue.id);
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
  const latestRun = listIssueRuns(db, issue.id).at(-1);
  return issue.status === "in_progress"
    && latestRun?.ended_at !== ""
    && piDecisionRequested(db, issue.id, latestRun?.id ?? "")
    && Boolean(getProjectPiSettings(db, issue.project_id))
    && !isPiHeartbeatPaused(db, { scopeId: issue.project_id, scopeType: "project" })
    && readIssueDecisionProjection(db, issue.id).owner === "pi";
}

function piDecisionRequested(db: RunnerDatabase, issueID: number, runID: string): boolean {
  if (runID === "") return false;
  return listIssueEvents(db, issueID, {
    limit: 100,
    types: ["issue.pi_acceptance_requested.v1"]
  }).some((event) => {
    try {
      return cleanString((JSON.parse(event.payload) as Record<string, unknown>).issue_run_id) === runID;
    } catch {
      return false;
    }
  });
}

function recordDecisionRuntimeFailure(
  input: PiAcceptanceCoordinatorInput,
  issue: Issue,
  card: CompletionCard | undefined,
  error: string,
  attempt: number
): void {
  const fingerprint = card?.fingerprint ?? preCardAttemptKey(input.database, issue);
  const exists = listIssueEvents(input.database, issue.id, {
    limit: 20,
    types: ["issue.pi_acceptance_runtime_failed.v1"]
  }).some((event) => {
    try {
      const payload = JSON.parse(event.payload) as Record<string, unknown>;
      return cleanString(payload.card_fingerprint) === fingerprint && Number(payload.attempt) === attempt;
    } catch {
      return false;
    }
  });
  if (exists) return;
  const latestRun = listIssueRuns(input.database, issue.id).at(-1);
  recordIssueEvent(input.database, issue.id, "issue.pi_acceptance_runtime_failed.v1", {
    attempt,
    card_fingerprint: fingerprint,
    error,
    issue_id: issue.id,
    reason: "PI runtime failed; Issue remains in_progress and the coordinator will retry after cooldown",
    run_id: card?.run.id ?? latestRun?.id ?? ""
  });
}

function preCardAttemptKey(db: RunnerDatabase, issue: Issue): string {
  const run = listIssueRuns(db, issue.id).at(-1);
  return `precard:${issue.id}:${issue.updated_at}:${run?.id ?? "none"}:${run?.ended_at ?? ""}`;
}

function terminalOrProgressing(status: string): boolean {
  return status === "done" || status === "failed" || status === "needs_user" || status === "in_progress";
}

function ageMs(value: string, now: Date): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : Number.POSITIVE_INFINITY;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
