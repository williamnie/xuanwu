import type { RunnerDatabase } from "../db/database.ts";
import { getContextBundle } from "../db/repositories/contextBundles.ts";
import { updateAttentionInboxItemStatus, type AttentionInboxItemRecord } from "../db/repositories/intakeRuns.ts";
import {
  createActionProposal,
  createPiAction,
  type ActionProposalRecord,
  type PiAction
} from "../db/repositories/pi.ts";
import {
  DEFAULT_DOMAIN_SKILL_ID,
  type DomainSkillOutput
} from "../skills/builtinDomainProposal.ts";
import { readSkillRegistry, type SkillMetadata } from "../skills/registry.ts";
import { executeSkillRuntime, type ExecuteSkillRuntimeInput, type SkillRuntimeRun } from "../skills/runtime.ts";
import { retrievePiMemoryContext, type PiMemoryRetrievalResult } from "./memoryContext.ts";
import { loadAssistantToolRegistrySnapshot } from "./toolRegistrySnapshot.ts";

type JsonObject = Record<string, unknown>;

export type DomainSkillRunResult = {
  action: PiAction;
  output: DomainSkillOutput;
  proposal: ActionProposalRecord;
  runtime: SkillRuntimeRun;
};

export type DomainSkillRunOptions = {
  cliConnectorDirs?: string[];
  env?: Record<string, string | undefined>;
  skill?: SkillMetadata;
  toolSnapshot?: ExecuteSkillRuntimeInput["toolSnapshot"];
};

export async function createDomainSkillProposal(
  db: RunnerDatabase,
  item: AttentionInboxItemRecord,
  skillID = DEFAULT_DOMAIN_SKILL_ID,
  options: DomainSkillRunOptions = {}
): Promise<DomainSkillRunResult> {
  const skill = options.skill ?? requireDomainSkill(db, skillID, options);
  const contextRetrieval = domainContextRetrieval(db, item, skill.id);
  const execution = await executeSkillRuntime<DomainSkillOutput>({
    auditContext: {
      projectID: confidentProjectID(item),
      source: "attention_inbox.domain_skill"
    },
    cliConnectorDirs: options.cliConnectorDirs,
    db,
    env: options.env,
    evidenceRefs: item.evidence_refs,
    input: { context_retrieval: contextRetrieval, inbox_item: item as unknown as JsonObject },
    runID: domainSkillActionID(item.id, skill.id),
    skill,
    toolSnapshot: options.toolSnapshot
  });
  const output = execution.output;
  const action = createPiAction(db, domainSkillAction(item, output, skill.id, contextRetrieval, execution.run));
  const proposal = createActionProposal(db, actionProposal(item, output, action));
  return { action, output, proposal, runtime: execution.run };
}

export async function runDomainSkillAndMarkProposal(
  db: RunnerDatabase,
  item: AttentionInboxItemRecord,
  skillID = DEFAULT_DOMAIN_SKILL_ID,
  options: DomainSkillRunOptions = {}
): Promise<DomainSkillRunResult & { item: AttentionInboxItemRecord }> {
  const result = await createDomainSkillProposal(db, item, skillID, options);
  return { ...result, item: updateAttentionInboxItemStatus(db, item.id, "proposal_created") };
}

function domainSkillAction(
  item: AttentionInboxItemRecord,
  output: DomainSkillOutput,
  skillID: string,
  contextRetrieval: PiMemoryRetrievalResult,
  runtime: SkillRuntimeRun
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
      title: item.title,
      skill_runtime: runtime
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
  return `attention-inbox-item-${itemID}-${safeID(skillID)}-domain-skill`;
}

function requireDomainSkill(
  db: RunnerDatabase,
  skillID: string,
  options: DomainSkillRunOptions
): SkillMetadata {
  const snapshot = options.toolSnapshot ?? loadAssistantToolRegistrySnapshot(db, {
    cliConnectorDirs: options.cliConnectorDirs ?? [],
    env: options.env
  });
  const availableTools = snapshot.tools.map((tool) => ({
    aliases: [cleanString(tool.metadata?.capability_id)].filter(Boolean),
    name: tool.name,
    permission: tool.permission,
    provider_id: tool.provider_id
  }));
  const wanted = normalizeSkillID(skillID);
  const registry = readSkillRegistry({ availableTools });
  const skill = registry.items.find((item) => item.id === wanted || item.name === wanted);
  if (!skill) throw new Error(`domain skill not found: ${skillID}`);
  if (skill.kind !== "domain") throw new Error(`skill kind must be domain: ${skillID}`);
  const path = skill.runtime_manifest_path || skill.source_path;
  const diagnostics = registry.diagnostics.filter((item) => item.source_path === path);
  if (diagnostics.length > 0) throw new Error(`domain skill has diagnostics: ${diagnostics.map((item) => item.code).join(", ")}`);
  return skill;
}

function safeID(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "skill";
}

function normalizeSkillID(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function confidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
