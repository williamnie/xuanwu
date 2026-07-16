import type { RunnerDatabase } from "../db/database.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listProjects } from "../db/repositories/projects.ts";
import type { FeishuProjectMapping } from "./feishu.ts";

export type FeishuProjectContextStatus = "resolved" | "ambiguous" | "missing";
export type FeishuProjectContextSource =
  "issue_ref" | "explicit_project" | "user_switch" | "card_select" | "mapping_default" | "none";
export type FeishuProjectContextConfidence = "high" | "medium" | "low" | "none";
export type FeishuProjectContextIssue = { id: number; project_id: string };
export type FeishuProjectContextProject = { id: string; name?: string };
export type FeishuProjectContextActiveProject = {
  active_project_id?: string;
  active_project_source?: string;
};
export type FeishuProjectContextMessage = {
  chatId?: string;
  senderId?: string;
  senderOpenId?: string;
};
export type FeishuProjectContextInput = {
  activeProject?: FeishuProjectContextActiveProject | null;
  issues?: FeishuProjectContextIssue[];
  mappings?: FeishuProjectMapping[];
  message?: FeishuProjectContextMessage;
  projects?: FeishuProjectContextProject[];
  text: string;
};
export type FeishuProjectContextDatabaseInput =
  Omit<FeishuProjectContextInput, "activeProject" | "issues" | "projects"> & {
    scopeKey?: string;
  };
export type FeishuProjectContextResult = {
  candidates: string[];
  confidence: FeishuProjectContextConfidence;
  projectId: string;
  reason: string;
  source: FeishuProjectContextSource;
  status: FeishuProjectContextStatus;
};

type ProjectMatch = { id: string; score: number };

export function resolveFeishuProjectContext(input: FeishuProjectContextInput): FeishuProjectContextResult {
  const issue = issueProject(input.text, input.issues ?? []);
  if (issue) return resolved(issue.project_id, "issue_ref", "high", "issue_ref_project");

  const explicit = explicitProject(input.text, input.projects ?? []);
  if (explicit.status !== "missing") return explicit;

  if (hasUnresolvedProjectHint(input.text)) return missing("unresolved_explicit_project_hint");

  const mapped = mappedProject(input.mappings ?? [], input.message ?? {}, input.projects ?? []);
  if (mapped.status !== "missing") return mapped;

  return missing("no_project_context");
}

export function resolveFeishuProjectContextFromDatabase(
  db: RunnerDatabase,
  input: FeishuProjectContextDatabaseInput
): FeishuProjectContextResult {
  return resolveFeishuProjectContext({
    ...input,
    issues: issuesFromDatabase(db, input.text),
    projects: listProjects(db).map((project) => ({ id: project.id, name: project.name }))
  });
}

function issuesFromDatabase(
  db: RunnerDatabase,
  text: string
): FeishuProjectContextIssue[] {
  return issueRefs(text).flatMap((id) => {
    const issue = getIssue(db, id);
    return issue ? [{ id: issue.id, project_id: issue.project_id }] : [];
  });
}

function issueProject(
  text: string,
  issues: FeishuProjectContextIssue[]
): FeishuProjectContextIssue | undefined {
  const ids = issueRefs(text);
  if (ids.length === 0) return undefined;
  return ids
    .map((id) => issues.find((issue) => issue.id === id && clean(issue.project_id) !== ""))
    .find((issue): issue is FeishuProjectContextIssue => issue !== undefined);
}

function explicitProject(
  text: string,
  projects: FeishuProjectContextProject[]
): FeishuProjectContextResult {
  const matches = bestProjectMatches(text, projects);
  if (matches.length === 0) return missing("no_explicit_project_text");
  if (matches.length === 1) {
    return resolved(matches[0].id, "explicit_project", "high", "explicit_project_text");
  }
  return ambiguous(matches.map((match) => match.id), "explicit_project", "ambiguous_explicit_project");
}

function mappedProject(
  mappings: FeishuProjectMapping[],
  message: FeishuProjectContextMessage,
  projects: FeishuProjectContextProject[]
): FeishuProjectContextResult {
  const known = new Set(projects.map((project) => clean(project.id)).filter(Boolean));
  const ids = [...new Set(mappings
    .filter((mapping) => mappingMatches(mapping, message))
    .map((mapping) => clean(mapping.projectId))
    .filter((projectID) => projectID !== "" && known.has(projectID)))];
  if (ids.length === 0) return missing("no_source_mapping");
  if (ids.length === 1) return resolved(ids[0], "mapping_default", "medium", "source_mapping_project");
  return ambiguous(ids, "mapping_default", "ambiguous_source_mapping");
}

function hasUnresolvedProjectHint(text: string): boolean {
  const value = clean(text);
  return /@(?:project:)?[A-Za-z0-9][A-Za-z0-9._-]{2,}/i.test(value) ||
    /(?:在|项目|切到|切换到)\s*[A-Za-z0-9][A-Za-z0-9._-]{2,}/i.test(value) ||
    /\b(?:in|project)\s+[A-Za-z0-9][A-Za-z0-9._-]{2,}\b/i.test(value);
}

function mappingMatches(
  mapping: FeishuProjectMapping,
  message: FeishuProjectContextMessage
): boolean {
  const chatID = clean(message.chatId);
  const senderIDs = new Set([clean(message.senderId), clean(message.senderOpenId)].filter(Boolean));
  return (clean(mapping.chatId) !== "" && clean(mapping.chatId) === chatID) ||
    (clean(mapping.userId) !== "" && senderIDs.has(clean(mapping.userId)));
}

function bestProjectMatches(
  text: string,
  projects: FeishuProjectContextProject[]
): ProjectMatch[] {
  const normalizedText = normalizeForMatch(text);
  const matches = projects.flatMap((project) => projectMatches(project, normalizedText));
  const bestScore = Math.max(...matches.map((match) => match.score), 0);
  return uniqueMatches(matches.filter((match) => match.score === bestScore));
}

function projectMatches(
  project: FeishuProjectContextProject,
  normalizedText: string
): ProjectMatch[] {
  return projectTokens(project)
    .filter((token) => token !== "" && normalizedText.includes(token))
    .map((token) => ({ id: project.id, score: token.length }));
}

function projectTokens(project: FeishuProjectContextProject): string[] {
  const values = [project.id, project.name].map(clean).filter(Boolean);
  return [...new Set(values.map(normalizeForMatch).filter(Boolean))];
}

function issueRefs(text: string): number[] {
  const refs: number[] = [];
  for (const match of clean(text).matchAll(/#\s*(\d+)/g)) {
    const id = Number.parseInt(match[1] ?? "", 10);
    if (Number.isSafeInteger(id) && id > 0) refs.push(id);
  }
  return [...new Set(refs)];
}

function uniqueMatches(matches: ProjectMatch[]): ProjectMatch[] {
  const seen = new Set<string>();
  return matches.filter((match) => {
    if (seen.has(match.id)) return false;
    seen.add(match.id);
    return true;
  });
}

function resolved(
  projectId: string,
  source: FeishuProjectContextSource,
  confidence: FeishuProjectContextConfidence,
  reason: string
): FeishuProjectContextResult {
  return { candidates: [projectId], confidence, projectId, reason, source, status: "resolved" };
}

function ambiguous(
  candidates: string[],
  source: FeishuProjectContextSource,
  reason: string
): FeishuProjectContextResult {
  return { candidates, confidence: "low", projectId: "", reason, source, status: "ambiguous" };
}

function missing(reason: string): FeishuProjectContextResult {
  return { candidates: [], confidence: "none", projectId: "", reason, source: "none", status: "missing" };
}

function normalizeForMatch(value: unknown): string {
  return clean(value).toLowerCase().replace(/[\s_-]+/g, "");
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
