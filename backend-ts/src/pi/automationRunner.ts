import type { RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { listExternalEvents, type ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import type { AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";
import type {
  AutomationMode,
  AutomationStepType,
  PiAutomationRecord
} from "../db/repositories/piAutomations.ts";
import { buildContextBundleFromEvents } from "./contextBundleBuilder.ts";
import {
  routeContextBundleToIntake,
  routeInboxItemToDomainSkill,
  type EventRouterSourcePolicy
} from "./eventRouter.ts";
import type { LlmIntakeOutput, LlmIntakeRequest } from "./llmIntake.ts";

type JsonObject = Record<string, unknown>;

export type PiAutomationPipelineResult = {
  detail: string;
  lastSuccessfulCursor: string;
  processedWatermark: string;
};

export async function runPiAutomationPipeline(
  automation: PiAutomationRecord,
  context: { database: RunnerDatabase; now: Date }
): Promise<PiAutomationPipelineResult> {
  const steps = stepTypes(automation);
  const source = automationSource(automation);
  const events = sourceEvents(context.database, source, automation);
  if (events.length === 0) return emptyRun(automation);
  const bundle = needsBundle(steps)
    ? createContextBundle(context.database, {
      ...buildContextBundleFromEvents(events, {
        createdBy: "automation",
        maxEvents: maxEvents(automation),
        source,
        tokenBudget: tokenBudget(automation),
        trigger: automation.trigger_type === "schedule" ? "schedule" : "continuous",
        windowMinutes: windowMinutes(automation)
      }),
      source_query: sourceQuery(automation, events)
    }, context.now)
    : undefined;
  const intake = bundle && steps.includes("intake")
    ? await routeContextBundleToIntake(context.database, bundle, automationIntakeModel, {
      now: context.now,
      policy: automationPolicy(automation),
      skillId: stepSkillID(automation, "intake")
    })
    : undefined;
  const proposed = steps.includes("domain_skill")
    ? routeDomainItems(context.database, automation, intake?.result?.created_items ?? [])
    : 0;
  return {
    detail: detailText({ bundle: bundle?.id, events: events.length, intake: intake?.result?.created_items.length ?? 0, proposed }),
    lastSuccessfulCursor: runCursor(events),
    processedWatermark: runWatermark(events)
  };
}

function routeDomainItems(db: RunnerDatabase, automation: PiAutomationRecord, items: AttentionInboxItemRecord[]): number {
  let proposed = 0;
  for (const item of items.slice(0, automation.max_actions_per_run)) {
    const result = routeInboxItemToDomainSkill(db, item, {
      policy: automationPolicy(automation),
      skillID: stepSkillID(automation, "domain_skill")
    });
    if (result.status === "routed") proposed += 1;
  }
  return proposed;
}

function automationIntakeModel(request: LlmIntakeRequest): LlmIntakeOutput {
  const text = request.bundle.context.map((item) => item.summary).join("\n");
  if (text.trim() === "") return { ignored_groups: [ignoredGroup(request, "empty_context")], inbox_items: [] };
  return {
    ignored_groups: [],
    inbox_items: [{
      actor_refs: [],
      confidence: bugLike(text) ? 0.84 : 0.72,
      evidence_refs: request.bundle.evidence_refs.slice(0, 6),
      intents: {
        primary: bugLike(text) ? "bug_report" : "follow_up",
        secondary: bugLike(text) ? ["create_task"] : ["monitor_thread"],
        tags: ["automation"]
      },
      suggested_actions: bugLike(text) ? ["create_issue"] : ["review"],
      summary: text,
      target_hints: [],
      title: bugLike(text) ? "Automation detected possible bug" : "Automation detected follow-up",
      urgency: bugLike(text) ? "medium" : "low"
    }]
  };
}

function automationPolicy(automation: PiAutomationRecord): EventRouterSourcePolicy {
  return {
    ...automation.source_policy,
    action_mode: actionMode(automation.mode),
    issue_policy: {
      require_project_confirmation: false,
      ...objectValue(automation.source_policy.issue_policy)
    },
    intake_mode: intakeMode(automation),
    profile: "custom"
  };
}

function sourceEvents(db: RunnerDatabase, source: string, automation: PiAutomationRecord): ExternalEventRecord[] {
  const rows = listExternalEvents(db, { limit: maxEvents(automation), source });
  const watermark = Date.parse(automation.processed_watermark);
  const filtered = Number.isFinite(watermark)
    ? rows.filter((event) => eventTime(event) > watermark)
    : rows;
  return filtered.sort((left, right) => eventTime(left) - eventTime(right) || left.id - right.id);
}

function sourceQuery(automation: PiAutomationRecord, events: ExternalEventRecord[]): JsonObject {
  return cleanObject({
    automation_id: automation.id,
    cursor: automation.last_successful_cursor,
    event_count: events.length,
    mode: automation.mode,
    processed_watermark: runWatermark(events)
  });
}

function emptyRun(automation: PiAutomationRecord): PiAutomationPipelineResult {
  return {
    detail: `automation ${automation.id} found no new source events`,
    lastSuccessfulCursor: automation.last_successful_cursor,
    processedWatermark: automation.processed_watermark
  };
}

function detailText(input: { bundle?: number; events: number; intake: number; proposed: number }): string {
  const bundle = input.bundle ? `context_bundle=${input.bundle}` : "context_bundle=skipped";
  return `automation run succeeded: events=${input.events}, ${bundle}, intake_items=${input.intake}, proposals=${input.proposed}`;
}

function automationSource(automation: PiAutomationRecord): string {
  return firstText(...automation.filters.map((item) => item.source), automation.trigger.source, automation.source_policy.source);
}

function stepSkillID(automation: PiAutomationRecord, type: AutomationStepType): string {
  return firstText(...automation.steps.filter((step) => step.type === type).map((step) => step.skill_id));
}

function stepTypes(automation: PiAutomationRecord): AutomationStepType[] {
  return automation.steps.map((step) => step.type);
}

function needsBundle(steps: AutomationStepType[]): boolean {
  return steps.some((step) => step === "context_bundle" || step === "intake" || step === "domain_skill");
}

function intakeMode(automation: PiAutomationRecord): EventRouterSourcePolicy["intake_mode"] {
  const configured = clean(automation.source_policy.intake_mode);
  if (configured !== "") return configured as EventRouterSourcePolicy["intake_mode"];
  return automation.trigger_type === "schedule" ? "scheduled_llm_triage" : "continuous_llm_triage";
}

function actionMode(mode: AutomationMode): EventRouterSourcePolicy["action_mode"] {
  if (mode === "dry_run") return "observe_only";
  if (mode === "draft") return "draft_only";
  if (mode === "auto") return "auto_low_risk";
  return "propose_actions";
}

function ignoredGroup(request: LlmIntakeRequest, reason: string): LlmIntakeOutput["ignored_groups"][number] {
  return { confidence: 0.99, evidence_refs: request.bundle.evidence_refs.slice(0, 1), reason };
}

function runCursor(events: ExternalEventRecord[]): string {
  const last = events.at(-1);
  return last ? `${last.source}:${last.external_id || last.id}` : "";
}

function runWatermark(events: ExternalEventRecord[]): string {
  const last = events.at(-1);
  return last ? new Date(eventTime(last)).toISOString() : "";
}

function eventTime(event: ExternalEventRecord): number {
  const value = Date.parse(event.received_at || event.occurred_at);
  return Number.isFinite(value) ? value : 0;
}

function maxEvents(automation: PiAutomationRecord): number {
  return Math.max(1, Math.min(automation.max_actions_per_run * 10, 100));
}

function tokenBudget(automation: PiAutomationRecord): number {
  return positive(automation.trigger.token_budget, 2000);
}

function windowMinutes(automation: PiAutomationRecord): number {
  return positive(automation.trigger.window_minutes, 30);
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function bugLike(text: string): boolean {
  return /bug|error|fail|500|报错|故障|失败|issue/i.test(text);
}

function cleanObject(value: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => !emptyValue(child)));
}

function emptyValue(value: unknown): boolean {
  return value === "" || value === undefined || value === null;
}

function firstText(...values: unknown[]): string {
  return values.map(clean).find(Boolean) ?? "";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
