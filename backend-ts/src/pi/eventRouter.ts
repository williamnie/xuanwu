import type { RunnerDatabase } from "../db/database.ts";
import {
  createContextBundle,
  listContextBundles,
  type ContextBundleRecord,
  type ContextBundleTrigger
} from "../db/repositories/contextBundles.ts";
import type { ExternalEventRecord } from "../db/repositories/externalEvents.ts";
import { listIntakeRuns, type AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";
import { getPiAction } from "../db/repositories/pi.ts";
import { buildContextBundleFromEvents } from "./contextBundleBuilder.ts";
import { domainSkillActionID, runDomainSkillAndMarkProposal } from "./domainSkillRun.ts";
import { DEFAULT_INTAKE_SKILL_ID, runIntakeSkill, type LlmIntakeModel, type LlmIntakeOptions, type LlmIntakeResult } from "./llmIntake.ts";
import { sourcePolicyBlockReason, type IntakeMode, type IntakeSourcePolicy } from "./intakeSourcePolicy.ts";

type JsonObject = Record<string, unknown>;

export type SourceProfile = "company_chat" | "personal_chat" | "ops_chat" | "private_dm" | "email" | "github" | "custom";
export type ActionMode = "observe_only" | "draft_only" | "propose_actions" | "auto_low_risk";
export type InboxRouteDecision = "no_action" | "draft" | "proposal" | "ask_user" | "auto_low_risk";
export type EventRouteStatus = "routed" | "skipped";

export type EventRouterSourcePolicy = IntakeSourcePolicy & {
  action_mode?: ActionMode;
  issue_policy?: JsonObject;
  profile?: SourceProfile;
  reply_policy?: JsonObject;
};

export type ProjectRouteState = {
  project_confirmed?: boolean;
  project_id?: string;
  require_project_confirmation?: boolean;
};

export type IntakeRouteResult = {
  bundle?: ContextBundleRecord;
  reason: string;
  result?: LlmIntakeResult;
  route: "raw_event" | "context_bundle";
  status: EventRouteStatus;
};

export type DomainRouteResult = {
  action_id?: string;
  decision: InboxRouteDecision;
  reason: string;
  route: "inbox_item";
  status: EventRouteStatus;
};

const PROFILE_DEFAULTS: Record<SourceProfile, EventRouterSourcePolicy> = {
  company_chat: profilePolicy("company_chat", "mention_only", "draft_only", true, false),
  personal_chat: profilePolicy("personal_chat", "mention_only", "auto_low_risk", false, true),
  ops_chat: profilePolicy("ops_chat", "scheduled_llm_triage", "propose_actions", true, false),
  private_dm: profilePolicy("private_dm", "mention_only", "auto_low_risk", false, true),
  email: profilePolicy("email", "scheduled_llm_triage", "propose_actions", true, false),
  github: profilePolicy("github", "continuous_llm_triage", "propose_actions", false, false),
  custom: profilePolicy("custom", "manual_only", "observe_only", true, false)
};

export async function routeRawEventToIntake(
  db: RunnerDatabase,
  event: ExternalEventRecord,
  events: ExternalEventRecord[],
  model: LlmIntakeModel,
  options: LlmIntakeOptions & {
    maxEvents?: number;
    policy?: EventRouterSourcePolicy;
    retry?: boolean;
    tokenBudget?: number;
    trigger?: ContextBundleTrigger;
    windowMinutes?: number;
  } = {}
): Promise<IntakeRouteResult> {
  const policy = resolveSourcePolicy(options.policy);
  const trigger = options.trigger ?? rawEventTrigger(event);
  const skillID = intakeSkillID(options);
  if (!triggerAllowedByPolicy(policy, trigger)) return skipped("raw_event", `trigger_${trigger}_not_allowed`);
  if (!options.retry && rawEventAlreadyRouted(db, event, skillID)) return skipped("raw_event", "duplicate_raw_event");
  const input = buildContextBundleFromEvents(events, {
    anchorEventId: event.id,
    createdBy: "automation",
    maxEvents: options.maxEvents,
    tokenBudget: eventTokenBudget(options),
    trigger,
    windowMinutes: options.windowMinutes
  });
  const bundle = createContextBundle(db, input, options.now);
  return routeContextBundleToIntake(db, bundle, model, { ...options, policy });
}

export async function routeContextBundleToIntake(
  db: RunnerDatabase,
  bundle: ContextBundleRecord,
  model: LlmIntakeModel,
  options: LlmIntakeOptions & { policy?: EventRouterSourcePolicy; retry?: boolean } = {}
): Promise<IntakeRouteResult> {
  const policy = resolveSourcePolicy(options.policy);
  const skillID = intakeSkillID(options);
  const block = sourcePolicyBlockReason(db, bundle, policy, options.now);
  if (block !== "") return skipped("context_bundle", block, bundle);
  if (!options.retry && intakeAlreadyRouted(db, bundle.id, skillID)) {
    return skipped("context_bundle", "duplicate_context_bundle", bundle);
  }
  const result = await runIntakeSkill(db, bundle, model, {
    ...options,
    skillId: skillID,
    sourcePolicy: policy
  });
  return { bundle, reason: "intake_skill_routed", result, route: "context_bundle", status: "routed" };
}

export function decideInboxRoute(
  item: AttentionInboxItemRecord,
  policyInput?: EventRouterSourcePolicy,
  project: ProjectRouteState = {}
): { decision: InboxRouteDecision; reason: string } {
  const policy = resolveSourcePolicy(policyInput);
  if (policy.action_mode === "observe_only") return { decision: "no_action", reason: "observe_only" };
  if (needsProjectConfirmation(item, policy, project)) return { decision: "ask_user", reason: "project_confirmation_required" };
  if (isNoActionItem(item)) return { decision: "no_action", reason: "item_suggests_no_action" };
  if (policy.action_mode === "draft_only") return { decision: "draft", reason: "draft_only" };
  if (policy.action_mode === "auto_low_risk" && itemRisk(item) === "low") {
    return { decision: "auto_low_risk", reason: "low_risk_auto_allowed" };
  }
  return { decision: "proposal", reason: "proposal_required" };
}

export function routeInboxItemToDomainSkill(
  db: RunnerDatabase,
  item: AttentionInboxItemRecord,
  options: { policy?: EventRouterSourcePolicy; project?: ProjectRouteState; retry?: boolean; skillID?: string } = {}
): DomainRouteResult {
  const skillID = clean(options.skillID) || "fixture-domain";
  const decision = decideInboxRoute(item, options.policy, options.project);
  if (decision.decision === "no_action" || decision.decision === "ask_user") {
    return domainSkipped(decision.decision, decision.reason);
  }
  if (!options.retry && inboxItemAlreadyRouted(db, item, skillID)) {
    return domainSkipped(decision.decision, "duplicate_inbox_item");
  }
  const run = runDomainSkillAndMarkProposal(db, item, skillID);
  return {
    action_id: run.action.id,
    decision: decision.decision,
    reason: decision.reason,
    route: "inbox_item",
    status: "routed"
  };
}

export function resolveSourcePolicy(input: EventRouterSourcePolicy = {}): EventRouterSourcePolicy {
  const profile = sourceProfile(input.profile);
  const base = PROFILE_DEFAULTS[profile];
  return {
    ...base,
    ...input,
    action_mode: actionMode(input.action_mode ?? base.action_mode),
    intake_mode: intakeMode(input.intake_mode ?? base.intake_mode),
    issue_policy: { ...base.issue_policy, ...objectValue(input.issue_policy) },
    profile,
    reply_policy: { ...base.reply_policy, ...objectValue(input.reply_policy) }
  };
}

function rawEventAlreadyRouted(db: RunnerDatabase, event: ExternalEventRecord, skillID: string): boolean {
  return listContextBundles(db, event.source, 500)
    .some((bundle) => bundle.event_refs.includes(event.id) && intakeAlreadyRouted(db, bundle.id, skillID));
}

function inboxItemAlreadyRouted(db: RunnerDatabase, item: AttentionInboxItemRecord, skillID: string): boolean {
  return item.status === "proposal_created" || getPiAction(db, domainSkillActionID(item.id, skillID)) !== null;
}

function intakeAlreadyRouted(db: RunnerDatabase, bundleID: number, skillID: string): boolean {
  return listIntakeRuns(db, { bundleId: bundleID, limit: 500 })
    .some((run) => run.skill_id === skillID && ["running", "succeeded"].includes(run.status));
}

function triggerAllowedByPolicy(policy: EventRouterSourcePolicy, trigger: ContextBundleTrigger): boolean {
  if (trigger === "manual" || trigger === "retry") return true;
  if (policy.automatic_intake_enabled === false) return false;
  if (policy.intake_mode === "manual_only") return false;
  if (policy.intake_mode === "mention_only") return trigger === "mention" || trigger === "reply";
  if (policy.intake_mode === "scheduled_llm_triage") return ["mention", "reply", "schedule"].includes(trigger);
  return ["mention", "reply", "schedule", "continuous", "webhook"].includes(trigger);
}

function needsProjectConfirmation(
  item: AttentionInboxItemRecord,
  policy: EventRouterSourcePolicy,
  project: ProjectRouteState
): boolean {
  const required = project.require_project_confirmation ?? policy.issue_policy?.require_project_confirmation;
  return required === true && project.project_confirmed !== true && projectID(project, item) === "" && projectIntent(item);
}

function projectIntent(item: AttentionInboxItemRecord): boolean {
  return ["bug_report", "create_task", "status_question"].includes(item.primary_intent);
}

function projectID(project: ProjectRouteState, item: AttentionInboxItemRecord): string {
  return clean(project.project_id) || clean(item.target_hints.find((hint) => hint.kind === "project")?.id);
}

function isNoActionItem(item: AttentionInboxItemRecord): boolean {
  return item.primary_intent === "other" && item.suggested_actions.includes("no_action");
}

function itemRisk(item: AttentionInboxItemRecord): "low" | "medium" | "high" {
  if (item.urgency === "high") return "high";
  if (item.urgency === "medium" || item.primary_intent === "bug_report") return "medium";
  return "low";
}

function rawEventTrigger(event: ExternalEventRecord): ContextBundleTrigger {
  if (eventMentioned(event)) return "mention";
  if (eventReplyToBot(event)) return "reply";
  return "continuous";
}

function eventMentioned(event: ExternalEventRecord): boolean {
  if (/(^|@|\s)(pi|bot|机器人)(\b|\s|$)/i.test(event.content)) return true;
  const message = objectValue(event.normalized_message);
  return message.bot_mentioned === true || Array.isArray(message.mentions) &&
    message.mentions.some((item) => /pi|bot|机器人/i.test(JSON.stringify(item)));
}

function eventReplyToBot(event: ExternalEventRecord): boolean {
  const message = objectValue(event.normalized_message);
  return message.reply_to_bot === true || message.reply_to_pi === true || message.user_trigger === true;
}

function profilePolicy(
  profile: SourceProfile,
  intakeModeValue: IntakeMode,
  actionModeValue: ActionMode,
  requireProject: boolean,
  autoReply: boolean
): EventRouterSourcePolicy {
  return {
    action_mode: actionModeValue,
    intake_mode: intakeModeValue,
    issue_policy: { auto_create_triage_issue: false, auto_enqueue: false, require_project_confirmation: requireProject },
    profile,
    reply_policy: { auto_reply_enabled: autoReply, require_approval_for_external_reply: !autoReply }
  };
}

function skipped(route: IntakeRouteResult["route"], reason: string, bundle?: ContextBundleRecord): IntakeRouteResult {
  return { bundle, reason, route, status: "skipped" };
}

function domainSkipped(decision: InboxRouteDecision, reason: string): DomainRouteResult {
  return { decision, reason, route: "inbox_item", status: "skipped" };
}

function intakeSkillID(options: LlmIntakeOptions): string {
  return clean(options.skillId) || clean(options.skill?.id) || DEFAULT_INTAKE_SKILL_ID;
}

function eventTokenBudget(options: LlmIntakeOptions & { tokenBudget?: number }): number | undefined {
  return typeof options.tokenBudget === "number" ? options.tokenBudget : undefined;
}

function sourceProfile(value: unknown): SourceProfile {
  const text = clean(value);
  return text in PROFILE_DEFAULTS ? text as SourceProfile : "custom";
}

function actionMode(value: unknown): ActionMode {
  const text = clean(value);
  return ["observe_only", "draft_only", "propose_actions", "auto_low_risk"].includes(text) ? text as ActionMode : "observe_only";
}

function intakeMode(value: unknown): IntakeMode {
  const text = clean(value);
  return ["manual_only", "mention_only", "scheduled_llm_triage", "continuous_llm_triage"].includes(text) ? text as IntakeMode : "manual_only";
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
