import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import {
  hydrateStoredIssueLogPayload,
  recordIssueEvent,
  RUNTIME_EVIDENCE_CORRELATION_CONTRACT,
  type IssueEvent,
  type RuntimeEvidenceCorrelation
} from "../../db/repositories/issueEvents.ts";
import { listStoredEvidence, recordEvidenceRecords } from "../../db/repositories/evidence.ts";
import {
  listStoredHandoffs,
  recordHandoff,
  type StoredHandoffRecord
} from "../../db/repositories/handoffs.ts";
import { getIssue, listIssueRuns, type Issue, type IssueRun } from "../../db/repositories/issues.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { updateIssue, type UpdateIssueInput } from "../../db/repositories/issueUpdate.ts";
import { makeDomainID, type DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import { makeRunAttemptID } from "../run/contracts.ts";
import type { HandoffRecord } from "../handoff/contracts.ts";
import { buildHandoffDiffSummary } from "../handoff/diffSummary.ts";
import {
  evaluateWorkTransition,
  type WorkAcceptanceEvidence,
  type WorkLedgerEntry,
  type WorkTransitionAudit
} from "../work/contracts.ts";
import { issueAsWork, projectIssueAsWork } from "../work/issueAdapter.ts";
import {
  COMMAND_EVIDENCE_CHANNELS,
  FileSystemCommandEvidenceArtifactStore,
  createCommandEvidenceCollector,
  type CommandEvidenceChannel,
  type CommandEvidenceKind,
  type CommandExecutionObservation
} from "./commandCollector.ts";
import { validateEvidence, type EvidenceArtifactRef, type EvidenceRecord } from "./contracts.ts";
import {
  FileSystemGitEvidenceArtifactStore,
  createGitEvidenceCollector
} from "./gitCollector.ts";
import {
  gitPathspecFingerprint,
  issueRunGitDeliveryScope,
  type IssueRunGitDeliveryScope
} from "./runGitWorkspaceBaseline.ts";
import {
  evaluateWorkflowVerificationPolicy,
  type VerificationManualOverride,
  type VerificationPolicyEvaluation,
  type VerificationRiskLevel,
  type WorkflowVerificationPolicy
} from "./policy.ts";
import {
  buildStructuredVerifierReview,
  verifierGateStatusForPolicyDecision,
  verifierReviewEventPayload,
  type StructuredVerifierReview
} from "./verifierReview.ts";
import { codexDynamicExecObservation } from "../../providers/codex/dynamicExec.ts";

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
  allow_failed_reconciliation?: boolean;
  actor: DomainActor;
  correlation_id: string;
  evidence: readonly EvidenceRecord[];
  handoff?: HandoffRecord;
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

export type IssueVerifierReviewInput = Pick<
  IssueCompletionGateInput,
  "evidence" | "manual_override" | "now" | "policy" | "projection_errors" | "risk" | "run"
>;

export type IssueVerifierReviewResult = {
  evaluation: VerificationPolicyEvaluation;
  review: StructuredVerifierReview;
};

type StoredCommandItem = {
  aggregatedOutput?: unknown;
  command?: unknown;
  commandActions?: unknown;
  completedAtMs?: unknown;
  cwd?: unknown;
  durationMs?: unknown;
  exitCode?: unknown;
  id?: unknown;
  processId?: unknown;
  stderr?: unknown;
  stdout?: unknown;
  status?: unknown;
  type?: unknown;
};

type IssueLogRow = {
  created_at: string;
  id: number;
  payload: string;
};

type ParsedIssueLog = {
  correlation?: RuntimeEvidenceCorrelation;
  item?: StoredCommandItem;
  method: string;
  raw: Record<string, unknown>;
  row: IssueLogRow;
};

export type RuntimeVerificationCaptureInput = {
  artifact_refs?: readonly EvidenceArtifactRef[];
  channel: CommandEvidenceChannel;
  correlation_id: string;
  kind?: CommandEvidenceKind;
  observation: CommandExecutionObservation;
  producer_id: string;
  run_id: string;
  source_ref: string;
};

export type RuntimeVerificationCaptureResult = {
  evidence: EvidenceRecord;
  gate?: IssueCompletionGateResult;
  replayed: boolean;
};

export type VerificationGapReason =
  | "not_executed"
  | "not_captured"
  | "run_mismatch"
  | "stale"
  | "failed"
  | "none";

export type VerificationGap = {
  reason: VerificationGapReason;
  detail: string;
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
  const failedReconciliation = current.status === "failed" && input.allow_failed_reconciliation === true;
  if (current.status !== "in_progress" && current.status !== "pending_verification" && !failedReconciliation) {
    throw new Error("completion gate requires an in_progress or pending_verification Issue");
  }

  const policy = input.policy ?? ISSUE_WORK_VERIFICATION_POLICY;
  const verification = createIssueVerifierReview(current, { ...input, policy });
  const verificationTarget = verifierGateStatusForPolicyDecision(verification.evaluation.decision);
  const handoffPolicy = projectIssueAsWork(db, current).acceptance.handoff_policy ?? "summary";
  const handoffEnabled = handoffPolicy !== "none";
  const handoffRequired = handoffPolicy === "required";
  const acceptanceHandoff = verificationTarget === "done" && handoffEnabled
    ? acceptanceHandoffForCompletion(db, current, input)
    : null;
  const deliveryGapDetail = input.projection_errors?.find((error) => error.startsWith("Handoff gap:"))
    ?.slice("Handoff gap:".length).trim();
  const handoffGap = verificationTarget === "done" && handoffEnabled && !acceptanceHandoff
    ? handoffRequired
      ? `Completion requires a persisted ready or delivered Handoff linked to the current Work and canonical Run${
        deliveryGapDetail ? `: ${deliveryGapDetail}` : ""
      }`
      : `Handoff summary was not produced, but summary policy allows completion${
        deliveryGapDetail ? `: ${deliveryGapDetail}` : ""
      }`
    : "";
  const blockingHandoffGap = handoffRequired ? handoffGap : "";
  const evaluation = blockingHandoffGap === ""
    ? verification.evaluation
    : {
      ...verification.evaluation,
      decision: "pending" as const,
      errors: [...verification.evaluation.errors, blockingHandoffGap],
      satisfied: false
    };
  const analysis = createIssueVerifierReview(current, { ...input, policy, projection_errors: [
    ...(input.projection_errors ?? []),
    ...(blockingHandoffGap ? [blockingHandoffGap] : [])
  ] }, evaluation);
  const targetStatus = verifierGateStatusForPolicyDecision(evaluation.decision);
  const fingerprint = completionFingerprint(current, input, policy, evaluation, acceptanceHandoff);
  const replay = completionReplay(db, issueID, fingerprint, targetStatus);
  if (replay) return { evaluation, issue: replay, target_status: targetStatus, transition_path: [] };

  const audit = transitionAudit(input, evaluation.policy_ref, fingerprint);
  const evidenceIDs = input.evidence.map((evidence) => evidence.id).sort();
  const policySnapshot = stableValue(policy);
  const transitionPath: string[] = [];
  const write = db.transaction(() => {
    recordEvidenceRecords(db, issueID, input.evidence, {
      recorded_at: canonicalNow(input.now),
      source: input.source
    });
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

    if (input.handoff && handoffEnabled) {
      recordHandoff(db, issueID, input.handoff, {
        recorded_at: canonicalNow(input.now),
        source: input.source
      });
    }

    const persistedHandoff = targetStatus === "done" && handoffEnabled
      ? persistAcceptanceHandoffEvidence(db, issueID, current, input, evaluation)
      : null;
    if (targetStatus === "done" && handoffRequired && !persistedHandoff) {
      throw new Error("completion gate refused done without a persisted ready or delivered Handoff");
    }

    let issue = current;
    if (targetStatus === "done" && issue.status !== "pending_verification") {
      issue = transitionIssue(db, issue, "pending_verification", audit, undefined, {});
      transitionPath.push(`${current.status}->pending_verification`);
    }

    const patch = completionPatch(input.patch ?? {}, targetStatus, evaluation, issue.error);
    if (issue.status !== targetStatus) {
      const acceptance = targetStatus === "done"
        ? workAcceptance(projectIssueAsWork(db, issue), input.evidence, evaluation, persistedHandoff)
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
      handoff_gap: handoffGap || null,
      handoff_id: persistedHandoff?.handoff.id ?? null,
      handoff_revision: persistedHandoff?.handoff.revision ?? null,
      source: input.source,
      target_status: targetStatus,
      transition_audit: audit,
      transition_path: transitionPath,
      work_id: issueAsWork(issue).id
    });
    recordIssueEvent(db, issueID, "issue.verification_report", verifierReviewEventPayload(analysis.review));
    return issue;
  });

  return {
    evaluation,
    issue: write.immediate(),
    target_status: targetStatus,
    transition_path: transitionPath
  };
}

export function createIssueVerifierReview(
  issue: Issue,
  input: IssueVerifierReviewInput,
  evaluationOverride?: VerificationPolicyEvaluation
): IssueVerifierReviewResult {
  const policy = input.policy ?? ISSUE_WORK_VERIFICATION_POLICY;
  const evaluation = evaluationOverride ?? evaluateCompletion(issue, { ...input, policy });
  return {
    evaluation,
    review: buildStructuredVerifierReview({
      evaluated_at: canonicalNow(input.now),
      evidence: input.evidence,
      evaluation,
      policy,
      projection_errors: input.projection_errors,
      work: issueAsWork(issue)
    })
  };
}

export async function completeIssueFromRuntimeEvidence(
  db: RunnerDatabase,
  issueID: number,
  patch: UpdateIssueInput,
  options: { actor?: DomainActor; correlation_id?: string; now?: string; source?: string } = {}
): Promise<IssueCompletionGateResult> {
  const now = canonicalNow(options.now);
  const projection = await projectIssueRuntimeEvidence(db, issueID, now, { persist_artifacts: true });
  const evidence = currentRunEvidence(db, issueID, projection.run, projection.evidence);
  const verification = createIssueVerifierReview(mustGetIssue(db, issueID), {
    evidence,
    now,
    projection_errors: projection.errors,
    run: projection.run
  }).evaluation;
  const delivery: CompletionHandoffPreparation = verification.decision === "failed" || verification.decision === "invalid"
    ? { errors: [], evidence: [] }
    : await prepareCompletionHandoff(db, issueID, projection.run, evidence, now);
  return applyIssueCompletionGate(db, issueID, {
    actor: options.actor ?? { id: "runner-completion-api", kind: "runner" },
    correlation_id: options.correlation_id ?? `issue-${issueID}-completion`,
    evidence: uniqueEvidence([...evidence, ...delivery.evidence]),
    ...(delivery.handoff ? { handoff: delivery.handoff } : {}),
    now,
    patch,
    projection_errors: [...projection.errors, ...delivery.errors],
    run: projection.run,
    source: options.source ?? "issue-patch-api"
  });
}

/**
 * 修复“实现与验证已完成、但完成门禁尚未重新评估”的终态 Issue。
 *
 * 该入口不会重跑 executor，也不会把 Agent 叙述当作证明。它重新读取当前
 * canonical Run 的持久化 Evidence；按 Work 的 handoff_policy 尝试从 Git
 * authority 推导可审计 Handoff，然后通过同一 completion gate 完成
 * failed -> pending_verification -> done。summary/none 不会因无 Handoff 阻塞。
 */
export async function reconcileIssueCompletionFromRuntimeEvidence(
  db: RunnerDatabase,
  issueID: number,
  options: { actor?: DomainActor; correlation_id?: string; now?: string; source?: string } = {}
): Promise<IssueCompletionGateResult> {
  const issue = mustGetIssue(db, issueID);
  if (issue.status !== "failed" && issue.status !== "pending_verification") {
    throw new Error("completion reconciliation requires a failed or pending_verification Issue");
  }
  const now = canonicalNow(options.now);
  const projection = await projectIssueRuntimeEvidence(db, issueID, now, { persist_artifacts: true });
  if (!projection.run || projection.run.ended_at === "") {
    throw new Error("completion reconciliation requires an ended canonical Run");
  }
  const evidence = currentRunEvidence(db, issueID, projection.run, projection.evidence);
  const verification = createIssueVerifierReview(issue, {
    evidence,
    now,
    projection_errors: projection.errors,
    run: projection.run
  }).evaluation;
  if (verification.decision !== "passed") {
    throw new Error(
      `completion reconciliation requires passed current-Run Evidence; verification is ${verification.decision}`
    );
  }
  const delivery = await prepareCompletionHandoff(db, issueID, projection.run, evidence, now);
  const runID = makeDomainID("run", "issue_runs", projection.run.id);
  const workID = issueAsWork(issue).id;
  const handoffPolicy = projectIssueAsWork(db, issue).acceptance.handoff_policy ?? "summary";
  const existingHandoff = listStoredHandoffs(db, {
    limit: 100,
    statuses: ["ready", "delivered"],
    work_id: workID
  }).items.some((item) => item.handoff.run_ids.includes(runID));
  if (handoffPolicy === "required" && !delivery.handoff && !existingHandoff) {
    const detail = delivery.errors[0]?.replace(/^Handoff gap:\s*/, "") || "no derivable delivery Handoff";
    throw new Error(`completion reconciliation could not create Handoff: ${detail}`);
  }
  return applyIssueCompletionGate(db, issueID, {
    allow_failed_reconciliation: true,
    actor: options.actor ?? { id: "runner-completion-reconciliation", kind: "runner" },
    correlation_id: options.correlation_id ?? `issue-${issueID}-completion-reconciliation`,
    evidence: uniqueEvidence([...evidence, ...delivery.evidence]),
    ...(delivery.handoff ? { handoff: delivery.handoff } : {}),
    now,
    patch: { status: "done" },
    projection_errors: [...projection.errors, ...delivery.errors],
    run: projection.run,
    source: options.source ?? "issue-completion-reconciliation"
  });
}

type CompletionHandoffPreparation = {
  errors: string[];
  evidence: EvidenceRecord[];
  handoff?: HandoffRecord;
};

async function prepareCompletionHandoff(
  db: RunnerDatabase,
  issueID: number,
  run: IssueRun | undefined,
  evidence: readonly EvidenceRecord[],
  now: string
): Promise<CompletionHandoffPreparation> {
  if (!run) return { errors: ["Handoff gap: completion has no canonical Run"], evidence: [] };
  const issue = mustGetIssue(db, issueID);
  const project = getProject(db, issue.project_id);
  if (!project) return { errors: ["Handoff gap: Issue project is unavailable"], evidence: [] };
  const runID = makeDomainID("run", "issue_runs", run.id);
  const workID = issueAsWork(issue).id;
  const deliveryScope = issueRunGitDeliveryScope(db, issueID, {
    base_revision: run.git_base_revision,
    repository_path: project.cwd,
    run_id: run.id
  });
  const deliveryBaseRevision = deliveryScope.base_revision;
  const existing = listStoredHandoffs(db, {
    limit: 100,
    statuses: ["ready", "delivered"],
    work_id: workID
  }).items.find((item) => item.handoff.run_ids.includes(runID));
  if (existing) return { errors: [], evidence: [] };
  let gitEvidence = [...evidence].reverse().find((item) =>
    item.kind === "git" && item.status === "passed" && item.run_id === runID && item.work_id === workID &&
    gitEvidenceCoversDelivery(item, deliveryScope)
  );
  const collected: EvidenceRecord[] = [];
  try {
    if (deliveryScope.pathspecs.length === 0) {
      const uncertainty = deliveryScope.uncertainty_reasons.length > 0
        ? ` ${deliveryScope.uncertainty_reasons.join("; ")}`
        : "";
      throw new Error(`Run delivery scope does not identify attributable changed files.${uncertainty}`);
    }
    if (!gitEvidence) {
      const collector = createGitEvidenceCollector({
        artifact_store: new FileSystemGitEvidenceArtifactStore(dirname(db.path))
      });
      gitEvidence = await collector.collect({
        ...(deliveryBaseRevision ? { base_revision: deliveryBaseRevision } : {}),
        context: {
          attempt_id: makeRunAttemptID(runID, run.attempt),
          audit_event_ref: `completion-handoff:${issueID}:${run.id}`,
          collected_at: now,
          evidence_id: makeDomainID("evidence", "git", `completion-${issueID}-${run.id}`),
          producer: { id: "runner-completion-handoff", kind: "runner" },
          run_id: runID,
          source_ref: `project:${project.id}:git-worktree`,
          work_id: workID
        },
        pathspecs: deliveryScope.pathspecs,
        repository_path: project.cwd,
        untracked_policy: "include_all"
      });
      collected.push(gitEvidence);
    }
    const handoff = completionHandoffFromGit(
      db,
      issue,
      run,
      [...evidence, ...collected],
      gitEvidence,
      now,
      deliveryScope.uncertainty_reasons
    );
    return { errors: [], evidence: collected, handoff };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      errors: [`Handoff gap: ${detail}`],
      evidence: collected
    };
  }
}

function completionHandoffFromGit(
  db: RunnerDatabase,
  issue: Issue,
  run: IssueRun,
  evidence: readonly EvidenceRecord[],
  gitEvidence: EvidenceRecord,
  now: string,
  attributionUncertainty: readonly string[]
): HandoffRecord {
  const validation = validateEvidence(gitEvidence);
  if (!validation.ok || gitEvidence.kind !== "git" || gitEvidence.status !== "passed") {
    throw new Error("completion delivery requires valid passed Git Evidence");
  }
  const facts = gitEvidence.decisive_output.facts;
  const baselineRevision = requiredDeliveryFact(facts.base_revision, "Git base_revision");
  const headRevision = requiredDeliveryFact(facts.head_revision, "Git head_revision");
  const committedDelivery = facts.revision_changed_from_base === true && baselineRevision !== headRevision;
  const workingTreeDelivery = facts.working_tree_dirty === true;
  if (!committedDelivery && !workingTreeDelivery) {
    throw new Error("Git Evidence does not contain a committed or dirty working-tree delivery artifact");
  }
  if (facts.conflict_count !== 0) {
    throw new Error("Git Evidence contains unresolved conflicts");
  }
  const artifact = gitSnapshotArtifact(db, gitEvidence);
  const summary = buildHandoffDiffSummary({
    git_evidence: gitEvidence,
    ...(artifact ? { snapshot_artifact: artifact } : {})
  });
  if (summary.changed_files.length === 0) {
    throw new Error("Git Evidence does not identify changed files for Handoff delivery");
  }
  const runID = makeDomainID("run", "issue_runs", run.id);
  const workID = issueAsWork(issue).id;
  const evidenceIDs = [...new Set(evidence
    .filter((item) => item.status === "passed" && item.work_id === workID && item.run_id === runID)
    .map((item) => item.id))].sort();
  if (!evidenceIDs.includes(gitEvidence.id)) evidenceIDs.push(gitEvidence.id);
  if (evidenceIDs.length > 256) {
    throw new Error("current Run has more passed Evidence records than one Handoff can auditably link");
  }
  const finalRevision = `git-snapshot-manifest:sha256:${summary.snapshot_sha256}`;
  const identity = createHash("sha256").update(stableJson({
    final_revision: finalRevision,
    run_id: runID,
    work_id: workID
  })).digest("hex").slice(0, 32);
  return {
    schema_version: 1,
    id: makeDomainID("handoff", "derived", `issue-${issue.id}-${identity}`),
    work_id: workID,
    run_ids: [runID],
    evidence_ids: evidenceIDs,
    revision: 0,
    status: "ready",
    summary: summary.summary,
    created_at: now,
    updated_at: now,
    baseline_revision: baselineRevision,
    final_revision: finalRevision,
    review_ref: gitEvidence.id,
    changed_files: summary.changed_files,
    delivery: { mode: "local_changes", working_tree_ref: finalRevision },
    delivery_actions: [],
    risks: [
      ...summary.risk_hints,
      ...(attributionUncertainty.length > 0 ? [{
        id: "handoff_attribution_uncertainty",
        severity: "high" as const,
        summary: attributionUncertainty.join("; "),
        mitigation: "Review the Run baseline and committed path scope before delivery; excluded dirty paths remain outside this Handoff.",
        source_refs: [gitEvidence.id]
      }] : [])
    ],
    rollback: {
      availability: "not_required",
      destructive: false,
      refs: [gitEvidence.id]
    },
    review: { required: false, state: "not_requested", reviewer_refs: [] }
  };
}

function gitEvidenceCoversDelivery(evidence: EvidenceRecord, scope: IssueRunGitDeliveryScope): boolean {
  const facts = evidence.decisive_output.facts;
  const baseRevision = typeof facts.base_revision === "string" ? facts.base_revision.trim() : "";
  if (scope.base_revision !== "" && baseRevision !== scope.base_revision) return false;
  if (facts.pathspec_scope !== "selected_paths" ||
    facts.pathspec_sha256 !== gitPathspecFingerprint(scope.pathspecs) ||
    facts.pathspec_count !== scope.pathspecs.length) return false;
  return facts.working_tree_dirty === true ||
    (facts.revision_changed_from_base === true &&
      typeof facts.head_revision === "string" &&
      baseRevision !== facts.head_revision.trim());
}

function gitSnapshotArtifact(
  db: RunnerDatabase,
  evidence: EvidenceRecord
): { content: string; ref: string } | undefined {
  if (evidence.decisive_output.facts.changed_paths_inline !== false) return undefined;
  const artifact = evidence.artifact_refs.find((item) => item.sha256 && item.media_type === "application/json");
  if (!artifact) throw new Error("Git Evidence snapshot artifact is missing");
  const root = resolve(dirname(db.path));
  const path = resolve(root, artifact.ref);
  if (path === root || !path.startsWith(`${root}${sep}`)) {
    throw new Error("Git Evidence snapshot artifact escapes the state directory");
  }
  return { content: readFileSync(path, "utf8"), ref: artifact.ref };
}

function requiredDeliveryFact(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) {
    throw new Error(`${label} is missing a full Git object id`);
  }
  return value;
}

export async function captureRuntimeVerification(
  db: RunnerDatabase,
  issueID: number,
  input: RuntimeVerificationCaptureInput,
  now = new Date().toISOString()
): Promise<RuntimeVerificationCaptureResult> {
  const issue = mustGetIssue(db, issueID);
  const run = latestIssueRun(db, issueID);
  const binding = correlationBinding(run);
  if (input.run_id !== binding.run_id) {
    throw new Error(`verification Evidence Run mismatch: expected ${binding.run_id}`);
  }
  if (!COMMAND_EVIDENCE_CHANNELS.includes(input.channel)) {
    throw new Error("unsupported verification Evidence channel");
  }
  const kind = input.kind ?? classifyVerificationCommand(input.observation.command);
  if (!kind) {
    throw new Error("verification command is not safely classifiable; use kind only through the explicit verification API");
  }
  const identity = createHash("sha256").update(stableJson({
    channel: input.channel,
    correlation_id: input.correlation_id,
    issue_id: issueID,
    run_id: binding.run_id,
    source_ref: input.source_ref
  })).digest("hex").slice(0, 32);
  const evidenceID = makeDomainID("evidence", "issue_events", `runtime-${identity}`);
  const existing = listStoredEvidence(db, {
    issue_ids: [issueID],
    limit: 1000,
    run_ids: [binding.run_id]
  }).items.find((item) => item.evidence.id === evidenceID)?.evidence;
  const collector = createCommandEvidenceCollector({
    artifact_store: new FileSystemCommandEvidenceArtifactStore(dirname(db.path))
  });
  const evidence = await collector.collect({
    artifact_refs: input.artifact_refs,
    context: {
      attempt_id: binding.attempt_id,
      audit_event_ref: `runtime-evidence:${input.correlation_id}`,
      collected_at: input.observation.ended_at,
      evidence_id: evidenceID,
      producer: { id: input.producer_id.trim() || "runtime-verification-api", kind: "runner" },
      run_id: binding.run_id,
      source_ref: input.source_ref,
      work_id: issueAsWork(issue).id
    },
    correlation: {
      channel: input.channel,
      correlation_id: input.correlation_id,
      terminal_interaction_count: input.channel === "terminal_interaction" ? 1 : 0
    },
    kind,
    observation: input.observation
  });
  if (existing) {
    if (stableJson(existing) !== stableJson(evidence)) {
      throw new Error(`verification Evidence ${evidenceID} conflicts with its append-only replay`);
    }
    return { evidence: existing, replayed: true };
  }
  recordEvidenceRecords(db, issueID, [evidence], {
    recorded_at: canonicalNow(now),
    source: `runtime-evidence:${input.channel}`
  });
  return { evidence, replayed: false };
}

export async function captureRuntimeEvidenceFromIssueLog(
  db: RunnerDatabase,
  issueID: number,
  event: IssueEvent,
  expectedIssueRunID: string,
  now = new Date().toISOString()
): Promise<RuntimeVerificationCaptureResult | null> {
  const run = latestIssueRun(db, issueID);
  if (run.id !== expectedIssueRunID) {
    recordCaptureRejected(db, issueID, event.id, "run_mismatch", `expected current Run ${run.id}, received ${expectedIssueRunID}`);
    return null;
  }
  const projection = await projectIssueRuntimeEvidence(db, issueID, now, { persist_artifacts: true });
  const evidence = projection.evidence.find((item) => item.provenance.source_ref === `issue_events:${event.id}`);
  if (!evidence) {
    const relatedError = projection.errors.find((error) => error.startsWith(`issue event ${event.id}:`));
    if (relatedError) recordCaptureRejected(db, issueID, event.id, "not_captured", relatedError);
    return null;
  }
  const existing = listStoredEvidence(db, {
    issue_ids: [issueID],
    limit: 1000,
    run_ids: [evidence.run_id!]
  }).items.some((item) => item.evidence.id === evidence.id);
  recordEvidenceRecords(db, issueID, [evidence], {
    recorded_at: canonicalNow(now),
    source: "provider-runtime-command"
  });
  return { evidence, replayed: existing };
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
  now = new Date().toISOString(),
  options: { persist_artifacts?: boolean } = {}
): Promise<RuntimeEvidenceProjection> {
  const issue = mustGetIssue(db, issueID);
  const run = listIssueRuns(db, issueID).at(-1);
  const rows = recentCommandEvents(db, issueID, run);
  const logs = rows.map(parseIssueLog).filter((item): item is ParsedIssueLog => item !== undefined);
  const collector = createCommandEvidenceCollector(options.persist_artifacts
    ? { artifact_store: new FileSystemCommandEvidenceArtifactStore(dirname(db.path)) }
    : {});
  const evidence: EvidenceRecord[] = [];
  const errors: string[] = [];
  for (const log of logs) {
    const row = log.row;
    const item = log.item;
    if (!item) continue;
    const command = commandText(item);
    const kind = classifyVerificationCommand(command);
    if (!kind) continue;
    try {
      if (run) validateRuntimeCorrelation(log, run);
      const timing = commandTiming(item, row.created_at);
      const runID = run ? makeDomainID("run", "issue_runs", run.id) : undefined;
      const terminalInteractions = matchingTerminalInteractions(log, logs);
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
        correlation: {
          channel: terminalInteractions.length > 0 ? "terminal_interaction" : "direct_command",
          correlation_id: commandCorrelationID(log),
          terminal_interaction_count: terminalInteractions.length
        },
        kind,
        observation: {
          command,
          cwd: cleanString(item.cwd) || ".",
          duration_ms: timing.duration,
          ended_at: timing.ended,
          exit_code: integerOrNull(item.exitCode),
          started_at: timing.started,
          stderr: cleanString(item.stderr),
          stdout: cleanString(item.stdout) || cleanString(item.aggregatedOutput),
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
  if (value === "" || unsafeCompoundVerificationCommand(value)) return undefined;
  const segments = value.split(/\s*&&\s*/).map((segment) => segment.trim()).filter(Boolean);
  const kinds = segments.map(classifySingleVerificationCommand).filter(Boolean) as CommandEvidenceKind[];
  if (kinds.includes("test")) return "test";
  if (kinds.includes("lint")) return "lint";
  if (kinds.includes("build")) return "build";
  return undefined;
}

function classifySingleVerificationCommand(value: string): CommandEvidenceKind | undefined {
  const test = /(?:^|\s)(?:bun\s+test|node\s+--test|npm\s+(?:run\s+)?test|pnpm\s+(?:run\s+)?test|yarn\s+(?:run\s+)?test|deno\s+test|cargo\s+test|go\s+test|flutter\s+test|pytest|python\d*\s+-m\s+(?:pytest|unittest))(?:\s|$)/i;
  const lint = /(?:^|\s)(?:bun\s+(?:run\s+)?lint|npm\s+(?:run\s+)?lint|pnpm\s+(?:run\s+)?lint|yarn\s+(?:run\s+)?lint|eslint|ruff\s+check|cargo\s+clippy|flutter\s+analyze|dart\s+analyze|tsc\b[^\n;&|]*--noEmit)(?:\s|$)/i;
  const build = /(?:^|\s)(?:bun\s+(?:run\s+)?build|npm\s+(?:run\s+)?build|pnpm\s+(?:run\s+)?build|yarn\s+(?:run\s+)?build|cargo\s+build|go\s+build|flutter\s+build|xcodebuild|tsc)(?:\s|$)/i;
  if (test.test(value)) return "test";
  if (lint.test(value)) return "lint";
  if (build.test(value)) return "build";
  return undefined;
}

function evaluateCompletion(issue: Issue, input: IssueVerifierReviewInput): VerificationPolicyEvaluation {
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

function evaluationRunContext(input: IssueVerifierReviewInput): {
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

function transitionIssue(
  db: RunnerDatabase,
  issue: Issue,
  to: "done" | "failed" | "pending_verification",
  audit: WorkTransitionAudit,
  acceptance: WorkAcceptanceEvidence | undefined,
  patch: UpdateIssueInput
): Issue {
  const work = projectIssueAsWork(db, issue);
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
  handoff: StoredHandoffRecord | null
): WorkAcceptanceEvidence {
  const selected = selectedAcceptanceEvidenceIDs(evaluation);
  const records = evidence.filter((record) => selected.has(record.id) && record.status === "passed");
  return {
    contract_version: work.acceptance.version,
    evidence: records.map((record) => ({
      criterion_ids: work.acceptance.criteria.filter((criterion) => criterion.required).map((criterion) => criterion.id),
      id: record.id,
      status: record.status,
      work_id: record.work_id
    })),
    handoffs: handoff ? [{
      id: handoff.handoff.id,
      status: handoff.handoff.status === "delivered" ? "delivered" : "ready",
      work_id: handoff.handoff.work_id
    }] : []
  };
}

function selectedAcceptanceEvidenceIDs(evaluation: VerificationPolicyEvaluation): Set<string> {
  const selected = new Set<string>();
  for (const group of evaluation.groups) {
    for (const result of group.requirements) {
      if ((result.status === "passed" || result.status === "skipped") && result.evidence_id) selected.add(result.evidence_id);
    }
  }
  if (evaluation.override.applied && evaluation.override.evidence_id) selected.add(evaluation.override.evidence_id);
  return selected;
}

function acceptanceHandoffForCompletion(
  db: RunnerDatabase,
  issue: Issue,
  input: IssueCompletionGateInput
): StoredHandoffRecord | HandoffRecord | null {
  const runID = completionRunID(db, issue.id, input.run);
  if (!runID) return null;
  const workID = issueAsWork(issue).id;
  const existing = listStoredHandoffs(db, {
    limit: 100,
    statuses: ["ready", "delivered"],
    work_id: workID
  }).items.find((item) => item.handoff.run_ids.includes(runID));
  if (existing) return existing;
  if (input.handoff?.work_id !== workID || !input.handoff.run_ids.includes(runID)) return null;
  return input.handoff.status === "ready" || input.handoff.status === "delivered" ? input.handoff : null;
}

function persistAcceptanceHandoffEvidence(
  db: RunnerDatabase,
  issueID: number,
  issue: Issue,
  input: IssueCompletionGateInput,
  evaluation: VerificationPolicyEvaluation
): StoredHandoffRecord | null {
  const candidate = acceptanceHandoffForCompletion(db, issue, input);
  const current = candidate && "event_id" in candidate
    ? candidate
    : candidate ? listStoredHandoffs(db, {
      limit: 100,
      statuses: ["ready", "delivered"],
      work_id: issueAsWork(issue).id
    }).items.find((item) => item.handoff.id === candidate.id) ?? null : null;
  if (!current) return null;
  const selected = selectedAcceptanceEvidenceIDs(evaluation);
  const missing = [...selected].filter((id) => !current.handoff.evidence_ids.includes(id as EvidenceRecord["id"]));
  if (missing.length === 0) return current;
  const revised: HandoffRecord = {
    ...current.handoff,
    evidence_ids: [...new Set([
      ...current.handoff.evidence_ids,
      ...missing as EvidenceRecord["id"][]
    ])].sort(),
    revision: current.handoff.revision + 1,
    updated_at: latestTimestamp(current.handoff.updated_at, canonicalNow(input.now))
  };
  return recordHandoff(db, issueID, revised, {
    recorded_at: canonicalNow(input.now),
    source: `${input.source}:completion-acceptance`
  }).record;
}

function completionRunID(
  db: RunnerDatabase,
  issueID: number,
  run: Pick<IssueRun, "attempt" | "id"> | undefined
): EvidenceRecord["run_id"] | undefined {
  const selected = run ?? listIssueRuns(db, issueID).at(-1);
  return selected ? makeDomainID("run", "issue_runs", selected.id) : undefined;
}

function latestTimestamp(left: string, right: string): string {
  return left > right ? left : right;
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
  evaluation: VerificationPolicyEvaluation,
  handoff: StoredHandoffRecord | HandoffRecord | null
): string {
  return createHash("sha256").update(stableJson({
    evidence: input.evidence.map((item) => ({ id: item.id, revision: item.revision, status: item.status })),
    handoff: handoff
      ? ("event_id" in handoff
        ? { id: handoff.handoff.id, revision: handoff.handoff.revision, status: handoff.handoff.status }
        : { id: handoff.id, revision: handoff.revision, status: handoff.status })
      : null,
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
  `).all(...args).reverse().map((row) => ({
    ...row,
    payload: hydrateStoredIssueLogPayload(db, row.payload)
  }));
}

function parseIssueLog(row: IssueLogRow): ParsedIssueLog | undefined {
  const payload = row.payload;
  const event = parsedObject(payload);
  if (!event) return undefined;
  const method = cleanString(event.raw_method);
  const raw = typeof event.raw_payload === "string"
    ? parsedObject(event.raw_payload) ?? {}
    : recordObject(event.raw_payload) ?? {};
  const itemValue = raw.item;
  const candidate = recordObject(itemValue);
  const commandItem = method === "item/completed" && candidate && candidate.type === "commandExecution" &&
    (candidate.status === "completed" || candidate.status === "failed")
    ? candidate as StoredCommandItem
    : undefined;
  const item = commandItem ?? (method === "item/completed" && candidate
    ? codexDynamicExecObservation(candidate)
    : undefined);
  const correlation = runtimeCorrelation(event.runtime_evidence_correlation);
  return { ...(correlation ? { correlation } : {}), ...(item ? { item } : {}), method, raw, row };
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

function unsafeCompoundVerificationCommand(command: string): boolean {
  const lines = command.split("\n").map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^set\s+-/.test(line) && !/^cd\s+/.test(line));
  if (lines.length > 1) return true;
  const value = lines[0] ?? command;
  return /(?:;|\||`|\$\(|\$\{|<\(|>\(|\beval\b|(?:^|\s)(?:ba|z|da|fi)?sh\s+-[a-z]*c\b)/i.test(value);
}

function validateRuntimeCorrelation(log: ParsedIssueLog, run: IssueRun): void {
  const expected = correlationBinding(run);
  if (log.correlation) {
    if (log.correlation.contract !== RUNTIME_EVIDENCE_CORRELATION_CONTRACT ||
      log.correlation.issue_run_id !== run.id ||
      log.correlation.run_id !== expected.run_id ||
      log.correlation.attempt_id !== expected.attempt_id) {
      throw new Error("runtime Evidence correlation does not match the current Run/Attempt");
    }
    return;
  }
  const sessionID = cleanString(log.raw.threadId) || cleanString(log.raw.sessionId);
  const turnID = cleanString(log.raw.turnId);
  if (run.provider_session_id && sessionID && sessionID !== run.provider_session_id) {
    throw new Error("provider session does not match the current Run");
  }
  if (run.provider_turn_id && turnID && turnID !== run.provider_turn_id) {
    throw new Error("provider turn does not match the current Attempt");
  }
}

function matchingTerminalInteractions(command: ParsedIssueLog, logs: readonly ParsedIssueLog[]): ParsedIssueLog[] {
  const itemID = cleanString(command.item?.id);
  const processID = cleanString(command.item?.processId);
  if (!itemID && !processID) return [];
  return logs.filter((candidate) => {
    if (candidate.method !== "item/commandExecution/terminalInteraction") return false;
    if (command.correlation && candidate.correlation && stableJson(command.correlation) !== stableJson(candidate.correlation)) {
      return false;
    }
    const candidateItemID = cleanString(candidate.raw.itemId);
    const candidateProcessID = cleanString(candidate.raw.processId);
    return (itemID !== "" && candidateItemID === itemID) || (processID !== "" && candidateProcessID === processID);
  });
}

function commandCorrelationID(log: ParsedIssueLog): string {
  const itemID = cleanString(log.item?.id);
  if (itemID) return `${log.correlation?.issue_run_id ?? "legacy"}:${itemID}`;
  return `issue-event:${log.row.id}`;
}

function runtimeCorrelation(value: unknown): RuntimeEvidenceCorrelation | undefined {
  const record = recordObject(value);
  if (!record || record.contract !== RUNTIME_EVIDENCE_CORRELATION_CONTRACT) return undefined;
  const correlation: RuntimeEvidenceCorrelation = {
    attempt_id: cleanString(record.attempt_id),
    contract: RUNTIME_EVIDENCE_CORRELATION_CONTRACT,
    issue_run_id: cleanString(record.issue_run_id),
    provider: cleanString(record.provider),
    provider_session_id: cleanString(record.provider_session_id),
    provider_turn_id: cleanString(record.provider_turn_id),
    run_id: cleanString(record.run_id)
  };
  // 出现 contract 标记后保留残缺字段，让校验 fail closed，不能退回 legacy 匹配。
  return correlation;
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

export async function runtimeVerificationGap(
  db: RunnerDatabase,
  issueID: number,
  now = new Date().toISOString()
): Promise<VerificationGap> {
  const run = listIssueRuns(db, issueID).at(-1);
  if (!run) return { reason: "not_executed", detail: "当前 Work 尚未创建 Run，验证命令未执行。" };
  const binding = correlationBinding(run);
  const projection = await projectIssueRuntimeEvidence(db, issueID, now);
  const stored = listStoredEvidence(db, { issue_ids: [issueID], limit: 1000 }).items.map((item) => item.evidence);
  const all = uniqueEvidence([...stored, ...projection.evidence]);
  const current = all.filter((item) => item.run_id === binding.run_id && ["test", "lint", "build"].includes(item.kind))
    .sort((left, right) => right.observed_at.localeCompare(left.observed_at));
  const latest = current[0];
  if (latest) {
    if (latest.status !== "passed") {
      return { reason: "failed", detail: `当前 Run 最新 Evidence 状态为 ${latest.status}。` };
    }
    if (Date.parse(canonicalNow(now)) - Date.parse(latest.observed_at) > 24 * 60 * 60 * 1000) {
      return { reason: "stale", detail: "当前 Run 的 passing Evidence 已超过 24 小时有效期。" };
    }
    return { reason: "none", detail: "当前 Run 已有可用于 completion gate 的 passing Evidence。" };
  }
  if (projection.errors.some((error) => /does not match the current|provider (?:session|turn) does not match/i.test(error))) {
    return { reason: "run_mismatch", detail: "捕获到验证结果，但其 Run/Attempt correlation 与当前 Run 不匹配。" };
  }
  if (all.some((item) => item.work_id === issueAsWork(mustGetIssue(db, issueID)).id && item.run_id !== binding.run_id &&
    ["test", "lint", "build"].includes(item.kind))) {
    return { reason: "run_mismatch", detail: "只有旧 Run 的验证 Evidence；旧结果不能完成当前 Run。" };
  }
  const logs = recentCommandEvents(db, issueID, run).map(parseIssueLog).filter((item): item is ParsedIssueLog => item !== undefined);
  const verificationObserved = logs.some((log) => log.item && Boolean(classifySingleVerificationCommand(commandText(log.item))));
  if (verificationObserved || projection.errors.length > 0) {
    return { reason: "not_captured", detail: "已观察到验证命令，但没有捕获到可绑定当前 Run 的终态结果。" };
  }
  return { reason: "not_executed", detail: "当前 Run 尚未执行可识别的 test、lint 或 build 验证命令。" };
}

function currentRunEvidence(
  db: RunnerDatabase,
  issueID: number,
  run: IssueRun | undefined,
  projected: readonly EvidenceRecord[]
): EvidenceRecord[] {
  if (!run) return uniqueEvidence(projected);
  const runID = correlationBinding(run).run_id;
  const stored = listStoredEvidence(db, {
    issue_ids: [issueID],
    limit: 1000,
    run_ids: [runID]
  }).items.map((item) => item.evidence);
  return uniqueEvidence([...stored, ...projected.filter((item) => item.run_id === runID)]);
}

function uniqueEvidence(records: readonly EvidenceRecord[]): EvidenceRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });
}

function latestIssueRun(db: RunnerDatabase, issueID: number): IssueRun {
  const run = listIssueRuns(db, issueID).at(-1);
  if (!run) throw new Error("verification Evidence requires a current Run");
  return run;
}

function correlationBinding(run: IssueRun): {
  attempt_id: NonNullable<EvidenceRecord["attempt_id"]>;
  run_id: NonNullable<EvidenceRecord["run_id"]>;
} {
  const runID = makeDomainID("run", "issue_runs", run.id);
  return { attempt_id: makeRunAttemptID(runID, run.attempt), run_id: runID };
}

function recordCaptureRejected(
  db: RunnerDatabase,
  issueID: number,
  issueEventID: number,
  reason: "not_captured" | "run_mismatch",
  detail: string
): void {
  const fingerprint = createHash("sha256").update(`${issueEventID}:${reason}:${detail}`).digest("hex");
  const replay = db.sqlite.query<{ id: number }, [number, string]>(`
    select id from issue_events where issue_id=? and type='issue.verification_capture_rejected.v1'
      and json_valid(payload) and json_extract(payload, '$.fingerprint')=? limit 1
  `).get(issueID, fingerprint);
  if (replay) return;
  recordIssueEvent(db, issueID, "issue.verification_capture_rejected.v1", {
    detail,
    fingerprint,
    issue_event_id: issueEventID,
    reason
  });
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

function recordObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
