import type { AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";

type JsonObject = Record<string, unknown>;
type ActionRisk = "low" | "medium" | "high";

export type DomainSkillActionType =
  | "ask_user"
  | "issue.create"
  | "issue.status_lookup"
  | "memory.create"
  | "message.reply_draft"
  | "no_action"
  | "reminder.create"
  | "watch_thread";

export type DomainSkillActionProposal = {
  evidence_refs: string[];
  id: string;
  payload: JsonObject;
  rationale: string;
  requires_approval: boolean;
  risk: ActionRisk;
  summary: string;
  type: DomainSkillActionType;
};

export type DomainSkillOutput = {
  action_proposals: DomainSkillActionProposal[];
  item_id: number;
  primary_intent: string;
  skill_id: "fixture-domain";
  summary: string;
};

const STATUS_DRAFT = "我先查一下相关 issue 状态，并以当前记录为准同步进展。";
const REPLY_DRAFT = "已收到，我会基于当前上下文整理一个回复草稿，确认后再发送。";

export function runFixtureDomainSkill(item: AttentionInboxItemRecord): DomainSkillOutput {
  const actionInputs = actionInputsForItem(item);
  return {
    action_proposals: actionInputs.map((input, index) => proposal(item, input, index)),
    item_id: item.id,
    primary_intent: item.primary_intent,
    skill_id: "fixture-domain",
    summary: item.summary
  };
}

function actionInputsForItem(item: AttentionInboxItemRecord): Omit<DomainSkillActionProposal, "id">[] {
  if (item.primary_intent === "status_question") return [statusLookup(item), replyDraft(item, STATUS_DRAFT)];
  if (item.primary_intent === "bug_report") return [issueCreate(item)];
  if (item.primary_intent === "reply_needed") return [replyDraft(item, REPLY_DRAFT)];
  if (shouldWatch(item)) return [watchThread(item)];
  if (hasSuggestedAction(item, "no_action")) return [noAction(item)];
  if (hasSuggestedAction(item, "reminder.create")) return [reminderCreate(item)];
  if (hasSuggestedAction(item, "memory.create")) return [memoryCreate(item)];
  return [askUser(item)];
}

function issueCreate(item: AttentionInboxItemRecord): Omit<DomainSkillActionProposal, "id"> {
  return action("issue.create", item, {
    body: issueBody(item),
    evidence_refs: item.evidence_refs,
    source: item.source,
    status: "triage",
    title: item.title
  }, "medium", true, "Create a triage issue proposal from a bug report inbox item.");
}

function statusLookup(item: AttentionInboxItemRecord): Omit<DomainSkillActionProposal, "id"> {
  return action("issue.status_lookup", item, {
    evidence_refs: item.evidence_refs,
    query: item.title,
    target_hints: item.target_hints
  }, "low", false, "Look up related issue status before drafting a reply.");
}

function replyDraft(item: AttentionInboxItemRecord, draft: string): Omit<DomainSkillActionProposal, "id"> {
  return action("message.reply_draft", item, {
    draft,
    evidence_refs: item.evidence_refs,
    source: item.source
  }, "low", false, "Prepare a reply draft only; do not send externally.");
}

function watchThread(item: AttentionInboxItemRecord): Omit<DomainSkillActionProposal, "id"> {
  return action("watch_thread", item, {
    evidence_refs: item.evidence_refs,
    source: item.source,
    title: item.title
  }, "low", false, "Continue observing the thread without external writes.");
}

function reminderCreate(item: AttentionInboxItemRecord): Omit<DomainSkillActionProposal, "id"> {
  return action("reminder.create", item, {
    evidence_refs: item.evidence_refs,
    summary: item.summary,
    title: item.title
  }, "low", false, "Create a reminder proposal without executing external writes.");
}

function memoryCreate(item: AttentionInboxItemRecord): Omit<DomainSkillActionProposal, "id"> {
  return action("memory.create", item, {
    evidence_refs: item.evidence_refs,
    summary: item.summary,
    title: item.title
  }, "low", false, "Capture a memory proposal for later review.");
}

function askUser(item: AttentionInboxItemRecord): Omit<DomainSkillActionProposal, "id"> {
  return action("ask_user", item, {
    question: `请确认这个事项应该如何处理：${item.title}`,
    target_hints: item.target_hints
  }, "low", false, "Ask the user because the inbox item intent is ambiguous.");
}

function noAction(item: AttentionInboxItemRecord): Omit<DomainSkillActionProposal, "id"> {
  return action("no_action", item, {
    reason: "noise_or_no_attention_item",
    title: item.title
  }, "low", false, "No action is needed for this inbox item.");
}

function action(
  type: DomainSkillActionType,
  item: AttentionInboxItemRecord,
  payload: JsonObject,
  risk: ActionRisk,
  requiresApproval: boolean,
  rationale: string
): Omit<DomainSkillActionProposal, "id"> {
  return { evidence_refs: item.evidence_refs, payload, rationale, requires_approval: requiresApproval, risk, summary: item.summary, type };
}

function proposal(
  item: AttentionInboxItemRecord,
  input: Omit<DomainSkillActionProposal, "id">,
  index: number
): DomainSkillActionProposal {
  return { id: `inbox-item-${item.id}-${index + 1}-${input.type.replace(/[^a-z0-9]+/g, "-")}`, ...input };
}

function issueBody(item: AttentionInboxItemRecord): string {
  return [
    item.summary,
    "",
    "## Evidence",
    ...item.evidence_refs.map((ref) => `- ${ref}`)
  ].join("\n");
}

function hasSuggestedAction(item: AttentionInboxItemRecord, actionName: string): boolean {
  return item.suggested_actions.includes(actionName);
}

function shouldWatch(item: AttentionInboxItemRecord): boolean {
  return item.primary_intent === "monitor_thread" || item.primary_intent === "follow_up" ||
    hasSuggestedAction(item, "watch_thread") || hasSuggestedAction(item, "continue_observing");
}
