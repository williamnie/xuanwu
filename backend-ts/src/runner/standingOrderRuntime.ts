import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import {
  getProjectPiSettings,
  isPiHeartbeatPaused,
  readProjectPiPolicy
} from "../db/repositories/pi.ts";
import type { AutomationDefinition, VersionedAutomationTrigger } from "../domain/automation/contracts.ts";
import { getIssueAsWork } from "../domain/work/issueAdapter.ts";
import { collectProjectHeartbeatSignals } from "../pi/heartbeatSignals.ts";
import { listSupervisorCommitments } from "../pi/supervisorCommitments.ts";
import { quietHoursResumeAt } from "../schedule/cronSchedule.ts";
import type {
  AutomationExecutionPreparation,
  AutomationExecutionPreparationInput
} from "./automationWorkRunExecutor.ts";

const DEFAULT_PROJECT_BUDGET = 5;
const CONTEXT_SCHEMA = "xw.standing-order-context.v1";

type StandingOrderContextItem = {
  kind: "issue_signal" | "supervisor_commitment";
  payload: Record<string, unknown>;
  ref: string;
  updated_at: string;
};

export type StandingOrderContext = {
  automation_id: string;
  budget: { consumed: number; limit: number };
  heartbeat_summary: {
    active_commitments: number;
    issue_signals: number;
    issue_total: number;
    open_issue_runs: number;
  };
  items: StandingOrderContextItem[];
  permission_policy_ref: string;
  schema_version: typeof CONTEXT_SCHEMA;
  scope: { kind: "project"; project_id: string };
  selected_at: string;
  trigger: { poll_interval_seconds: number; type: "continuous" };
};

/**
 * A continuous native Automation is the standing-order definition authority.
 * This deterministic preflight only selects bounded project context and gates
 * Work materialization; it does not own a second definition, cursor, or action path.
 */
export function prepareStandingOrderExecution(
  input: AutomationExecutionPreparationInput
): AutomationExecutionPreparation {
  if (input.trigger.type !== "continuous") return {};
  if (input.automation.owner.kind !== "project") {
    return skipped("standing order suppressed: continuous checks require an explicit project scope");
  }

  const projectID = input.automation.owner.project_id;
  if (input.existing_link) {
    return { context: selectContext(input.database, input.automation, input.trigger, input.now, projectID, true) };
  }
  if (isPiHeartbeatPaused(input.database, { scopeId: projectID, scopeType: "project" })) {
    return skipped(`standing order suppressed: project heartbeat is paused for ${projectID}`);
  }

  const policy = readProjectPiPolicy(input.database, projectID);
  const quietUntil = quietHoursResumeAt({
    mode: "daily",
    next_run_at: input.now.toISOString(),
    quiet_hours_json: policy.quiet_hours_json,
    time_of_day: "00:00",
    timezone: policy.timezone
  }, input.now);
  if (quietUntil !== "") return skipped(`standing order suppressed: quiet hours until ${quietUntil}`);

  const budget = projectBudget(input.database, projectID);
  const consumed = consumedProjectBudget(input.database, projectID, input.now);
  if (consumed >= budget) {
    return skipped(`standing order suppressed: project cycle budget exhausted (${consumed}/${budget})`);
  }

  const context = selectContext(input.database, input.automation, input.trigger, input.now, projectID, false, {
    consumed,
    limit: budget
  });
  if (context.items.length === 0) {
    return skipped("standing order no-op: no changed issue signal or active Supervisor commitment");
  }
  return { context };
}

function selectContext(
  db: RunnerDatabase,
  automation: AutomationDefinition,
  trigger: Extract<VersionedAutomationTrigger, { type: "continuous" }>,
  now: Date,
  projectID: string,
  resumeExisting: boolean,
  budget = { consumed: consumedProjectBudget(db, projectID, now), limit: projectBudget(db, projectID) }
): StandingOrderContext {
  const signals = collectProjectHeartbeatSignals(db, projectID, now);
  const issueSignals = changedIssueSignals(db, signals);
  const commitments = listSupervisorCommitments(db, { limit: 40, projectID, statuses: ["active"] });
  const processed = resumeExisting ? new Map<string, string>() : processedContextVersions(db, automation.id);
  const items = [
    ...issueSignals.map((signal): StandingOrderContextItem => {
      const issue = getIssue(db, signal.issue_id);
      return {
        kind: "issue_signal",
        payload: {
          diagnosis_code: signal.diagnosis_code,
          issue_id: signal.issue_id,
          reason: signal.reason,
          status: signal.status
        },
        ref: `issue-signal:${signal.issue_id}`,
        updated_at: issue?.updated_at ?? now.toISOString()
      };
    }),
    ...commitments.map((commitment): StandingOrderContextItem => ({
      kind: "supervisor_commitment",
      payload: {
        commitment_id: commitment.id,
        due_at: commitment.due_at,
        goal: commitment.goal,
        status: commitment.status,
        watch_id: commitment.watch_id,
        work_statuses: commitment.work_statuses
      },
      ref: commitment.id,
      updated_at: latestCommitmentUpdate(db, commitment.updated_at, commitment.goal.work_ids)
    }))
  ].filter((item) => {
    const processedAt = processed.get(item.ref);
    return processedAt === undefined || Date.parse(item.updated_at) > Date.parse(processedAt);
  });

  items.sort((left, right) => {
    const priority = Number(left.kind === "supervisor_commitment") - Number(right.kind === "supervisor_commitment");
    return priority || Date.parse(right.updated_at) - Date.parse(left.updated_at) || left.ref.localeCompare(right.ref);
  });

  return {
    automation_id: automation.id,
    budget,
    heartbeat_summary: {
      active_commitments: commitments.length,
      issue_signals: issueSignals.length,
      issue_total: signals.issues.total,
      open_issue_runs: signals.issue_runs.open
    },
    items: items.slice(0, Math.max(1, budget.limit - budget.consumed)),
    permission_policy_ref: automation.permission_policy_ref,
    schema_version: CONTEXT_SCHEMA,
    scope: { kind: "project", project_id: projectID },
    selected_at: now.toISOString(),
    trigger: { poll_interval_seconds: trigger.config.poll_interval_seconds, type: "continuous" }
  };
}

function changedIssueSignals(
  db: RunnerDatabase,
  signals: ReturnType<typeof collectProjectHeartbeatSignals>
): Array<{
  diagnosis_code: string;
  issue_id: number;
  reason: string;
  status: string;
}> {
  const findings = new Map((signals.project?.findings ?? []).map((finding) => [finding.issue_id, finding]));
  return (signals.project?.latest_issues ?? [])
    .filter((issue) => issue.id > 0 && !["done", "cancelled"].includes(issue.status))
    .filter((issue) => getIssueAsWork(db, issue.id)?.provenance.origin.authority !== "automation_definitions")
    .map((issue) => {
      const finding = findings.get(issue.id);
      return {
        diagnosis_code: finding?.reason ?? "",
        issue_id: issue.id,
        reason: finding?.message ?? "",
        status: issue.status
      };
    });
}

function projectBudget(db: RunnerDatabase, projectID: string): number {
  const configured = getProjectPiSettings(db, projectID)?.max_actions_per_cycle ?? DEFAULT_PROJECT_BUDGET;
  return Number.isSafeInteger(configured) && configured >= 0 ? configured : DEFAULT_PROJECT_BUDGET;
}

function consumedProjectBudget(db: RunnerDatabase, projectID: string, now: Date): number {
  const rows = db.sqlite.query<{ context_json: string }, [string, string]>(`
    select json_extract(event.payload, '$.evidence.decisive_output.facts.execution_context_json') as context_json
    from automation_execution_links link
    join automation_definitions definition on definition.id=link.automation_id
    join issue_events event on event.issue_id=link.issue_id and event.type='evidence.recorded.v1'
    where definition.scope_kind='project' and definition.scope_id=? and link.created_at=?
  `).all(projectID, now.toISOString());
  return rows.reduce((total, row) => total + contextItems(row.context_json).length, 0);
}

function processedContextVersions(db: RunnerDatabase, automationID: string): Map<string, string> {
  const rows = db.sqlite.query<{ context_json: string }, [string]>(`
    select json_extract(event.payload, '$.evidence.decisive_output.facts.execution_context_json') as context_json
    from automation_execution_links link
    join issue_events event on event.issue_id=link.issue_id and event.type='evidence.recorded.v1'
    where link.automation_id=?
  `).all(automationID);
  const result = new Map<string, string>();
  for (const row of rows) {
    for (const item of contextItems(row.context_json)) {
      const current = result.get(item.ref);
      if (current === undefined || Date.parse(item.updated_at) > Date.parse(current)) {
        result.set(item.ref, item.updated_at);
      }
    }
  }
  return result;
}

function contextItems(value: unknown): StandingOrderContextItem[] {
  try {
    const parsed = JSON.parse(typeof value === "string" ? value : "") as { items?: unknown };
    if (!Array.isArray(parsed.items)) return [];
    return parsed.items.filter((item): item is StandingOrderContextItem => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return false;
      const candidate = item as Partial<StandingOrderContextItem>;
      return typeof candidate.ref === "string" && typeof candidate.updated_at === "string";
    });
  } catch {
    return [];
  }
}

function latestCommitmentUpdate(db: RunnerDatabase, commitmentUpdatedAt: string, workIDs: string[]): string {
  const updates = [commitmentUpdatedAt];
  for (const workID of workIDs) {
    const issueID = Number(workID.split(":").at(-1));
    const issue = Number.isSafeInteger(issueID) ? getIssue(db, issueID) : null;
    if (issue?.updated_at) updates.push(issue.updated_at);
  }
  return updates.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? commitmentUpdatedAt;
}

function skipped(detail: string): AutomationExecutionPreparation {
  return { detail, outcome: "skipped" };
}
