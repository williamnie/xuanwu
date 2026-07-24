import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const SUPERVISOR_WORKFLOW_EVAL_SCHEMA_VERSION = "xw.supervisor-workflow-eval-suite.v1" as const;
export const SUPERVISOR_WORKFLOW_EVAL_SCORERS = [
  "tool_selection",
  "completion_gate",
  "report",
  "token_cost"
] as const;

export type SupervisorWorkflowEvalScorer = typeof SUPERVISOR_WORKFLOW_EVAL_SCORERS[number];

const text = Type.String({ minLength: 1, maxLength: 8192 });
const identifier = Type.String({ minLength: 1, maxLength: 128, pattern: "^[a-z0-9][a-z0-9._-]*$" });
const scorer = Type.Union(SUPERVISOR_WORKFLOW_EVAL_SCORERS.map((name) => Type.Literal(name)));

const modelVariantSchema = Type.Object({
  baseline: Type.Boolean(),
  id: identifier,
  label: text,
  model: text,
  provider: text
}, { additionalProperties: false });

const tokenUsageSchema = Type.Object({
  estimated_cost_usd: Type.Number({ minimum: 0 }),
  input_tokens: Type.Integer({ minimum: 0 }),
  output_tokens: Type.Integer({ minimum: 0 }),
  total_tokens: Type.Integer({ minimum: 0 })
}, { additionalProperties: false });

const observationSchema = Type.Object({
  selected_tools: Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }),
  token_usage: tokenUsageSchema
}, { additionalProperties: false });

const reportEventSchema = Type.Object({
  action_type: Type.Optional(Type.String()),
  decision: Type.Optional(Type.String()),
  diagnosis_code: Type.Optional(Type.String()),
  event_type: Type.Optional(Type.String()),
  issue_id: Type.Integer({ minimum: 1 }),
  provider_error_category: Type.Optional(Type.String()),
  retry_after_at: Type.Optional(Type.String())
}, { additionalProperties: false });

const inputSchema = Type.Object({
  completion_evidence: Type.Optional(Type.Union([
    Type.Literal("passed"), Type.Literal("failed"), Type.Literal("missing")
  ])),
  project_id: Type.String({ minLength: 1, maxLength: 255 }),
  prompt: Type.String({ maxLength: 8192 }),
  report_events: Type.Optional(Type.Array(reportEventSchema, { maxItems: 64 })),
  source: Type.String({ minLength: 1, maxLength: 255 })
}, { additionalProperties: false });

const goldenSchema = Type.Object({
  completion: Type.Optional(Type.Object({
    decision: Type.Union([Type.Literal("passed"), Type.Literal("pending"), Type.Literal("failed")]),
    target_status: Type.Union([
      Type.Literal("done"), Type.Literal("pending_verification"), Type.Literal("failed")
    ])
  }, { additionalProperties: false })),
  max_estimated_cost_usd: Type.Number({ minimum: 0 }),
  max_total_tokens: Type.Integer({ minimum: 0 }),
  report: Type.Optional(Type.Record(Type.String({ minLength: 1 }), Type.Union([
    Type.String(), Type.Number(), Type.Boolean(), Type.Null()
  ]))),
  selected_tools: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 32 }))
}, { additionalProperties: false });

const evalCaseSchema = Type.Object({
  golden: goldenSchema,
  id: identifier,
  input: inputSchema,
  observations: Type.Record(identifier, observationSchema),
  required_scorers: Type.Array(scorer, { minItems: 1, maxItems: 6 }),
  tags: Type.Array(identifier, { minItems: 1, maxItems: 16 })
}, { additionalProperties: false });

export const SUPERVISOR_WORKFLOW_EVAL_SUITE_SCHEMA = Type.Object({
  cases: Type.Array(evalCaseSchema, { minItems: 1, maxItems: 256 }),
  evaluation_time: Type.String({ minLength: 20, maxLength: 35 }),
  model_variants: Type.Array(modelVariantSchema, { minItems: 1, maxItems: 16 }),
  regression_threshold: Type.Object({
    max_score_regression: Type.Number({ minimum: 0, maximum: 1 }),
    max_token_regression_ratio: Type.Number({ minimum: 0 }),
    min_overall_score: Type.Number({ minimum: 0, maximum: 1 }),
    min_required_scorer_score: Type.Number({ minimum: 0, maximum: 1 })
  }, { additionalProperties: false }),
  schema_version: Type.Literal(SUPERVISOR_WORKFLOW_EVAL_SCHEMA_VERSION),
  suite_id: identifier
}, { additionalProperties: false });

export type SupervisorWorkflowEvalSuite = Static<typeof SUPERVISOR_WORKFLOW_EVAL_SUITE_SCHEMA>;
export type SupervisorWorkflowEvalCase = SupervisorWorkflowEvalSuite["cases"][number];
export type SupervisorWorkflowModelVariant = SupervisorWorkflowEvalSuite["model_variants"][number];

export function parseSupervisorWorkflowEvalSuiteJSON(textValue: string): SupervisorWorkflowEvalSuite {
  let parsed: unknown;
  try {
    parsed = JSON.parse(textValue) as unknown;
  } catch (error) {
    throw new Error(`evaluation suite is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Value.Check(SUPERVISOR_WORKFLOW_EVAL_SUITE_SCHEMA, parsed)) {
    const errors = [...Value.Errors(SUPERVISOR_WORKFLOW_EVAL_SUITE_SCHEMA, parsed)]
      .map((error) => `${error.path || "/"}: ${error.message}`);
    throw new Error(`evaluation suite schema is invalid: ${errors.join("; ")}`);
  }
  const suite = parsed as SupervisorWorkflowEvalSuite;
  const errors = validateSuiteRelations(suite);
  if (errors.length > 0) throw new Error(`evaluation suite relations are invalid: ${errors.join("; ")}`);
  return suite;
}

function validateSuiteRelations(suite: SupervisorWorkflowEvalSuite): string[] {
  const errors: string[] = [];
  unique(suite.model_variants.map((variant) => variant.id), "model variant", errors);
  unique(suite.cases.map((fixture) => fixture.id), "case", errors);
  const baselines = suite.model_variants.filter((variant) => variant.baseline);
  if (baselines.length !== 1) errors.push("exactly one model variant must be the baseline");
  const variantIDs = new Set(suite.model_variants.map((variant) => variant.id));
  for (const fixture of suite.cases) {
    unique(fixture.required_scorers, `${fixture.id} required scorer`, errors);
    for (const variantID of variantIDs) {
      if (!fixture.observations[variantID]) errors.push(`${fixture.id} is missing observation for ${variantID}`);
    }
    for (const variantID of Object.keys(fixture.observations)) {
      if (!variantIDs.has(variantID)) errors.push(`${fixture.id} has observation for unknown variant ${variantID}`);
      const usage = fixture.observations[variantID]?.token_usage;
      if (usage && usage.total_tokens !== usage.input_tokens + usage.output_tokens) {
        errors.push(`${fixture.id}/${variantID} total_tokens must equal input_tokens + output_tokens`);
      }
    }
    validateScorerInputs(fixture, errors);
  }
  return errors;
}

function validateScorerInputs(fixture: SupervisorWorkflowEvalCase, errors: string[]): void {
  const required = new Set(fixture.required_scorers);
  if (required.has("tool_selection") && !fixture.golden.selected_tools) {
    errors.push(`${fixture.id} selected_tools golden is required`);
  }
  if (required.has("completion_gate") && (!fixture.golden.completion || !fixture.input.completion_evidence)) {
    errors.push(`${fixture.id} completion input and golden are required`);
  }
  if (required.has("report") && (!fixture.golden.report || !fixture.input.report_events)) {
    errors.push(`${fixture.id} report events and golden are required`);
  }
}

function unique(values: readonly string[], label: string, errors: string[]): void {
  if (new Set(values).size !== values.length) errors.push(`${label} ids must be unique`);
}
