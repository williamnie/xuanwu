import type { RunnerDatabase } from "../../db/database.ts";
import { auditIssueSkillIntents } from "../../skills/intentAudit.ts";
import { getSkillMetadata, readSkillRegistry, recommendSkillIntents } from "../../skills/registry.ts";
import { libraryRegistryOptions } from "../../skills/libraryContext.ts";
import { withIssueBodyDependencies } from "../issues/issuePlanningBody.ts";
import { parseSkillIntentList } from "../../skills/intents.ts";
import { executeSafePiAction } from "../actions/actionEngine.ts";
import { observeSessionProgress } from "./sessionObserver.ts";
import { renderIssueCreateProposalDescription } from "./issueProposalContext.ts";
import { sessionExpectedState } from "../actions/actionFreshness.ts";
import { loadAssistantToolRegistrySnapshot } from "../tools/toolRegistrySnapshot.ts";
import { normalizeIssueBatchPayload } from "./issueBatchProposal.ts";
import { cleanString } from "../../util/values.ts";
import { IssueCreateProposalInput, PiRunnerActionContext, ProposalInput, IssueCreateBatchProposalInput, SessionSteerProposalInput, SkillReadInput, SkillRecommendInput, SkillIntentAuditInput } from "./runnerActionInputs.ts";
import { requiredCreateProjectID, readSessionSummary, cleanObjectPayload, mustGetIssue } from "./runnerActionValues.ts";

export function issueCreateProposal(
  input: IssueCreateProposalInput,
  context: PiRunnerActionContext
): ProposalInput {
  const projectID = requiredCreateProjectID(input.project_id);
  const description = renderIssueCreateProposalDescription(input, { project: context.project, projectID });
  return {
    actionType: "issue.create",
    payload: {
      project_id: projectID,
      title: input.title ?? "",
      description: input.depends_on_issue_ids === undefined ? description
        : withIssueBodyDependencies(description, input.depends_on_issue_ids),
      ...(input.depends_on_issue_ids === undefined
        ? {}
        : { depends_on_issue_ids: input.depends_on_issue_ids }),
      required_skill_intents: parseSkillIntentList(input.required_skill_intents),
      recommended_skill_intents: parseSkillIntentList(input.recommended_skill_intents),
      required_mcp_capabilities: input.required_mcp_capabilities ?? [],
      recommended_mcp_capabilities: input.recommended_mcp_capabilities ?? [],
      status: "triage"
    },
    projectID,
    rationale: input.rationale
  };
}

export function issueCreateBatchProposal(
  input: IssueCreateBatchProposalInput,
  context: PiRunnerActionContext
): ProposalInput {
  const projectID = requiredCreateProjectID(input.project_id);
  const payload = normalizeIssueBatchPayload({
    project_id: projectID,
    status: "triage",
    batch_items: input.items.map((item) => ({
      ref: item.ref,
      title: item.title ?? "",
      description: renderIssueCreateProposalDescription(item, { project: context.project, projectID }),
      depends_on_refs: item.depends_on_refs ?? [],
      required_skill_intents: parseSkillIntentList(item.required_skill_intents),
      recommended_skill_intents: parseSkillIntentList(item.recommended_skill_intents),
      required_mcp_capabilities: item.required_mcp_capabilities ?? [],
      recommended_mcp_capabilities: item.recommended_mcp_capabilities ?? []
    }))
  });
  return { actionType: "issue.create", payload, projectID, rationale: input.rationale };
}

export function sessionSteerProposal(db: RunnerDatabase, input: SessionSteerProposalInput): ProposalInput {
  const session = readSessionSummary(db, input.session_key);
  const progress = observeSessionProgress(db, session.session_key);
  return {
    actionType: "session.steer",
    payload: {
      expected_state: sessionExpectedState(session),
      prompt: input.prompt,
      progress_context: progress.summary,
      provider: session.provider,
      provider_session_id: session.provider_session_id,
      session_key: session.session_key
    },
    projectID: session.project_id,
    rationale: input.rationale
  };
}

export function safeListSkills(db: RunnerDatabase, context: PiRunnerActionContext) {
  return executeSafePiAction(db, context, {
    actionType: "skill.list",
    payload: {},
    execute: () => readSkillRegistry({ ...libraryRegistryOptions(db, context.project), availableTools: skillRegistryTools(db) })
  });
}

export function safeReadSkill(db: RunnerDatabase, context: PiRunnerActionContext, input: SkillReadInput) {
  return executeSafePiAction(db, context, {
    actionType: "skill.read",
    payload: { id: cleanString(input.id) },
    execute: () => getSkillMetadata(input.id, { ...libraryRegistryOptions(db, context.project), availableTools: skillRegistryTools(db) }) ?? { id: cleanString(input.id), missing: true }
  });
}

export function safeRecommendSkills(db: RunnerDatabase, context: PiRunnerActionContext, input: SkillRecommendInput) {
  const projectID = cleanString(input.project_id) || (context.project?.id ?? "");
  return executeSafePiAction(db, context, {
    actionType: "skill.recommend",
    payload: cleanObjectPayload({ project_id: projectID, title: input.title ?? "", description: input.description ?? "" }),
    projectID,
    execute: () => ({ items: recommendSkillIntents(input, libraryRegistryOptions(db, context.project)).map(compactSkillRecommendation) })
  });
}

export function compactSkillRecommendation(item: ReturnType<typeof recommendSkillIntents>[number]) {
  return {
    allowed_roles: item.allowed_roles,
    description: item.description,
    id: item.id,
    name: item.name,
    reason: item.reason,
    risk_level: item.risk_level,
    score: item.score,
    summary: item.summary,
    version: item.version
  };
}

export function skillRegistryTools(db: RunnerDatabase) {
  return loadAssistantToolRegistrySnapshot(db).tools.map((tool) => ({
    aliases: cleanString(tool.metadata?.capability_id) ? [cleanString(tool.metadata?.capability_id)] : [],
    name: tool.name,
    permission: tool.permission,
    provider_id: tool.provider_id
  }));
}

export function safeSkillIntentAudit(db: RunnerDatabase, context: PiRunnerActionContext, input: SkillIntentAuditInput) {
  const issue = mustGetIssue(db, input.issue_id);
  return executeSafePiAction(db, context, {
    actionType: "skill.intent_audit",
    issueID: issue.id,
    payload: cleanObjectPayload({ issue_id: issue.id, issue_run_id: input.issue_run_id ?? "", used_skill_intents: input.used_skill_intents ?? [] }),
    projectID: issue.project_id,
    execute: () => auditIssueSkillIntents(db, issue.id, { issueRunID: input.issue_run_id, usedSkillIntents: input.used_skill_intents })
  });
}
