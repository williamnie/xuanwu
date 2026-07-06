import type { RunnerDatabase } from "../db/database.ts";
import { updateAttentionInboxItemStatus, type AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";
import { createPiAction, createPiActionEvent, type PiAction } from "../db/repositories/pi.ts";
import { runFixtureDomainSkill, type DomainSkillOutput } from "./domainSkillFixture.ts";

type JsonObject = Record<string, unknown>;

export type DomainSkillRunResult = {
  action: PiAction;
  output: DomainSkillOutput;
};

export function createDomainSkillProposal(
  db: RunnerDatabase,
  item: AttentionInboxItemRecord,
  skillID = "fixture-domain"
): DomainSkillRunResult {
  const output = runFixtureDomainSkill(item, skillID);
  const action = createPiAction(db, domainSkillAction(item, output, skillID));
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
  return { action, output };
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
  skillID: string
): JsonObject {
  return {
    action_type: "attention_inbox.domain_skill",
    id: actionID(item.id, skillID),
    idempotency_key: `attention-inbox-item:${item.id}:domain-skill:${skillID}`,
    payload_json: JSON.stringify({
      ...output,
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

function actionID(itemID: number, skillID: string): string {
  const suffix = skillID === "fixture-domain" ? "" : `-${safeID(skillID)}`;
  return `attention-inbox-item-${itemID}${suffix}-domain-skill`;
}

function safeID(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}
