import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import { getIssue, listIssueRuns, type Issue, type IssueRun } from "../../db/repositories/issues.ts";
import { updateIssue, type UpdateIssueInput } from "../../db/repositories/issueUpdate.ts";
import { makeDomainID, type DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import { makeRunAttemptID } from "../run/contracts.ts";
import {
  evaluateWorkTransition,
  type WorkAcceptanceEvidence,
  type WorkLedgerEntry,
  type WorkTransitionAudit
} from "../work/contracts.ts";
import { issueAsWork } from "../work/issueAdapter.ts";
import { createCommandEvidenceCollector, type CommandEvidenceKind } from "./commandCollector.ts";
import { validateEvidence, type EvidenceRecord } from "./contracts.ts";
import {
  evaluateWorkflowVerificationPolicy,
  type VerificationManualOverride,
  type VerificationPolicyEvaluation,
  type VerificationRiskLevel,
  type WorkflowVerificationPolicy
} from "./policy.ts";

export const ISSUE_WORK_VERIFICATION_POLICY: WorkflowVerificationPolicy = {
  schema_version: 1,
  id: "verification-policy:agent-execution-contract",
  revision: 1,
  name: "Issue-backed Work completion policy",
  kind_rules: [],
  required_groups: [{
    id: "automated-verification",
    operator: "all",
    requirements: [{
      id: "current-run-check",
      evidence_kinds: ["test", "lint", "build"],
      scope: "run",
      fact_assertions: [{ key: "outcome", operator: "equals", expected: "passed" }],
      max_age_seconds: 24 * 60 * 60,
      artifact_policy: "ignore"
    }]
  }],
  optional_requirements: [],
  risk_overrides: [
    { risk: "safe", additional_required_groups: [], manual_override: "allow_with_human_evidence" },
    { risk: "confirm", additional_required_groups: [], manual_override: "allow_with_human_evidence" },
    { risk: "high", additional_required_groups: [], manual_override: "allow_with_human_evidence" },
    { risk: "forbidden", additional_required_groups: [], manual_override: "deny" }
  ]
};

export const ISSUE_VERIFICATION_GATE_EVENT_TYPES = {
  humanEvidence: "issue.verification_human_evidence.v1",
  intent: "issue.verification_gate_intent.v1",
  outcome: "issue.verification_gate_outcome.v1"
} as const;

export type IssueCompletionGateInput = {
  actor: DomainActor;
  correlation_id: string;
  evidence: readonly EvidenceRecord[];
  manual_override?: VerificationManualOverride;
  now: string;
  patch?: UpdateIssueInput;
  policy?: WorkflowVerificationPolicy;
  projection_errors?: readonly string[];
  risk?: VerificationRiskLevel;
  run?: Pick<IssueRun, "attempt" | "id">;
  source: string;
};

export type IssueCompletionGateResult = {
  evaluation: VerificationPolicyEvaluation;
  issue: Issue;
  target_status: "done" | "failed" | "pending_verification";
  transition_path: string[];
};

export type RuntimeEvidenceProjection = {
  errors: string[];
  evidence: EvidenceRecord[];
  run?: IssueRun;
};

type StoredCommandItem = {
  aggregatedOutput?: unknown;
  command?: unknown;
  commandActions?: unknown;
  completedAtMs?: unknown;
  cwd?: unknown;
  durationMs?: unknown;
  exitCode?: unknown;
  status?: unknown;
  type?: unknown;
};

type IssueLogRow = {
  created_at: string;
  id: number;
  payload: string;
};

export function applyIssueCompletionGate(
  db: RunnerDatabase,
  issueID: number,
  input: IssueCompletionGateInput
): IssueCompletionGateResult {
  const current = mustGetIssue(db, issueID);
  if (current.status === "done") {
    return {
      evaluation: evaluateCompletion(current, input),
      issue: current,
      target_status: "done",
      transition_path: []
    };
  }
  if (current.status !== "in_progress" && current.status !== "pending_verification") {
    throw new Error("completion gate requires an in_progress or pending_verification Issue");
  }

  const policy = input.policy ?? ISSUE_WORK_VERIFICATION_POLICY;
  const evaluation = evaluateCompletion(current, { ...input, policy });
  const targetStatus = completionTarget(evaluation);
  const fingerprint = completionFingerprint(current, input, policy, evaluation);
  const replay = completionReplay(db, issueID, fingerprint, targetStatus);
  if (replay) return { evaluation, issue: replay, target_status: targetStatus, transition_path: [] };

  const audit = transitionAudit(input, evaluation.policy_ref, fingerprint);
  const evidenceIDs = input.evidence.map((evidence) => evidence.id).sort();
  const policySnapshot = stableValue(policy);
  const transitionPath: string[] = [];
  const write = db.transaction(() => {
    recordIssueEvent(db, issueID, ISSUE_VERIFICATION_GATE_EVENT_TYPES.intent, {
      actor: input.actor,
      correlation_id: input.correlation_id,
      evidence_ids: evidenceIDs,
      fingerprint,
      manual_override: input.manual_override ?? null,
      occurred_at: canonicalNow(input.now),
      policy_ref: evaluation.policy_ref,
      policy_snapshot: policySnapshot,
      requested_status: "done",
      source: input.source,
      transition_audit: audit,
      work_id: issueAsWork(current).id
    });

    let issue = current;
    if (targetStatus === "done" && issue.status === "in_progress") {
      issue = transitionIssue(db, issue, "pending_verification", audit, undefined, {});
      transitionPath.push("in_progress->pending_verification");
    }

    const patch = completionPatch(input.patch ?? {}, targetStatus, evaluation, issue.error);
    if (issue.status !== targetStatus) {
      const acceptance = targetStatus === "done"
        ? workAcceptance(issueAsWork(issue), input.evidence, evaluation, fingerprint)
        : undefined;
      const before = issue.status;
      issue = transitionIssue(db, issue, targetStatus, audit, acceptance, patch);
      transitionPath.push(`${before}->${targetStatus}`);
    } else {
      issue = updateIssue(db, issue.id, patch);
    }

    recordIssueEvent(db, issueID, ISSUE_VERIFICATION_GATE_EVENT_TYPES.outcome, {
      actor: input.actor,
      correlation_id: input.correlation_id,
      evaluation,
      evidence_ids: evidenceIDs,
      fingerprint,
      from_status: current.status,
      manual_override: input.manual_override ?? null,
      occurred_at: canonicalNow(input.now),
      policy_ref: evaluation.policy_ref,
      policy_snapshot: policySnapshot,
      projection_errors: [...(input.projection_errors ?? [])],
      source: input.source,
      target_status: targetStatus,
      transition_audit: audit,
      transition_path: transitionPath,
      work_id: issueAsWork(issue).id
    });
    return issue;
  });

  return {
    evaluation,
    issue: write.immediate(),
    target_status: targetStatus,
    transition_path: transitionPath
  };
}

export async function completeIssueFromRuntimeEvidence(
  db: RunnerDatabase,
  issueID: number,
  patch: UpdateIssueInput,
  options: { actor?: DomainActor; correlation_id?: string; now?: string; source?: string } = {}
): Promise<IssueCompletionGateResult> {
  const now = canonicalNow(options.now);
  const projection = await projectIssueRuntimeEvidence(db, issueID, now);
  return applyIssueCompletionGate(db, issueID, {
    actor: options.actor ?? { id: "runner-completion-api", kind: "runner" },
    correlation_id: options.correlation_id ?? `issue-${issueID}-completion`,
    evidence: projection.evidence,
    now,
    patch,
    projection_errors: projection.errors,
    run: projection.run,
    source: options.source ?? "issue-patch-api"
  });
}

export function createManualOverrideEvidence(
  issue: Issue,
  input: { audit_event_ref: string; comment: string; now: string; policy?: WorkflowVerificationPolicy; risk?: VerificationRiskLevel }
): { evidence: EvidenceRecord; override: VerificationManualOverride } {
  const policy = input.policy ?? ISSUE_WORK_VERIFICATION_POLICY;
  const risk = input.risk ?? "safe";
  const now = canonicalNow(input.now);
  const reason = input.comment.trim() || "Manual verification accepted through the authenticated Issue verification API";
  const identity = createHash("sha256").update(stableJson({
    audit_event_ref: input.audit_event_ref,
    issue_id: issue.id,
    now,
    policy_id: policy.id,
    policy_revision: policy.revision,
    reason,
    risk
  })).digest("hex").slice(0, 24);
  const evidence: EvidenceRecord = {
    schema_version: 1,
    id: makeDomainID("evidence", "issue_events", `manual-${issue.id}-${identity}`),
    work_id: issueAsWork(issue).id,
    revision: 0,
    kind: "human",
    status: "passed",
    created_at: now,
    observed_at: now,
    updated_at: now,
    completed_at: now,
    decisive_output: {
      summary: reason,
      facts: {
        decision: "verification_override",
        policy_id: policy.id,
        policy_revision: policy.revision,
        risk
      }
    },
    artifact_refs: [],
    provenance: {
      assertion_origin: "human_attestation",
      source_kind: "human_attestation",
      source_ref: `/api/issues/${issue.id}/verification`,
      audit_event_ref: input.audit_event_ref,
      producer: { id: "issue-verification-api", kind: "user" }
    },
    redaction: {
      status: "not_required",
      policy_ref: "evidence-redaction:v1",
      redacted_paths: []
    }
  };
  const validation = validateEvidence(evidence);
  if (!validation.ok) throw new Error(`manual override Evidence is invalid: ${validation.errors.join("; ")}`);
  return {
    evidence,
    override: {
      audit_event_ref: input.audit_event_ref,
      human_evidence_id: evidence.id,
      reason
    }
  };
}

export async function projectIssueRuntimeEvidence(
  db: RunnerDatabase,
  issueID: number,
  now = new Date().toISOString()
): Promise<RuntimeEvidenceProjection> {
  const issue = mustGetIssue(db, issueID);
  const run = listIssueRuns(db, issueID).at(-1);
  const rows = recentCommandEvents(db, issueID, run);
  const collector = createCommandEvidenceCollector();
  const evidence: EvidenceRecord[] = [];
  const errors: string[] = [];
  for (const row of rows) {
    const item = commandItem(row.payload);
    if (!item) continue;
    const command = commandText(item);
    const kind = classifyVerificationCommand(command);
    if (!kind) continue;
    try {
      const timing = commandTiming(item, row.created_at);
      const runID = run ? makeDomainID("run", "issue_runs", run.id) : undefined;
      evidence.push(await collector.collect({
        context: {
          audit_event_ref: `issue-event:${row.id}`,
          collected_at: canonicalNow(now),
          evidence_id: makeDomainID("evidence", "issue_events", row.id),
          producer: { id: `issue-runner:${run?.provider || "unknown"}`, kind: "runner" },
          ...(runID ? { run_id: runID, attempt_id: makeRunAttemptID(runID, run!.attempt) } : {}),
          source_ref: `issue_events:${row.id}`,
          work_id: issueAsWork(issue).id
        },
        kind,
        observation: {
          command,
          cwd: cleanString(item.cwd) || ".",
          duration_ms: timing.duration,
          ended_at: timing.ended,
          exit_code: integerOrNull(item.exitCode),
          started_at: timing.started,
          stderr: "",
          stdout: "",
          timed_out: false
        }
      }));
    } catch (error) {
      errors.push(`issue event ${row.id}: ${errorMessage(error)}`);
    }
  }
  return { errors, evidence, ...(run ? { run } : {}) };
}

export function classifyVerificationCommand(command: string): CommandEvidenceKind | undefined {
  const value = command.trim();
  if (value === "" || compoundVerificationCommand(value)) return undefined;
  const test = /(?:^|\s)(?:bun\s+test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|deno\s+test|cargo\s+test|go\s+test|flutter\s+test|pytest|python\d*\s+-m\s+pytest)(?:\s|$)/i;
  const lint = /(?:^|\s)(?:bun\s+(?:run\s+)?lint|npm\s+(?:run\s+)?lint|pnpm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint|eslint|ruff\s+check|cargo\s+clippy|flutter\s+analyze|dart\s+analyze|tsc\b[^\n;&|]*--noEmit)(?:\s|$)/i;
  const build = /(?:^|\s)(?:bun\s+(?:run\s+)?build|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|cargo\s+build|go\s+build|flutter\s+build|xcodebuild|tsc)(?:\s|$)/i;
  if (test.test(value)) return "test";
  if (lint.test(value)) return "lint";
  if (build.test(value)) return "build";
  return undefined;
}

function evaluateCompletion(issue: Issue, input: IssueCompletionGateInput): VerificationPolicyEvaluation {
  const runContext = evaluationRunContext(input);
  return evaluateWorkflowVerificationPolicy({
    context: {
      ...runContext,
      now: canonicalNow(input.now),
      project_id: issue.project_id,
      risk: input.risk ?? "safe",
      work_id: issueAsWork(issue).id
    },
    evidence: input.evidence,
    manual_override: input.manual_override,
    policy: input.policy ?? ISSUE_WORK_VERIFICATION_POLICY
  });
}

function evaluationRunContext(input: IssueCompletionGateInput): {
  attempt_id?: EvidenceRecord["attempt_id"];
  run_id?: EvidenceRecord["run_id"];
} {
  if (input.run) {
    const runID = makeDomainID("run", "issue_runs", input.run.id);
    return { run_id: runID, attempt_id: makeRunAttemptID(runID, input.run.attempt) };
  }
  const linked = [...input.evidence].reverse().find((evidence) => evidence.run_id);
  return linked?.run_id
    ? { run_id: linked.run_id, ...(linked.attempt_id ? { attempt_id: linked.attempt_id } : {}) }
    : {};
}

function completionTarget(
  evaluation: VerificationPolicyEvaluation
): "done" | "failed" | "pending_verification" {
  if (evaluation.decision === "passed" || evaluation.decision === "overridden") return "done";
  if (evaluation.decision === "pending") return "pending_verification";
  return "failed";
}

function transitionIssue(
  db: RunnerDatabase,
  issue: Issue,
  to: "done" | "failed" | "pending_verification",
  audit: WorkTransitionAudit,
  acceptance: WorkAcceptanceEvidence | undefined,
  patch: UpdateIssueInput
): Issue {
  const work = issueAsWork(issue);
  const decision = evaluateWorkTransition({ relations: [], works: [work] }, {
    acceptance,
    audit,
    expected_revision: work.revision,
    to,
    work_id: work.id
  });
  if (!decision.allowed) throw new Error(`completion state transition rejected: ${decision.violations.join("; ")}`);
  return updateIssue(db, issue.id, { ...patch, status: to });
}

function workAcceptance(
  work: WorkLedgerEntry,
  evidence: readonly EvidenceRecord[],
  evaluation: VerificationPolicyEvaluation,
  fingerprint: string
): WorkAcceptanceEvidence {
  const selected = new Set<string>();
  for (const group of evaluation.groups) {
    for (const result of group.requirements) {
      if ((result.status === "passed" || result.status === "skipped") && result.evidence_id) selected.add(result.evidence_id);
    }
  }
  if (evaluation.override.applied && evaluation.override.evidence_id) selected.add(evaluation.override.evidence_id);
  const records = evidence.filter((record) => selected.has(record.id) && record.status === "passed");
  return {
    contract_version: work.acceptance.version,
    evidence: records.map((record) => ({
      criterion_ids: work.acceptance.criteria.filter((criterion) => criterion.required).map((criterion) => criterion.id),
      id: record.id,
      status: record.status,
      work_id: record.work_id
    })),
    handoffs: [{
      id: makeDomainID("handoff", "derived", `issue-${work.id.split(":").at(-1)}-${fingerprint.slice(0, 16)}`),
      status: "ready",
      work_id: work.id
    }]
  };
}

function transitionAudit(
  input: IssueCompletionGateInput,
  policyRef: string,
  fingerprint: string
): WorkTransitionAudit {
  const manual = input.manual_override !== undefined;
  return {
    actor: input.actor,
    correlation_id: input.correlation_id,
    event_id: `verification-gate:${fingerprint}`,
    gate: {
      authority: manual ? "human_approval" : "deterministic_policy",
      decision: "allow",
      policy_ref: policyRef
    },
    occurred_at: canonicalNow(input.now),
    reason: manual ? input.manual_override!.reason : "Workflow Verification Policy completion decision"
  };
}

function completionPatch(
  input: UpdateIssueInput,
  target: "done" | "failed" | "pending_verification",
  evaluation: VerificationPolicyEvaluation,
  currentError: string
): UpdateIssueInput {
  const patch = { ...input, status: target };
  if (target === "done") return { ...patch, error: "" };
  const requestedError = typeof input.error === "string" ? input.error.trim() : "";
  if (requestedError !== "") return patch;
  const reason = evaluation.errors[0] ?? evaluation.groups
    .flatMap((group) => group.requirements)
    .find((requirement) => requirement.status !== "passed" && requirement.status !== "skipped")?.reason;
  return {
    ...patch,
    error: target === "failed"
      ? `Verification failed: ${reason || evaluation.decision}`
      : currentError || `Verification pending: ${reason || "required Evidence is missing"}`
  };
}

function completionFingerprint(
  issue: Issue,
  input: IssueCompletionGateInput,
  policy: WorkflowVerificationPolicy,
  evaluation: VerificationPolicyEvaluation
): string {
  return createHash("sha256").update(stableJson({
    evidence: input.evidence.map((item) => ({ id: item.id, revision: item.revision, status: item.status })),
    issue_id: issue.id,
    issue_status: issue.status,
    manual_override: input.manual_override ?? null,
    patch: input.patch ?? {},
    policy_id: policy.id,
    policy_revision: policy.revision,
    result: evaluation.decision,
    run: input.run ?? null,
    source: input.source
  })).digest("hex");
}

function completionReplay(
  db: RunnerDatabase,
  issueID: number,
  fingerprint: string,
  targetStatus: string
): Issue | null {
  const row = db.sqlite.query<{ payload: string }, [number, string]>(`
    select payload from issue_events
    where issue_id=? and type=? order by id desc limit 100
  `).all(issueID, ISSUE_VERIFICATION_GATE_EVENT_TYPES.outcome)
    .map((item) => parsedObject(item.payload))
    .find((payload) => payload?.fingerprint === fingerprint && payload.target_status === targetStatus);
  if (!row) return null;
  const issue = mustGetIssue(db, issueID);
  return issue.status === targetStatus ? issue : null;
}

function recentCommandEvents(db: RunnerDatabase, issueID: number, run: IssueRun | undefined): IssueLogRow[] {
  const clauses = ["issue_id=?", "type='issue.log'"];
  const args: Array<number | string> = [issueID];
  if (run?.started_at) {
    clauses.push("created_at>=?");
    args.push(run.started_at);
  }
  return db.sqlite.query<IssueLogRow, Array<number | string>>(`
    select id, payload, created_at from issue_events
    where ${clauses.join(" and ")} order by id desc limit 200
  `).all(...args).reverse();
}

function commandItem(payload: string): StoredCommandItem | undefined {
  const event = parsedObject(payload);
  if (event?.type !== "tool" || event.raw_method !== "item/completed") return undefined;
  const raw = typeof event.raw_payload === "string" ? parsedObject(event.raw_payload) : undefined;
  const item = raw?.item;
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const command = item as StoredCommandItem;
  if (command.type !== "commandExecution") return undefined;
  if (command.status !== "completed" && command.status !== "failed") return undefined;
  return command;
}

function commandText(item: StoredCommandItem): string {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  if (actions.length === 1) {
    const action = actions[0];
    if (action && typeof action === "object" && !Array.isArray(action)) {
      const command = cleanString((action as Record<string, unknown>).command);
      if (command !== "") return command;
    }
  }
  return cleanString(item.command);
}

function compoundVerificationCommand(command: string): boolean {
  const lines = command.split("\n").map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^set\s+-/.test(line) && !/^cd\s+/.test(line));
  if (lines.length > 1) return true;
  const value = lines[0] ?? command;
  return /(?:&&|;|\|)/.test(value);
}

function commandTiming(item: StoredCommandItem, eventCreatedAt: string): {
  duration: number;
  ended: string;
  started: string;
} {
  const completedAt = typeof item.completedAtMs === "number" && Number.isFinite(item.completedAtMs)
    ? item.completedAtMs
    : Date.parse(eventCreatedAt);
  if (!Number.isFinite(completedAt)) throw new Error("command completion timestamp is invalid");
  const duration = typeof item.durationMs === "number" && Number.isSafeInteger(item.durationMs) && item.durationMs >= 0
    ? item.durationMs
    : 0;
  return {
    duration,
    ended: new Date(completedAt).toISOString(),
    started: new Date(completedAt - duration).toISOString()
  };
}

function integerOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) ? value : null;
}

function canonicalNow(value: string | undefined): string {
  const date = new Date(value ?? Date.now());
  if (!Number.isFinite(date.getTime())) throw new Error("completion gate now must be an ISO timestamp");
  return date.toISOString();
}

function stableValue<T>(value: T): T {
  return JSON.parse(stableJson(value)) as T;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => [key, sortValue(item)]));
}

function parsedObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "string" || value.trim() === "") return undefined;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function mustGetIssue(db: RunnerDatabase, issueID: number): Issue {
  const issue = getIssue(db, issueID);
  if (!issue) throw new Error(`Issue ${issueID} not found`);
  return issue;
}
