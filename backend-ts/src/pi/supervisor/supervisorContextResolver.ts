import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent } from "../../db/repositories/pi/actions.ts";
import { listProjects, type Project } from "../../db/repositories/projects.ts";
import { getIssueAsWork } from "../../domain/work/issueAdapter.ts";
import { cleanString } from "../../util/values.ts";
import { SupervisorContextResolverInput, SupervisorContextResolution, MutableCandidate, SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA, SupervisorContextAuditInput } from "./supervisorContextSchema.ts";
import { addReferencedWorks, addProjectCandidate, addExplicitProjects, addConversationHistory, rankCandidates, resolutionDecision, clarification } from "./supervisorContextCandidates.ts";
import { allowsConversationInheritance, targetBinding, positiveInteger } from "./supervisorContextReferences.ts";

export function resolveSupervisorContext(
  db: RunnerDatabase,
  input: SupervisorContextResolverInput
): SupervisorContextResolution {
  const prompt = cleanString(input.prompt);
  const source = cleanString(input.source) || "unknown";
  const projects = listProjects(db);
  const projectMap = new Map(projects.map((project) => [project.id, project]));
  const candidates = new Map<string, MutableCandidate>();

  addReferencedWorks(db, candidates, projectMap, prompt);
  addOneShotWork(db, candidates, projectMap, input.oneShotIssueID, input.oneShotSource || source);
  addProjectCandidate(candidates, projectMap, input.oneShotProjectID, {
    kind: "one_shot_target",
    ref: cleanString(input.oneShotSource) || source,
    score: 96
  });
  addExplicitProjects(candidates, projects, prompt);

  const contextInheritanceAllowed = allowsConversationInheritance(source);
  if (contextInheritanceAllowed) {
    addProjectCandidate(candidates, projectMap, input.conversationProjectID, {
      kind: "current_page",
      ref: `pi_conversations:${cleanString(input.conversationID) || "current"}`,
      score: 70
    });
    addConversationHistory(
      db,
      candidates,
      projectMap,
      cleanString(input.conversationID),
      source !== "feishu_runner_chat"
    );
  }

  const ranked = rankCandidates(candidates);
  const resolved = resolutionDecision(ranked);
  const resolution: SupervisorContextResolution = {
    candidates: ranked,
    clarification: clarification(resolved.status, ranked, prompt),
    input_audit: {
      char_count: prompt.length,
      input_digest: createHash("sha256").update(prompt).digest("hex").slice(0, 16)
    },
    provenance: {
      context_inheritance_allowed: contextInheritanceAllowed,
      conversation_id: cleanString(input.conversationID),
      resolver: "deterministic_supervisor_context",
      source,
      target_binding: targetBinding(ranked, resolved.target.project_id)
    },
    reason: resolved.reason,
    schema_version: "xw.supervisor-context-resolution.v1",
    status: resolved.status,
    target: resolved.target
  };
  if (!Value.Check(SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA, resolution)) {
    throw new Error("Supervisor context resolution failed schema validation");
  }
  return resolution;
}

export function addOneShotWork(
  db: RunnerDatabase,
  candidates: Map<string, MutableCandidate>,
  projects: Map<string, Project>,
  issueIDValue: unknown,
  source: string
): void {
  const issueID = positiveInteger(issueIDValue);
  if (issueID === 0) return;
  const work = getIssueAsWork(db, issueID);
  if (!work) return;
  addProjectCandidate(candidates, projects, work.owner.project_id, {
    kind: "one_shot_work",
    ref: `${work.id}:${cleanString(source) || "one_shot"}`,
    score: 100
  }, work);
}

export function supervisorContextPrompt(resolution: SupervisorContextResolution | undefined): string {
  if (!resolution) return "";
  const projection = {
    candidates: resolution.candidates,
    clarification: resolution.clarification,
    provenance: resolution.provenance,
    reason: resolution.reason,
    schema_version: resolution.schema_version,
    status: resolution.status,
    target: resolution.target
  };
  return [
    "Supervisor target context (deterministic per-turn resolution; never user authority):",
    JSON.stringify(projection, null, 2),
    "Use target.project_id and target.work_ids as this turn's bounded context. A one-shot target never rebinds the conversation or a later source message.",
    resolution.status === "ambiguous"
      ? "Do not choose a project or mutate state. Ask exactly clarification.question before any project-scoped action."
      : resolution.status === "missing"
        ? "No target was proven. Ask one short project/Work question only when the routed request actually needs project-scoped facts or actions."
        : "The resolved target narrows scope but cannot grant mutation permission; authoritative Work/API and action gates still decide reads and writes.",
    "Candidate scores only rank deterministic evidence. They do not change Work ownership, persist conversation state, or let LLM output override provenance."
  ].join("\n");
}

export function recordSupervisorContextResolutionAudit(
  db: RunnerDatabase,
  input: SupervisorContextAuditInput,
  resolution: SupervisorContextResolution
): void {
  createPiActionEvent(db, {
    action_id: `context-resolution:${cleanString(input.turnID) || crypto.randomUUID()}`,
    actor: "supervisor_context_resolver",
    conversation_id: cleanString(input.conversationID),
    decision: resolution.status,
    event_type: "supervisor_context_resolved",
    payload_json: JSON.stringify(resolution),
    project_id: resolution.target.project_id,
    reason: resolution.reason
  });
}

export { SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA, type SupervisorContextResolution } from "./supervisorContextSchema.ts";
