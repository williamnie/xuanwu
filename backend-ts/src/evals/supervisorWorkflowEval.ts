import type { IssueSupervisorEvent } from "../db/repositories/pi.ts";
import { listBrowserAssistantTools } from "../pi/browserToolProvider.ts";
import { listBuiltinAssistantTools } from "../pi/builtinToolRegistry.ts";
import { listHttpAssistantTools } from "../pi/httpToolProvider.ts";
import { supervisorReportSummary } from "../pi/reportSupervisorSummary.ts";
import { implementWorkflowRegistryContributions } from "../workflows/implement.ts";
import { investigateWorkflowRegistryContributions } from "../workflows/investigate.ts";
import { createWorkflowRegistry } from "../workflows/registry.ts";
import { longRunningWorkflowRegistryContributions } from "../workflows/releaseResearchMigrate.ts";
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

const CONTROL_TOOL_NAMES = new Set<string>([
  ...listBuiltinAssistantTools(),
  ...listHttpAssistantTools(),
  ...listBrowserAssistantTools()
].map((tool) => tool.name));

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
  _registry: ReturnType<typeof workflowRegistry>
): SupervisorWorkflowCaseResult {
  const observation = fixture.observations[variant.id]!;
  const scorers = fixture.required_scorers.map((scorer) => scoreFixture(scorer, suite, fixture, observation));
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
  observation: SupervisorWorkflowEvalCase["observations"][string]
): SupervisorWorkflowScorerResult {
  if (scorer === "completion_gate") {
    const actual = completionDecision(fixture.input.completion_evidence);
    return exactResult(scorer, fixture.golden.completion, actual,
      "deterministic completion gate differs from golden output");
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

function completionDecision(evidence: SupervisorWorkflowEvalCase["input"]["completion_evidence"]): {
  decision: "failed" | "passed" | "pending";
  target_status: "done" | "failed" | "pending_verification";
} {
  if (evidence === "passed") return { decision: "passed", target_status: "done" };
  if (evidence === "failed") return { decision: "failed", target_status: "failed" };
  return { decision: "pending", target_status: "pending_verification" };
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
