import type { RunnerDatabase } from "../db/database.ts";
import { getIssue, listIssues, type Issue } from "../db/repositories/issues.ts";
import { getProjectPiSettings, isPiHeartbeatPaused } from "../db/repositories/pi.ts";
import { readIssueVerificationProjection } from "../domain/review/humanReview.ts";
import { resolveIssueAgentRole, resolveWorkflowParentIssueID } from "../pi/agentOrchestration.ts";
import {
  readPiVerificationActivity,
  recordPiVerificationActivity
} from "../domain/review/piVerificationActivity.ts";
import { redactSensitiveText } from "../util/redact.ts";
import { writeBackVerifierWorkflowEvidence } from "./verifierWorkflowWriteback.ts";

export type PiVerificationCycleRunner = (input: {
  maxActions: number;
  projectId: string;
}) => Promise<unknown>;

export type PiVerificationCoordinatorInput = {
  cooldownMs?: number;
  database: RunnerDatabase;
  maxActions?: number;
  now?: Date;
  runProjectCycle: PiVerificationCycleRunner;
  source?: string;
};

export type PiVerificationCoordinatorResult = {
  failed: number;
  issues: number;
  projects: number;
  skipped: number;
  started: number;
};

const activeProjects = new Set<string>();
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
const DEFAULT_MAX_ACTIONS = 5;

export async function runPiVerificationCoordinatorOnce(
  input: PiVerificationCoordinatorInput
): Promise<PiVerificationCoordinatorResult> {
  const now = input.now ?? new Date();
  await settleCompletedVerifierCarriers(input.database, now, input.source);
  const grouped = groupByProject(dueIssues(input.database, now, input.cooldownMs ?? DEFAULT_COOLDOWN_MS));
  const result: PiVerificationCoordinatorResult = {
    failed: 0,
    issues: [...grouped.values()].reduce((count, issues) => count + issues.length, 0),
    projects: grouped.size,
    skipped: 0,
    started: 0
  };
  for (const [projectID, issues] of grouped) {
    if (activeProjects.has(projectID)) {
      result.skipped += issues.length;
      continue;
    }
    result.started += 1;
    const outcome = await dispatchProjectVerificationCycle({
      database: input.database,
      issues,
      maxActions: input.maxActions ?? DEFAULT_MAX_ACTIONS,
      projectID,
      runProjectCycle: input.runProjectCycle,
      source: input.source ?? "pi-verification-coordinator"
    });
    if (!outcome.ok) result.failed += 1;
  }
  return result;
}

export function requestPiVerificationCycle(
  input: PiVerificationCoordinatorInput & { issueID: number }
): void {
  const issue = getIssue(input.database, input.issueID);
  if (
    !issue
    || !getProjectPiSettings(input.database, issue.project_id)
    || isPiHeartbeatPaused(input.database, { scopeId: issue.project_id, scopeType: "project" })
    || !piOwnedPending(input.database, issue)
  ) return;
  const activity = readPiVerificationActivity(input.database, issue.id);
  const attempt = nextAttempt(activity?.attempt);
  if (activity?.status !== "queued" && activity?.status !== "running") {
    recordPiVerificationActivity(input.database, issue.id, "queued", {
      attempt,
      project_id: issue.project_id,
      source: input.source ?? "pi-verification-request"
    });
  }
  if (activeProjects.has(issue.project_id)) return;
  void dispatchProjectVerificationCycle({
    database: input.database,
    issues: [issue],
    maxActions: input.maxActions ?? DEFAULT_MAX_ACTIONS,
    projectID: issue.project_id,
    runProjectCycle: input.runProjectCycle,
    source: input.source ?? "pi-verification-request"
  });
}

async function dispatchProjectVerificationCycle(input: {
  database: RunnerDatabase;
  issues: Issue[];
  maxActions: number;
  projectID: string;
  runProjectCycle: PiVerificationCycleRunner;
  source: string;
}): Promise<{ error: string; ok: boolean }> {
  if (activeProjects.has(input.projectID)) return { error: "", ok: true };
  activeProjects.add(input.projectID);
  const attempts = new Map<number, number>();
  try {
    for (const issue of input.issues) {
      const activity = readPiVerificationActivity(input.database, issue.id);
      const attempt = activity?.status === "queued" ? activity.attempt : nextAttempt(activity?.attempt);
      attempts.set(issue.id, attempt);
      recordPiVerificationActivity(input.database, issue.id, "running", {
        attempt,
        project_id: issue.project_id,
        source: input.source
      });
    }
    await input.runProjectCycle({
      maxActions: input.maxActions,
      projectId: input.projectID
    });
    for (const original of input.issues) {
      const current = getIssue(input.database, original.id);
      const attempt = attempts.get(original.id) ?? 1;
      if (!current || terminal(current.status)) {
        if (current) recordPiVerificationActivity(input.database, current.id, "completed", {
          attempt,
          project_id: current.project_id,
          source: input.source
        });
        continue;
      }
      if (readIssueVerificationProjection(input.database, current.id).owner === "human") {
        recordPiVerificationActivity(input.database, current.id, "completed", {
          attempt,
          project_id: current.project_id,
          source: input.source
        });
        continue;
      }
      recordPiVerificationActivity(input.database, current.id, "waiting", {
        attempt,
        error: "PI manager cycle completed; verification is still pending and will be retried",
        project_id: current.project_id,
        source: input.source
      });
    }
    return { error: "", ok: true };
  } catch (error) {
    const message = safeError(error);
    for (const issue of input.issues) {
      recordPiVerificationActivity(input.database, issue.id, "failed", {
        attempt: attempts.get(issue.id) ?? 1,
        error: message,
        project_id: issue.project_id,
        source: input.source
      });
    }
    return { error: message, ok: false };
  } finally {
    activeProjects.delete(input.projectID);
  }
}

function dueIssues(db: RunnerDatabase, now: Date, cooldownMs: number): Issue[] {
  return listIssues(db, { status: "pending_verification" }).filter((issue) => {
    if (!getProjectPiSettings(db, issue.project_id)) return false;
    if (isPiHeartbeatPaused(db, { scopeId: issue.project_id, scopeType: "project" })) return false;
    if (!piOwnedPending(db, issue)) return false;
    const activity = readPiVerificationActivity(db, issue.id);
    if (!activity) return true;
    if (activity.status === "running" || activity.status === "queued") {
      return ageMs(activity.updated_at, now) >= Math.max(cooldownMs, 10 * 60_000);
    }
    if (Date.parse(issue.updated_at) > Date.parse(activity.updated_at)) return true;
    return ageMs(activity.updated_at, now) >= cooldownMs;
  });
}

function piOwnedPending(db: RunnerDatabase, issue: Issue): boolean {
  return issue.status === "pending_verification"
    && !isVerifierCarrier(issue)
    && readIssueVerificationProjection(db, issue.id).owner === "pi";
}

async function settleCompletedVerifierCarriers(
  db: RunnerDatabase,
  now: Date,
  source = "pi-verification-coordinator"
): Promise<void> {
  const carriers = listIssues(db, { status: "pending_verification" }).filter(isVerifierCarrier);
  for (const carrier of carriers) {
    await writeBackVerifierWorkflowEvidence(db, carrier.id, {
      now,
      source: `${source}:settle-verifier-carrier`
    });
  }
}

function isVerifierCarrier(issue: Issue): boolean {
  return resolveIssueAgentRole(issue) === "verifier" && resolveWorkflowParentIssueID(issue) > 0;
}

function groupByProject(issues: Issue[]): Map<string, Issue[]> {
  const grouped = new Map<string, Issue[]>();
  for (const issue of issues) {
    const current = grouped.get(issue.project_id) ?? [];
    current.push(issue);
    grouped.set(issue.project_id, current);
  }
  return grouped;
}

function nextAttempt(attempt: number | undefined): number {
  return typeof attempt === "number" && attempt > 0 ? attempt + 1 : 1;
}

function terminal(status: string): boolean {
  return status === "done" || status === "failed" || status === "cancelled";
}

function ageMs(value: string, now: Date): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, now.getTime() - timestamp) : Number.POSITIVE_INFINITY;
}

function safeError(error: unknown): string {
  return redactSensitiveText(error instanceof Error ? error.message : String(error));
}
