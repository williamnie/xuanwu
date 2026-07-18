import type { IssueSupervisorEvent } from "../db/repositories/pi.ts";
import { ISSUE_WORK_VERIFICATION_POLICY } from "../domain/evidence/completionGate.ts";
import type { EvidenceRecord, RunID, WorkID } from "../domain/evidence/contracts.ts";
import { evaluateWorkflowVerificationPolicy } from "../domain/evidence/policy.ts";
import { listBrowserAssistantTools } from "../pi/browserToolProvider.ts";
import { listBuiltinAssistantTools } from "../pi/builtinToolRegistry.ts";
import { listHttpAssistantTools } from "../pi/httpToolProvider.ts";
import { supervisorReportSummary } from "../pi/reportSupervisorSummary.ts";
import type { SupervisorContextResolution } from "../pi/supervisorContextResolver.ts";
import { SUPERVISOR_CONTROL_TOOL_NAMES } from "../pi/supervisorControlContracts.ts";
import { routeSupervisorIntent } from "../pi/supervisorIntentRouter.ts";
import { planSupervisorWork } from "../pi/supervisorWorkPlanner.ts";
import { implementWorkflowRegistryContributions, IMPLEMENT_WORKFLOW_REF } from "../workflows/implement.ts";
import { investigateWorkflowRegistryContributions, INVESTIGATE_WORKFLOW_REF } from "../workflows/investigate.ts";
import { createWorkflowRegistry } from "../workflows/registry.ts";
import { longRunningWorkflowRegistryContributions, RELEASE_WORKFLOW_REF } from "../workflows/releaseResearchMigrate.ts";
import type {
  SupervisorWorkflowEvalCase,
  SupervisorWorkflowEvalScorer,
  SupervisorWorkflowEvalSuite,
  SupervisorWorkflowModelVariant
} from "./supervisorWorkflowContracts.ts";

export type SupervisorWorkflowScorerResult = {
  actual: unknown;
  expected: unknown;
  passed: boolean;
  reason: string;
  scorer: SupervisorWorkflowEvalScorer;
};

export type SupervisorWorkflowCaseResult = {
  case_id: string;
  passed: boolean;
  score: number;
  scorers: SupervisorWorkflowScorerResult[];
  tags: string[];
};

export type SupervisorWorkflowVariantResult = {
  estimated_cost_usd: number;
  model: string;
  passed: boolean;
  provider: string;
  required_scorer_scores: Partial<Record<SupervisorWorkflowEvalScorer, number>>;
  score: number;
  total_tokens: number;
  variant_id: string;
  cases: SupervisorWorkflowCaseResult[];
};

export type SupervisorWorkflowEvalReport = {
  cases: number;
  generated_at: string;
  regression: {
    baseline_variant_id: string;
    comparisons: Array<{
      candidate_variant_id: string;
      passed: boolean;
      score_regression: number;
      token_regression_ratio: number;
    }>;
  };
  schema_version: "xw.supervisor-workflow-eval-report.v1";
  status: "passed" | "failed";
  suite_id: string;
  thresholds: SupervisorWorkflowEvalSuite["regression_threshold"];
  variants: SupervisorWorkflowVariantResult[];
};

const CONTROL_TOOL_NAMES = new Set<string>(SUPERVISOR_CONTROL_TOOL_NAMES);

export function runSupervisorWorkflowEvaluation(suite: SupervisorWorkflowEvalSuite): SupervisorWorkflowEvalReport {
  const registry = workflowRegistry();
  const variants = suite.model_variants.map((variant) => evaluateVariant(suite, variant, registry));
  const baseline = variants.find((variant) => (
    suite.model_variants.find((candidate) => candidate.id === variant.variant_id)?.baseline
  ));
  if (!baseline) throw new Error("evaluation baseline is missing after suite validation");
  const comparisons = variants.filter((variant) => variant.variant_id !== baseline.variant_id).map((candidate) => {
    const scoreRegression = round(Math.max(0, baseline.score - candidate.score));
    const tokenRegressionRatio = baseline.total_tokens === 0
      ? candidate.total_tokens === 0 ? 0 : candidate.total_tokens
      : round(Math.max(0, (candidate.total_tokens - baseline.total_tokens) / baseline.total_tokens));
    return {
      candidate_variant_id: candidate.variant_id,
      passed: scoreRegression <= suite.regression_threshold.max_score_regression &&
        tokenRegressionRatio <= suite.regression_threshold.max_token_regression_ratio,
      score_regression: scoreRegression,
      token_regression_ratio: tokenRegressionRatio
    };
  });
  const status = variants.every((variant) => variant.passed) && comparisons.every((item) => item.passed)
    ? "passed" : "failed";
  return {
    cases: suite.cases.length,
    generated_at: suite.evaluation_time,
    regression: { baseline_variant_id: baseline.variant_id, comparisons },
    schema_version: "xw.supervisor-workflow-eval-report.v1",
    status,
    suite_id: suite.suite_id,
    thresholds: suite.regression_threshold,
    variants
  };
}

export function renderSupervisorWorkflowEvalMarkdown(report: SupervisorWorkflowEvalReport): string {
  const lines = [
    `# Supervisor / Workflow Evaluation: ${report.suite_id}`,
    "",
    `- Status: **${report.status.toUpperCase()}**`,
    `- Cases: ${report.cases}`,
    `- Generated at: ${report.generated_at}`,
    `- Baseline: \`${report.regression.baseline_variant_id}\``,
    "",
    "| Variant | Score | Required scorers | Tokens | Cost USD | Status |",
    "| --- | ---: | --- | ---: | ---: | --- |"
  ];
  for (const variant of report.variants) {
    const scorers = Object.entries(variant.required_scorer_scores)
      .map(([name, score]) => `${name}=${Number(score).toFixed(3)}`).join(", ");
    lines.push(`| ${variant.variant_id} | ${variant.score.toFixed(3)} | ${scorers} | ${variant.total_tokens} | ${variant.estimated_cost_usd.toFixed(6)} | ${variant.passed ? "passed" : "failed"} |`);
  }
  if (report.regression.comparisons.length > 0) {
    lines.push("", "## Regression", "", "| Candidate | Score regression | Token regression | Status |", "| --- | ---: | ---: | --- |");
    for (const item of report.regression.comparisons) {
      lines.push(`| ${item.candidate_variant_id} | ${item.score_regression.toFixed(3)} | ${(item.token_regression_ratio * 100).toFixed(2)}% | ${item.passed ? "passed" : "failed"} |`);
    }
  }
  const failures = report.variants.flatMap((variant) => variant.cases.flatMap((fixture) => (
    fixture.scorers.filter((scorer) => !scorer.passed).map((scorer) => ({ fixture, scorer, variant }))
  )));
  if (failures.length > 0) {
    lines.push("", "## Failures", "");
    for (const failure of failures) {
      lines.push(`- \`${failure.variant.variant_id}/${failure.fixture.case_id}/${failure.scorer.scorer}\`: ${failure.scorer.reason}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function evaluateVariant(
  suite: SupervisorWorkflowEvalSuite,
  variant: SupervisorWorkflowModelVariant,
  registry: ReturnType<typeof workflowRegistry>
): SupervisorWorkflowVariantResult {
  const cases = suite.cases.map((fixture) => evaluateCase(suite, fixture, variant, registry));
  const scorerScores: Partial<Record<SupervisorWorkflowEvalScorer, number>> = {};
  const scorerNames = new Set(cases.flatMap((fixture) => fixture.scorers.map((scorer) => scorer.scorer)));
  for (const name of scorerNames) {
    const results = cases.flatMap((fixture) => fixture.scorers.filter((scorer) => scorer.scorer === name));
    scorerScores[name] = round(results.filter((result) => result.passed).length / results.length);
  }
  const score = round(cases.reduce((sum, fixture) => sum + fixture.score, 0) / cases.length);
  const observation = suite.cases.map((fixture) => fixture.observations[variant.id]!);
  const totalTokens = observation.reduce((sum, item) => sum + item.token_usage.total_tokens, 0);
  const estimatedCost = round(observation.reduce((sum, item) => sum + item.token_usage.estimated_cost_usd, 0), 8);
  const requiredScorersPass = Object.values(scorerScores).every((value) => (
    value !== undefined && value >= suite.regression_threshold.min_required_scorer_score
  ));
  return {
    cases,
    estimated_cost_usd: estimatedCost,
    model: variant.model,
    passed: score >= suite.regression_threshold.min_overall_score && requiredScorersPass,
    provider: variant.provider,
    required_scorer_scores: scorerScores,
    score,
    total_tokens: totalTokens,
    variant_id: variant.id
  };
}

function evaluateCase(
  suite: SupervisorWorkflowEvalSuite,
  fixture: SupervisorWorkflowEvalCase,
  variant: SupervisorWorkflowModelVariant,
  registry: ReturnType<typeof workflowRegistry>
): SupervisorWorkflowCaseResult {
  const observation = fixture.observations[variant.id]!;
  const route = fixture.required_scorers.includes("intent_route") || fixture.required_scorers.includes("work_plan")
    ? routeSupervisorIntent({ prompt: fixture.input.prompt, source: fixture.input.source }) : undefined;
  const plan = fixture.required_scorers.includes("work_plan") && route
    ? planSupervisorWork({
      context: resolvedContext(fixture.input.project_id, route.input_audit.input_digest),
      goal: fixture.input.prompt,
      intent_route: route,
      source: fixture.input.source,
      workflow_refs: {
        implement: IMPLEMENT_WORKFLOW_REF,
        investigate: INVESTIGATE_WORKFLOW_REF,
        release: RELEASE_WORKFLOW_REF
      },
      workflow_registry: registry
    }) : undefined;
  const scorers = fixture.required_scorers.map((scorer) => scoreFixture(scorer, suite, fixture, observation, route, plan));
  return {
    case_id: fixture.id,
    passed: scorers.every((scorer) => scorer.passed),
    score: round(scorers.filter((scorer) => scorer.passed).length / scorers.length),
    scorers,
    tags: [...fixture.tags]
  };
}

function scoreFixture(
  scorer: SupervisorWorkflowEvalScorer,
  suite: SupervisorWorkflowEvalSuite,
  fixture: SupervisorWorkflowEvalCase,
  observation: SupervisorWorkflowEvalCase["observations"][string],
  route: ReturnType<typeof routeSupervisorIntent> | undefined,
  plan: ReturnType<typeof planSupervisorWork> | undefined
): SupervisorWorkflowScorerResult {
  if (scorer === "intent_route") {
    const actual = route && {
      decision: route.decision,
      intents: route.intents.map((intent) => intent.kind),
      primary_intent: route.primary_intent
    };
    return exactResult(scorer, fixture.golden.route, actual, "canonical intent route differs from golden output");
  }
  if (scorer === "work_plan") {
    const actual = plan && {
      mode: plan.mode,
      status: plan.status,
      work_count: plan.works.length,
      workflow_purposes: plan.workflow_selections.map((selection) => selection.purpose)
    };
    return exactResult(scorer, fixture.golden.plan, actual, "canonical Work plan differs from golden output");
  }
  if (scorer === "tool_selection") {
    const unknown = observation.selected_tools.filter((tool) => !CONTROL_TOOL_NAMES.has(tool));
    const exact = equal(fixture.golden.selected_tools, observation.selected_tools);
    return {
      actual: observation.selected_tools,
      expected: fixture.golden.selected_tools,
      passed: unknown.length === 0 && exact,
      reason: unknown.length > 0
        ? `variant selected tools outside Supervisor control authority: ${unknown.join(", ")}`
        : exact ? "selected tools match golden output" : "selected tools differ from golden output",
      scorer
    };
  }
  if (scorer === "completion_gate") {
    const actual = completionProjection(fixture, suite.evaluation_time);
    return exactResult(scorer, fixture.golden.completion, actual, "Evidence policy completion result differs from golden output");
  }
  if (scorer === "report") {
    const actualSummary = supervisorReportSummary((fixture.input.report_events ?? []).map(supervisorEvent));
    const actual = Object.fromEntries(Object.keys(fixture.golden.report ?? {}).map((key) => [
      key, actualSummary[key as keyof typeof actualSummary]
    ]));
    return exactResult(scorer, fixture.golden.report, actual, "canonical Supervisor report differs from golden output");
  }
  const actual = observation.token_usage;
  const passed = actual.total_tokens <= fixture.golden.max_total_tokens &&
    actual.estimated_cost_usd <= fixture.golden.max_estimated_cost_usd;
  return {
    actual,
    expected: {
      max_estimated_cost_usd: fixture.golden.max_estimated_cost_usd,
      max_total_tokens: fixture.golden.max_total_tokens
    },
    passed,
    reason: passed ? "token and cost budgets satisfied" : "token or estimated cost budget exceeded",
    scorer
  };
}

function completionProjection(fixture: SupervisorWorkflowEvalCase, now: string) {
  const workID = `xw:work:issues:${fixture.id}` as WorkID;
  const runID = `xw:run:issue_runs:${fixture.id}` as RunID;
  const evidence = fixture.input.completion_evidence === "missing"
    ? [] : [completionEvidence(fixture.id, fixture.input.completion_evidence!, workID, runID, now)];
  const evaluation = evaluateWorkflowVerificationPolicy({
    context: { now, project_id: fixture.input.project_id, risk: "safe", run_id: runID, work_id: workID },
    evidence,
    policy: ISSUE_WORK_VERIFICATION_POLICY
  });
  return {
    decision: evaluation.decision,
    target_status: evaluation.decision === "passed" || evaluation.decision === "overridden"
      ? "done" : evaluation.decision === "pending" ? "pending_verification" : "failed"
  };
}

function completionEvidence(
  id: string,
  outcome: "passed" | "failed",
  workID: WorkID,
  runID: RunID,
  now: string
): EvidenceRecord {
  return {
    artifact_refs: [],
    completed_at: now,
    created_at: now,
    decisive_output: { facts: { outcome }, summary: `offline fixture ${outcome}` },
    id: `xw:evidence:issue_events:${id}` as EvidenceRecord["id"],
    kind: "test",
    observed_at: now,
    provenance: {
      assertion_origin: "tool_result",
      audit_event_ref: `fixture:${id}:audit`,
      producer: { id: "runner:eval", kind: "runner" },
      source_kind: "test_runner",
      source_ref: `fixture:${id}`
    },
    redaction: { policy_ref: "evidence-redaction:eval@1", redacted_paths: [], status: "not_required" },
    revision: 0,
    run_id: runID,
    schema_version: 1,
    status: outcome,
    updated_at: now,
    work_id: workID
  };
}

function supervisorEvent(input: NonNullable<SupervisorWorkflowEvalCase["input"]["report_events"]>[number], index: number): IssueSupervisorEvent {
  return {
    action_id: `fixture-action-${index + 1}`,
    action_type: input.action_type ?? "",
    confidence: "1",
    created_at: "2026-07-18T00:00:00.000Z",
    decision: input.decision ?? "",
    diagnosis_code: input.diagnosis_code ?? "",
    event_type: input.event_type ?? "",
    id: index + 1,
    issue_id: input.issue_id,
    payload_json: "{}",
    project_id: "fixture-project",
    provider: "fixture",
    provider_error_category: input.provider_error_category ?? "",
    provider_session_id: "",
    provider_turn_id: "",
    retry_after_at: input.retry_after_at ?? "",
    run_id: ""
  };
}

function workflowRegistry() {
  const investigate = investigateWorkflowRegistryContributions();
  const implement = implementWorkflowRegistryContributions();
  const longRunning = longRunningWorkflowRegistryContributions();
  const releaseManifest = longRunning.manifests.find((entry) => (
    (entry.manifest as { id?: string }).id === "workflow:release"
  ));
  const releasePolicyIDs = new Set([
    "verification-policy:release-readiness",
    "verification-policy:release-publication"
  ]);
  const registry = createWorkflowRegistry({
    agent_profile_ids: [],
    available_actions: ["handoff.commit", "release.execute", "work.update"],
    manifests: [...investigate.manifests, ...implement.manifests, ...(releaseManifest ? [releaseManifest] : [])],
    skills: [],
    tools: [...listBuiltinAssistantTools(), ...listHttpAssistantTools(), ...listBrowserAssistantTools()],
    verification_policies: [
      ...investigate.verification_policies,
      ...implement.verification_policies,
      ...longRunning.verification_policies.filter((policy) => releasePolicyIDs.has(policy.id))
    ]
  });
  if (registry.diagnostics.length > 0) {
    throw new Error(`evaluation Workflow Registry is not ready: ${registry.diagnostics.map((item) => item.code).join(", ")}`);
  }
  return registry;
}

function resolvedContext(projectID: string, inputDigest: string): SupervisorContextResolution {
  return {
    candidates: [{
      project_id: projectID,
      score: 100,
      sources: [{ kind: "explicit_project", ref: `projects:${projectID}`, score: 100 }],
      work_ids: []
    }],
    clarification: { reason: "fixture project target is explicit", required: false },
    input_audit: { char_count: 1, input_digest: inputDigest },
    provenance: {
      context_inheritance_allowed: true,
      conversation_id: "eval-conversation",
      resolver: "deterministic_supervisor_context",
      source: "eval_fixture"
    },
    reason: "fixture project target is explicit",
    schema_version: "xw.supervisor-context-resolution.v1",
    status: "resolved",
    target: { issue_ids: [], project_id: projectID, work_ids: [] }
  };
}

function exactResult(
  scorer: SupervisorWorkflowEvalScorer,
  expected: unknown,
  actual: unknown,
  failure: string
): SupervisorWorkflowScorerResult {
  const passed = equal(expected, actual);
  return { actual, expected, passed, reason: passed ? "matches golden output" : failure, scorer };
}

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function round(value: number, digits = 6): number {
  return Number(value.toFixed(digits));
}
