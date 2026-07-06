import type { RunnerDatabase } from "../db/database.ts";
import { getContextBundle } from "../db/repositories/contextBundles.ts";
import { updateAttentionInboxItemStatus, type AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";
import {
  createActionProposal,
  createPiAction,
  createPiActionEvent,
  type ActionProposalRecord,
  type PiAction
} from "../db/repositories/pi.ts";
import { runFixtureDomainSkill, type DomainSkillOutput } from "./domainSkillFixture.ts";
import { retrievePiMemoryContext, type PiMemoryRetrievalResult } from "./memoryContext.ts";

type JsonObject = Record<string, unknown>;

export type DomainSkillRunResult = {
  action: PiAction;
  output: DomainSkillOutput;
  proposal: ActionProposalRecord;
};

export function createDomainSkillProposal(
  db: RunnerDatabase,
  item: AttentionInboxItemRecord,
  skillID = "fixture-domain"
): DomainSkillRunResult {
  const contextRetrieval = domainContextRetrieval(db, item, skillID);
  const output = runFixtureDomainSkill(item, skillID);
  const action = createPiAction(db, domainSkillAction(item, output, skillID, contextRetrieval));
  const proposal = createActionProposal(db, actionProposal(item, output, action));
  createPiActionEvent(db, {
    action_id: action.id,
    event_type: "attention_inbox.domain_skill_requested",
    payload_json: JSON.stringify({
      action_count: output.action_proposals.length,
      item_id: item.id,
      primary_intent: item.primary_intent,
      skill_id: skillID
    })
  });
  return { action, output, proposal };
}

export function runDomainSkillAndMarkProposal(
  db: RunnerDatabase,
  item: AttentionInboxItemRecord,
  skillID = "fixture-domain"
): DomainSkillRunResult & { item: AttentionInboxItemRecord } {
  const result = createDomainSkillProposal(db, item, skillID);
  return { ...result, item: updateAttentionInboxItemStatus(db, item.id, "proposal_created") };
}

function domainSkillAction(
  item: AttentionInboxItemRecord,
  output: DomainSkillOutput,
  skillID: string,
  contextRetrieval: PiMemoryRetrievalResult
): JsonObject {
  return {
    action_type: "attention_inbox.domain_skill",
    id: domainSkillActionID(item.id, skillID),
    idempotency_key: `attention-inbox-item:${item.id}:domain-skill:${skillID}`,
    payload_json: JSON.stringify({
      ...output,
      context_retrieval: contextRetrieval,
      evidence_refs: item.evidence_refs,
      item_id: item.id,
      primary_intent: item.primary_intent,
      suggested_actions: item.suggested_actions,
      title: item.title
    }),
    rationale: `Manual domain skill request for attention inbox item #${item.id}`,
    requires_confirmation: 1,
    risk_level: "low",
    source: "attention_inbox",
    status: "proposal"
  };
}

function domainContextRetrieval(
  db: RunnerDatabase,
  item: AttentionInboxItemRecord,
  skillID: string
): PiMemoryRetrievalResult {
  const bundle = getContextBundle(db, item.bundle_id);
  return retrievePiMemoryContext(db, {
    inboxItemID: item.id,
    limit: 8,
    projectID: confidentProjectID(item),
    skillID,
    sourceID: item.source || bundle?.source,
    tokenBudget: 700
  });
}

function confidentProjectID(item: AttentionInboxItemRecord): string {
  const hints = item.target_hints
    .filter((hint) => hint.kind === "project" && cleanString(hint.id) !== "");
  if (hints.length !== 1 || confidence(hints[0].confidence) < 0.8) return "";
  return cleanString(hints[0].id);
}

function actionProposal(
  item: AttentionInboxItemRecord,
  output: DomainSkillOutput,
  action: PiAction
) {
  return {
    actions: output.action_proposals,
    confidence: item.confidence,
    evidence_refs: item.evidence_refs,
    id: `${action.id}-proposal`,
    skill_run_id: action.id,
    source_item_ids: [`attention_inbox_item:${item.id}`],
    summary: output.summary,
    target_hints: item.target_hints
  };
}

export function domainSkillActionID(itemID: number, skillID: string): string {
  const suffix = skillID === "fixture-domain" ? "" : `-${safeID(skillID)}`;
  return `attention-inbox-item-${itemID}${suffix}-domain-skill`;
}

function safeID(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function confidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
