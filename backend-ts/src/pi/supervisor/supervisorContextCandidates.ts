import type { RunnerDatabase } from "../../db/database.ts";
import { listPiActions } from "../../db/repositories/pi/actions.ts";
import { type Project } from "../../db/repositories/projects.ts";
import { getIssueAsWork } from "../../domain/work/issueAdapter.ts";
import type { WorkLedgerEntry } from "../../domain/work/contracts.ts";
import { cleanString } from "../../util/values.ts";
import { MutableCandidate, CandidateSource, Candidate, SupervisorContextResolution, DIRECT_SOURCE_KINDS } from "./supervisorContextSchema.ts";
import { referencedIssueIDs, normalizeForMatch, projectTokens, workIssueID } from "./supervisorContextReferences.ts";

export function addReferencedWorks(
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

export function addExplicitProjects(
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

export function addConversationHistory(
  db: RunnerDatabase,
  candidates: Map<string, MutableCandidate>,
  projects: Map<string, Project>,
  conversationID: string,
  inheritWork: boolean
): void {
  if (conversationID === "") return;
  const latest = listPiActions(db, { conversationId: conversationID })
    .slice().reverse().find((action) => projects.has(action.project_id));
  if (!latest) return;
  const work = inheritWork && latest.issue_id > 0 ? getIssueAsWork(db, latest.issue_id) : null;
  addProjectCandidate(candidates, projects, latest.project_id, {
    kind: "conversation_history",
    ref: `pi_actions:${latest.id}`,
    score: 55
  }, work ?? undefined);
}

export function addProjectCandidate(
  candidates: Map<string, MutableCandidate>,
  projects: Map<string, Project>,
  projectIDValue: unknown,
  source: CandidateSource,
  work?: WorkLedgerEntry
): void {
  const project = projects.get(cleanString(projectIDValue));
  if (project) addMutableCandidate(candidates, project, source, work);
}

export function addMutableCandidate(
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

export function rankCandidates(candidates: Map<string, MutableCandidate>): Candidate[] {
  return [...candidates.values()].map((candidate) => ({
    project_id: candidate.project.id,
    score: candidateScore(candidate.sources),
    sources: candidate.sources.slice().sort(compareSources),
    work_ids: [...candidate.works.keys()].sort()
  })).sort((left, right) => right.score - left.score || left.project_id.localeCompare(right.project_id));
}

export function resolutionDecision(candidates: Candidate[]): {
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

export function clarification(
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

export function emptyTarget(): SupervisorContextResolution["target"] {
  return { issue_ids: [], project_id: "", work_ids: [] };
}

export function candidateScore(sources: CandidateSource[]): number {
  const maximum = Math.max(...sources.map((source) => source.score), 0);
  return Math.min(100, maximum + Math.min(4, Math.max(0, sources.length - 1)));
}

export function compareSources(left: CandidateSource, right: CandidateSource): number {
  return right.score - left.score || left.kind.localeCompare(right.kind) || left.ref.localeCompare(right.ref);
}
