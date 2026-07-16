import { createHash } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent, listPiActions } from "../db/repositories/pi/actions.ts";
import { listProjects, type Project } from "../db/repositories/projects.ts";
import { getIssueAsWork } from "../domain/work/issueAdapter.ts";
import type { WorkLedgerEntry } from "../domain/work/contracts.ts";

export const SUPERVISOR_CONTEXT_CANDIDATE_SOURCES = [
  "work_reference",
  "one_shot_target",
  "explicit_project",
  "current_page",
  "conversation_history"
] as const;

const DIRECT_SOURCE_KINDS = new Set<SupervisorContextCandidateSourceKind>([
  "work_reference",
  "one_shot_target",
  "explicit_project"
]);
const objectOptions = { additionalProperties: false } as const;
const sourceKindSchema = Type.Union(
  SUPERVISOR_CONTEXT_CANDIDATE_SOURCES.map((kind) => Type.Literal(kind))
);

const candidateSourceSchema = Type.Object({
  kind: sourceKindSchema,
  ref: Type.String({ minLength: 1 }),
  score: Type.Integer({ maximum: 100, minimum: 0 })
}, objectOptions);

const candidateSchema = Type.Object({
  project_id: Type.String({ minLength: 1 }),
  score: Type.Integer({ maximum: 100, minimum: 0 }),
  sources: Type.Array(candidateSourceSchema, { minItems: 1 }),
  work_ids: Type.Array(Type.String({ minLength: 1 }))
}, objectOptions);

export const SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA = Type.Object({
  candidates: Type.Array(candidateSchema),
  clarification: Type.Object({
    question: Type.Optional(Type.String({ minLength: 1 })),
    reason: Type.String({ minLength: 1 }),
    required: Type.Boolean()
  }, objectOptions),
  input_audit: Type.Object({
    char_count: Type.Integer({ minimum: 0 }),
    input_digest: Type.String({ minLength: 16, maxLength: 16 })
  }, objectOptions),
  provenance: Type.Object({
    context_inheritance_allowed: Type.Boolean(),
    conversation_id: Type.String(),
    resolver: Type.Literal("deterministic_supervisor_context"),
    source: Type.String({ minLength: 1 })
  }, objectOptions),
  reason: Type.String({ minLength: 1 }),
  schema_version: Type.Literal("xw.supervisor-context-resolution.v1"),
  status: Type.Union([
    Type.Literal("resolved"),
    Type.Literal("ambiguous"),
    Type.Literal("missing")
  ]),
  target: Type.Object({
    issue_ids: Type.Array(Type.Integer({ minimum: 1 })),
    project_id: Type.String(),
    work_ids: Type.Array(Type.String({ minLength: 1 }))
  }, objectOptions)
}, objectOptions);

export type SupervisorContextResolution = Static<typeof SUPERVISOR_CONTEXT_RESOLUTION_SCHEMA>;
export type SupervisorContextCandidateSourceKind =
  (typeof SUPERVISOR_CONTEXT_CANDIDATE_SOURCES)[number];
export type SupervisorContextResolverInput = {
  conversationID?: string;
  conversationProjectID?: string;
  oneShotProjectID?: string;
  oneShotSource?: string;
  prompt: string;
  source?: string;
};
export type SupervisorContextAuditInput = {
  conversationID: string;
  turnID: string;
};

type CandidateSource = Static<typeof candidateSourceSchema>;
type MutableCandidate = {
  project: Project;
  sources: CandidateSource[];
  works: Map<string, WorkLedgerEntry>;
};
type Candidate = Static<typeof candidateSchema>;

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
    addConversationHistory(db, candidates, projectMap, cleanString(input.conversationID));
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
      source
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

function addReferencedWorks(
  db: RunnerDatabase,
  candidates: Map<string, MutableCandidate>,
  projects: Map<string, Project>,
  prompt: string
): void {
  for (const issueID of referencedIssueIDs(prompt)) {
    const work = getIssueAsWork(db, issueID);
    if (!work) continue;
    addProjectCandidate(candidates, projects, work.owner.project_id, {
      kind: "work_reference",
      ref: work.id,
      score: 100
    }, work);
  }
}

function addExplicitProjects(
  candidates: Map<string, MutableCandidate>,
  projects: Project[],
  prompt: string
): void {
  const text = normalizeForMatch(prompt);
  const matches = projects.flatMap((project) => projectTokens(project)
    .filter((token) => token !== "" && text.includes(token))
    .map((token) => ({ project, token })));
  const bestLength = Math.max(...matches.map((match) => match.token.length), 0);
  for (const match of matches.filter((item) => item.token.length === bestLength)) {
    addMutableCandidate(candidates, match.project, {
      kind: "explicit_project",
      ref: `projects:${match.project.id}`,
      score: Math.min(95, 90 + Math.floor(match.token.length / 8))
    });
  }
}

function addConversationHistory(
  db: RunnerDatabase,
  candidates: Map<string, MutableCandidate>,
  projects: Map<string, Project>,
  conversationID: string
): void {
  if (conversationID === "") return;
  const latest = listPiActions(db, { conversationId: conversationID })
    .slice().reverse().find((action) => projects.has(action.project_id));
  if (!latest) return;
  const work = latest.issue_id > 0 ? getIssueAsWork(db, latest.issue_id) : null;
  addProjectCandidate(candidates, projects, latest.project_id, {
    kind: "conversation_history",
    ref: `pi_actions:${latest.id}`,
    score: 55
  }, work ?? undefined);
}

function addProjectCandidate(
  candidates: Map<string, MutableCandidate>,
  projects: Map<string, Project>,
  projectIDValue: unknown,
  source: CandidateSource,
  work?: WorkLedgerEntry
): void {
  const project = projects.get(cleanString(projectIDValue));
  if (project) addMutableCandidate(candidates, project, source, work);
}

function addMutableCandidate(
  candidates: Map<string, MutableCandidate>,
  project: Project,
  source: CandidateSource,
  work?: WorkLedgerEntry
): void {
  const current: MutableCandidate = candidates.get(project.id) ?? {
    project,
    sources: [],
    works: new Map()
  };
  if (!current.sources.some((item) => item.kind === source.kind && item.ref === source.ref)) {
    current.sources.push(source);
  }
  if (work) current.works.set(work.id, work);
  candidates.set(project.id, current);
}

function rankCandidates(candidates: Map<string, MutableCandidate>): Candidate[] {
  return [...candidates.values()].map((candidate) => ({
    project_id: candidate.project.id,
    score: candidateScore(candidate.sources),
    sources: candidate.sources.slice().sort(compareSources),
    work_ids: [...candidate.works.keys()].sort()
  })).sort((left, right) => right.score - left.score || left.project_id.localeCompare(right.project_id));
}

function resolutionDecision(candidates: Candidate[]): {
  reason: string;
  status: SupervisorContextResolution["status"];
  target: SupervisorContextResolution["target"];
} {
  if (candidates.length === 0) return {
    reason: "no deterministic project or Work context",
    status: "missing",
    target: emptyTarget()
  };
  const direct = candidates.filter((candidate) => candidate.sources.some((source) => DIRECT_SOURCE_KINDS.has(source.kind)));
  if (direct.length > 1) return {
    reason: "conflicting direct project or Work context",
    status: "ambiguous",
    target: emptyTarget()
  };
  const top = direct[0] ?? candidates[0];
  if (!direct[0] && candidates[1]?.score === top.score) return {
    reason: "multiple project candidates have the same score",
    status: "ambiguous",
    target: emptyTarget()
  };
  return {
    reason: direct[0] ? "single consistent direct target" : "highest deterministic context score",
    status: "resolved",
    target: {
      issue_ids: top.work_ids.map(workIssueID).filter((id): id is number => id !== undefined),
      project_id: top.project_id,
      work_ids: top.work_ids
    }
  };
}

function clarification(
  status: SupervisorContextResolution["status"],
  candidates: Candidate[],
  prompt: string
): SupervisorContextResolution["clarification"] {
  if (status !== "ambiguous") return {
    reason: status === "resolved" ? "target is deterministic" : "target is not required for every intent",
    required: false
  };
  const ids = candidates.map((candidate) => candidate.project_id).slice(0, 4).join(", ");
  return {
    question: /[\u3400-\u9fff]/.test(prompt)
      ? `我找到了多个可能的项目（${ids}）。这次要处理哪个项目？`
      : `I found multiple possible projects (${ids}). Which project should this turn target?`,
    reason: "direct or equally scored context is ambiguous",
    required: true
  };
}

function emptyTarget(): SupervisorContextResolution["target"] {
  return { issue_ids: [], project_id: "", work_ids: [] };
}

function candidateScore(sources: CandidateSource[]): number {
  const maximum = Math.max(...sources.map((source) => source.score), 0);
  return Math.min(100, maximum + Math.min(4, Math.max(0, sources.length - 1)));
}

function compareSources(left: CandidateSource, right: CandidateSource): number {
  return right.score - left.score || left.kind.localeCompare(right.kind) || left.ref.localeCompare(right.ref);
}

function referencedIssueIDs(prompt: string): number[] {
  const ids: number[] = [];
  for (const pattern of [
    /xw:work:issues:([1-9]\d*)/gi,
    /#\s*([1-9]\d*)/g,
    /\b(?:work|issue)\s*(?:#|id\s*[:=]?)?\s*([1-9]\d*)\b/gi
  ]) {
    for (const match of prompt.matchAll(pattern)) {
      const id = Number.parseInt(match[1] ?? "", 10);
      if (Number.isSafeInteger(id) && id > 0) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

function workIssueID(workID: string): number | undefined {
  const match = /^xw:work:issues:([1-9]\d*)$/.exec(workID);
  if (!match) return undefined;
  const id = Number.parseInt(match[1] ?? "", 10);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function projectTokens(project: Project): string[] {
  return [...new Set([project.id, project.name].map(normalizeForMatch).filter(Boolean))];
}

function normalizeForMatch(value: unknown): string {
  return cleanString(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function allowsConversationInheritance(source: string): boolean {
  return source === "runner_chat" || source === "runner_review";
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
