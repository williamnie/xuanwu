import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../db/database.ts";
import { upsertAttentionInboxItemByEvidence } from "../db/repositories/attentionInboxItemUpsert.ts";
import type { ContextBundleRecord } from "../db/repositories/contextBundles.ts";
import {
  createIntakeRun,
  updateIntakeRun,
  type AttentionInboxItemRecord,
  type IntakeRunRecord
} from "../db/repositories/intakeRuns.ts";
import { assertIntakeSourcePolicy, type IntakeSourcePolicy } from "./intakeSourcePolicy.ts";
import { buildIntakeSkillInput, buildIntakeSkillPrompt, type IntakeSkillInput } from "./intakeSkillInput.ts";

type JsonObject = Record<string, unknown>;

export type AssistantModelPolicy = {
  domain_model?: string;
  fallback_model?: string;
  intake_model?: string;
  memory_model?: string;
  vision_model?: string;
};

export type IntakeSkillRuntime = {
  id?: string;
  input_object?: string;
  kind?: string;
  model_policy_id?: string;
  output_objects?: string[];
  output_schema?: JsonObject;
};

export type LlmIntakeRequest = {
  bundle: ContextBundleRecord;
  input: IntakeSkillInput;
  prompt: string;
  schema: JsonObject;
  skill: IntakeSkillRuntime & { id: string };
  skillId: string;
};

export type LlmIntakeModel = (request: LlmIntakeRequest) => Promise<unknown> | unknown;
export type LlmIntakeOptions = {
  model?: string;
  modelPolicy?: AssistantModelPolicy;
  modelPolicyId?: string;
  now?: Date;
  skill?: IntakeSkillRuntime;
  skillId?: string;
  sourcePolicy?: IntakeSourcePolicy;
};
export type LlmIntakeResult = {
  created_items: AttentionInboxItemRecord[];
  run: IntakeRunRecord;
};

const DEFAULT_SKILL_ID = "pi.llm_intake.v1";
const PRIMARY_INTENTS = [
  "bug_report", "status_question", "reply_needed", "follow_up",
  "decision_needed", "summarize_request", "create_task", "monitor_thread",
  "customer_feedback", "support_request", "other"
] as const;
const URGENCY_LEVELS = ["low", "medium", "high"] as const;
const objectOptions = { additionalProperties: false } as const;
const nonEmpty = Type.String({ minLength: 1 });
const stringArray = Type.Array(nonEmpty);
const evidenceArray = Type.Array(nonEmpty, { minItems: 1 });
const confidence = Type.Number({ maximum: 1, minimum: 0 });

const targetHintSchema = Type.Object({
  confidence,
  id: Type.Optional(Type.String()),
  kind: nonEmpty,
  label: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String())
}, objectOptions);

const ignoredSchema = Type.Object({
  confidence,
  evidence_refs: evidenceArray,
  group_id: Type.Optional(Type.String()),
  reason: nonEmpty,
  summary: Type.Optional(Type.String())
}, objectOptions);

const itemSchema = Type.Object({
  actor_refs: Type.Optional(stringArray),
  confidence,
  evidence_refs: evidenceArray,
  intents: Type.Object({
    primary: literalUnion(PRIMARY_INTENTS),
    secondary: stringArray,
    tags: Type.Optional(stringArray)
  }, objectOptions),
  suggested_actions: evidenceArray,
  summary: nonEmpty,
  target_hints: Type.Optional(Type.Array(targetHintSchema)),
  title: nonEmpty,
  urgency: Type.Optional(literalUnion(URGENCY_LEVELS))
}, objectOptions);

export const LLM_INTAKE_OUTPUT_SCHEMA = Type.Object({
  ignored_groups: Type.Array(ignoredSchema),
  inbox_items: Type.Array(itemSchema)
}, objectOptions);

export type LlmIntakeOutput = Static<typeof LLM_INTAKE_OUTPUT_SCHEMA>;

export async function runLlmIntake(
  db: RunnerDatabase,
  bundle: ContextBundleRecord,
  model: LlmIntakeModel,
  options: LlmIntakeOptions = {}
): Promise<LlmIntakeResult> {
  return runIntakeSkill(db, bundle, model, options);
}

export async function runIntakeSkill(
  db: RunnerDatabase,
  bundle: ContextBundleRecord,
  model: LlmIntakeModel,
  options: LlmIntakeOptions = {}
): Promise<LlmIntakeResult> {
  assertIntakeSourcePolicy(db, bundle, options.sourcePolicy, options.now);
  const skill = intakeSkill(options);
  const input = buildIntakeSkillInput(db, bundle);
  const run = createIntakeRun(db, {
    bundle_id: bundle.id, input_summary: input as unknown as JsonObject,
    model: intakeModelName(options), model_policy_id: modelPolicyId(options, skill),
    skill_id: skill.id, status: "running"
  });
  try {
    return persistIntakeSuccess(db, run, bundle, parseAndValidate(await model({
      bundle, input, prompt: buildIntakeSkillPrompt(input as unknown as JsonObject),
      schema: LLM_INTAKE_OUTPUT_SCHEMA as JsonObject, skill, skillId: skill.id
    })));
  } catch (error) {
    updateIntakeRun(db, run.id, { error: errorMessage(error), status: "failed" });
    throw error;
  }
}

export function buildIntakePrompt(bundle: ContextBundleRecord): string {
  return [
    "You are the PI Assistant LLM intake skill.",
    "Read the context bundle and return only JSON matching the provided schema.",
    "Create attention items for matters needing attention, reply, follow-up, tracking, or handling.",
    "If there are no attention items, return inbox_items=[] and at least one ignored_groups reason.",
    "Do not rely on keyword rules; judge the user's intent from the full context and evidence.",
    "Every item must include evidence_refs and confidence.",
    JSON.stringify(inputSummary(bundle), null, 2)
  ].join("\n");
}

function persistIntakeSuccess(
  db: RunnerDatabase,
  run: IntakeRunRecord,
  bundle: ContextBundleRecord,
  output: LlmIntakeOutput
): LlmIntakeResult {
  const savedRun = updateIntakeRun(db, run.id, {
    ignored_groups: output.ignored_groups as JsonObject[],
    schema_output: output as JsonObject,
    status: "succeeded"
  });
  const created = output.inbox_items.map((item) => upsertAttentionInboxItemByEvidence(db, itemInput(bundle, savedRun.id, item)));
  return { created_items: created, run: savedRun };
}

function parseAndValidate(raw: unknown): LlmIntakeOutput {
  const parsed = normalizeOutput(parseOutput(raw));
  const error = schemaError(parsed) || semanticError(parsed as LlmIntakeOutput);
  if (error) throw new Error(error);
  return parsed as LlmIntakeOutput;
}

function normalizeOutput(parsed: JsonObject): JsonObject {
  return {
    ignored_groups: arrayValue(parsed.ignored_groups ?? parsed.ignored),
    inbox_items: arrayValue(parsed.inbox_items ?? parsed.items)
  };
}

function parseOutput(raw: unknown): JsonObject {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as JsonObject;
  if (typeof raw !== "string") throw new Error("intake output is not a JSON object");
  try {
    const parsed = JSON.parse(extractJson(raw)) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as JsonObject;
  } catch { /* handled below */ }
  throw new Error("intake output is not a JSON object");
}

function schemaError(parsed: JsonObject): string {
  if (Value.Check(LLM_INTAKE_OUTPUT_SCHEMA, parsed)) return "";
  const details = [...Value.Errors(LLM_INTAKE_OUTPUT_SCHEMA, parsed)]
    .slice(0, 6)
    .map((error) => `${error.path || "/"}: ${error.message}`)
    .join("; ");
  return `intake output failed schema validation${details ? `: ${details}` : ""}`;
}

function semanticError(output: LlmIntakeOutput): string {
  if (output.inbox_items.length > 0 || output.ignored_groups.length > 0) return "";
  return "intake output must include ignored reason when no items are created";
}

function itemInput(
  bundle: ContextBundleRecord,
  runID: number,
  item: LlmIntakeOutput["inbox_items"][number]
) {
  return {
    actor_refs: item.actor_refs,
    bundle_id: bundle.id,
    confidence: item.confidence,
    evidence_refs: item.evidence_refs,
    intake_run_id: runID,
    primary_intent: item.intents.primary,
    schema_item: item as JsonObject,
    secondary_intents: item.intents.secondary,
    source: bundle.source,
    suggested_actions: item.suggested_actions,
    summary: item.summary,
    target_hints: item.target_hints as JsonObject[] | undefined,
    title: item.title,
    urgency: item.urgency
  };
}

function intakeSkill(options: LlmIntakeOptions): IntakeSkillRuntime & { id: string } {
  const skill = options.skill ?? {};
  const id = clean(options.skillId) || clean(skill.id) || DEFAULT_SKILL_ID;
  if (clean(skill.kind) !== "" && clean(skill.kind) !== "intake") throw new Error("intake skill kind must be intake");
  if (clean(skill.input_object) !== "" && clean(skill.input_object) !== "context_bundle") {
    throw new Error("intake skill input_object must be context_bundle");
  }
  const outputs = Array.isArray(skill.output_objects) ? skill.output_objects.map(clean).filter(Boolean) : [];
  if (outputs.length > 0 && (!outputs.includes("inbox_items") || !outputs.includes("ignored_groups"))) {
    throw new Error("intake skill must output inbox_items and ignored_groups");
  }
  return { ...skill, id, input_object: "context_bundle", kind: "intake" };
}

function intakeModelName(options: LlmIntakeOptions): string {
  return clean(options.model) || clean(options.modelPolicy?.intake_model);
}

function modelPolicyId(options: LlmIntakeOptions, skill: IntakeSkillRuntime): string {
  return clean(options.modelPolicyId) || clean(skill.model_policy_id);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function inputSummary(bundle: ContextBundleRecord): JsonObject {
  return {
    attachment_refs: bundle.attachment_refs,
    bundle_id: bundle.id,
    context: bundle.context,
    created_by: bundle.created_by,
    event_refs: bundle.event_refs,
    evidence_refs: bundle.evidence_refs,
    reason: bundle.reason,
    source: bundle.source,
    token_budget: bundle.token_budget,
    trigger: bundle.trigger,
    window: bundle.window
  };
}

function extractJson(raw: string): string {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  if (text.startsWith("{") && text.endsWith("}")) return text;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  return start >= 0 && end > start ? text.slice(start, end + 1) : text;
}

function literalUnion<const T extends readonly [string, string, ...string[]]>(values: T) {
  return Type.Union(values.map((value) => Type.Literal(value)) as [
    ReturnType<typeof Type.Literal>,
    ReturnType<typeof Type.Literal>,
    ...Array<ReturnType<typeof Type.Literal>>
  ]);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
