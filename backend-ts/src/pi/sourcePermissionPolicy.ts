type JsonObject = Record<string, unknown>;

export type AssistantSourceProfile =
  | "company_chat"
  | "personal_chat"
  | "ops_chat"
  | "private_dm"
  | "email"
  | "github"
  | "custom";
export type AssistantIntakeMode = "manual_only" | "mention_only" | "scheduled_llm_triage" | "continuous_llm_triage";
export type AssistantActionMode = "observe_only" | "draft_only" | "propose_actions" | "auto_low_risk";
export type AssistantActionRisk = "low" | "medium" | "high";

export type AssistantReplyPolicy = {
  allowed_chats?: string[];
  allowed_people?: string[];
  auto_reply_enabled?: boolean;
  require_approval_for_external_reply?: boolean;
};

export type AssistantIssuePolicy = {
  auto_create_triage_issue?: boolean;
  auto_enqueue?: boolean;
  require_project_confirmation?: boolean;
};

export type AssistantSourcePolicy = {
  action_mode?: AssistantActionMode;
  collect_raw_events?: boolean;
  intake_mode?: AssistantIntakeMode;
  issue_policy?: AssistantIssuePolicy | JsonObject;
  profile?: AssistantSourceProfile;
  reply_policy?: AssistantReplyPolicy;
};

export type SourcePermissionInput = {
  actionRisk: AssistantActionRisk;
  actionType: string;
  actor?: string;
  automation?: string;
  chat?: string;
  issuePolicy?: AssistantIssuePolicy | JsonObject;
  person?: string;
  payload?: JsonObject;
  projectConfirmed?: boolean;
  replyPolicy?: AssistantReplyPolicy | JsonObject;
  skill?: string;
  source?: string;
  sourcePolicy?: AssistantSourcePolicy | JsonObject;
  tool?: string;
};

export type SourcePermissionDecision = {
  audit: JsonObject;
  canAutoExecute: boolean;
  reason: string;
  requiresApproval: boolean;
};

export function decideSourcePermission(input: SourcePermissionInput): SourcePermissionDecision {
  const actionType = cleanString(input.actionType);
  if (actionType === "issue.create") return issueCreateDecision(input);
  if (actionType === "issue.enqueue" || actionType === "issue.schedule_enqueue") return issueEnqueueDecision(input);
  if (actionType !== "message.reply_send") return nonReplyDecision(input);
  const reply = resolvedReplyPolicy(input);
  const audit = auditInput(input, reply, undefined);
  if (input.actionRisk !== "low") return approval("external_reply_risk_requires_approval", audit);
  if (reply.auto_reply_enabled !== true) return approval("auto_reply_disabled", audit);
  if (reply.require_approval_for_external_reply === true) {
    return approval("external_reply_requires_approval", audit);
  }
  const target = targetDecision(input, reply);
  if (!target.allowed) return approval(target.reason, { ...audit, target_match: target.audit });
  return {
    audit: { ...audit, target_match: target.audit },
    canAutoExecute: true,
    reason: "low_risk_auto_reply_allowed",
    requiresApproval: false
  };
}

export function resolvedIssuePolicy(input: SourcePermissionInput): Required<AssistantIssuePolicy> {
  const sourcePolicy = objectValue(input.sourcePolicy);
  const sourceIssue = objectValue(sourcePolicy.issue_policy);
  const directIssue = objectValue(input.issuePolicy);
  const payloadIssue = objectValue(objectValue(input.payload).issue_policy);
  const merged = { ...sourceIssue, ...directIssue, ...payloadIssue };
  return {
    auto_create_triage_issue: merged.auto_create_triage_issue === true,
    auto_enqueue: merged.auto_enqueue === true,
    require_project_confirmation: merged.require_project_confirmation === true
  };
}

export function resolvedReplyPolicy(input: SourcePermissionInput): Required<AssistantReplyPolicy> {
  const sourcePolicy = objectValue(input.sourcePolicy);
  const sourceReply = objectValue(sourcePolicy.reply_policy);
  const directReply = objectValue(input.replyPolicy);
  const merged = { ...sourceReply, ...directReply };
  const autoReply = merged.auto_reply_enabled === true;
  return {
    allowed_chats: stringList(merged.allowed_chats),
    allowed_people: stringList(merged.allowed_people),
    auto_reply_enabled: autoReply,
    require_approval_for_external_reply: booleanValue(
      merged.require_approval_for_external_reply,
      !autoReply
    )
  };
}

function nonReplyDecision(input: SourcePermissionInput): SourcePermissionDecision {
  const requiresApproval = input.actionRisk !== "low";
  return {
    audit: auditInput(input, undefined, undefined),
    canAutoExecute: !requiresApproval,
    reason: requiresApproval ? "risk_requires_approval" : "low_risk_action_allowed",
    requiresApproval
  };
}

function issueCreateDecision(input: SourcePermissionInput): SourcePermissionDecision {
  const issue = resolvedIssuePolicy(input);
  const audit = auditInput(input, undefined, issue);
  if (input.actionRisk === "high") return approval("issue_create_risk_requires_approval", audit);
  if (issue.require_project_confirmation && !projectConfirmed(input)) return approval("project_confirmation_required", audit);
  if (issue.auto_create_triage_issue !== true) return approval("auto_create_triage_issue_disabled", audit);
  if (issueStatus(input) !== "triage") return approval("issue_create_status_requires_confirmation", audit);
  return { audit, canAutoExecute: true, reason: "triage_issue_auto_create_allowed", requiresApproval: false };
}

function issueEnqueueDecision(input: SourcePermissionInput): SourcePermissionDecision {
  const issue = resolvedIssuePolicy(input);
  const audit = auditInput(input, undefined, issue);
  if (input.actionRisk === "high") return approval("issue_enqueue_risk_requires_approval", audit);
  if (issue.auto_enqueue !== true) return approval("auto_enqueue_disabled", audit);
  if (positiveID(objectValue(input.payload).issue_id) <= 0) return approval("issue_enqueue_target_missing", audit);
  return { audit, canAutoExecute: true, reason: "issue_enqueue_allowed", requiresApproval: false };
}

function targetDecision(
  input: SourcePermissionInput,
  policy: Required<AssistantReplyPolicy>
): { allowed: boolean; audit: JsonObject; reason: string } {
  const chat = cleanString(input.chat);
  const person = cleanString(input.person) || cleanString(input.actor);
  const chatListConfigured = policy.allowed_chats.length > 0;
  const peopleListConfigured = policy.allowed_people.length > 0;
  if (!chatListConfigured && !peopleListConfigured) {
    return { allowed: false, audit: { chat, person }, reason: "auto_reply_target_not_allowlisted" };
  }
  const chatAllowed = !chatListConfigured || policy.allowed_chats.includes(chat);
  if (!chatAllowed) {
    return { allowed: false, audit: { allowed_chats: policy.allowed_chats, chat }, reason: "chat_not_allowed" };
  }
  const personAllowed = !peopleListConfigured || policy.allowed_people.includes(person);
  if (!personAllowed) {
    return { allowed: false, audit: { allowed_people: policy.allowed_people, person }, reason: "person_not_allowed" };
  }
  return {
    allowed: true,
    audit: { chat, chat_allowed: chatAllowed, person, person_allowed: personAllowed },
    reason: "target_allowed"
  };
}

function approval(reason: string, audit: JsonObject): SourcePermissionDecision {
  return { audit, canAutoExecute: false, reason, requiresApproval: true };
}

function auditInput(
  input: SourcePermissionInput,
  reply: Required<AssistantReplyPolicy> | undefined,
  issue: Required<AssistantIssuePolicy> | undefined
): JsonObject {
  return {
    action_risk: input.actionRisk,
    action_type: cleanString(input.actionType),
    actor: cleanString(input.actor),
    automation: cleanString(input.automation),
    issue_policy: issue,
    payload: auditPayload(input.payload),
    reply_policy: reply,
    skill: cleanString(input.skill),
    source: cleanString(input.source),
    tool: cleanString(input.tool)
  };
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function auditPayload(value: unknown): JsonObject {
  const payload = objectValue(value);
  return {
    issue_id: positiveID(payload.issue_id) || undefined,
    project_confirmed: payload.project_confirmed === true || undefined,
    project_id: cleanString(payload.project_id) || undefined,
    status: cleanString(payload.status) || undefined
  };
}

function issueStatus(input: SourcePermissionInput): string {
  return cleanString(objectValue(input.payload).status) || "triage";
}

function projectConfirmed(input: SourcePermissionInput): boolean {
  return input.projectConfirmed === true || objectValue(input.payload).project_confirmed === true;
}

function positiveID(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number.parseInt(cleanString(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(cleanString).filter(Boolean))];
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
