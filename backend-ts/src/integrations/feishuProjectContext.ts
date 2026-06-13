import type { RunnerDatabase } from "../db/database.ts";
import { getFeishuConversationState } from "../db/repositories/feishuConversationState.ts";
import type { FeishuActiveProjectSource } from "../db/repositories/feishuConversationState.ts";
import { getIssue } from "../db/repositories/issues.ts";
import { listProjects } from "../db/repositories/projects.ts";
import type { FeishuProjectMapping } from "./feishu.ts";

export type FeishuProjectContextStatus = "resolved" | "ambiguous" | "missing";
export type FeishuProjectContextSource = FeishuActiveProjectSource | "none";
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

  const active = activeProject(input.activeProject, input.projects ?? []);
  if (active) return active;

  const mapping = mappingDefault(input.message, input.mappings ?? []);
  if (mapping) return resolved(mapping, "mapping_default", "low", "mapping_default");

  return missing("no_project_context");
}

export function resolveFeishuProjectContextFromDatabase(
  db: RunnerDatabase,
  input: FeishuProjectContextDatabaseInput
): FeishuProjectContextResult {
  return resolveFeishuProjectContext({
    ...input,
    activeProject: activeProjectFromDatabase(db, input.scopeKey),
    issues: issuesFromDatabase(db, input.text),
    projects: listProjects(db).map((project) => ({ id: project.id, name: project.name }))
  });
}

function activeProjectFromDatabase(
  db: RunnerDatabase,
  scopeKey: string | undefined
): FeishuProjectContextActiveProject | null {
  const state = getFeishuConversationState(db, clean(scopeKey));
  if (!state || state.active_project_id === "") return null;
  return {
    active_project_id: state.active_project_id,
    active_project_source: state.active_project_source
  };
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

function activeProject(
  active: FeishuProjectContextActiveProject | null | undefined,
  projects: FeishuProjectContextProject[]
): FeishuProjectContextResult | null {
  const projectID = clean(active?.active_project_id);
  if (projectID === "") return null;
  if (projects.length > 0 && !projects.some((project) => project.id === projectID)) return null;
  const source = activeProjectSource(active?.active_project_source);
  return resolved(projectID, source, "medium", "conversation_active_project");
}

function mappingDefault(
  message: FeishuProjectContextMessage | undefined,
  mappings: FeishuProjectMapping[]
): string {
  const chatID = clean(message?.chatId);
  const senderID = clean(message?.senderId);
  const senderOpenID = clean(message?.senderOpenId);
  return clean(mappings.find((mapping) => clean(mapping.chatId) === chatID)?.projectId) ||
    clean(mappings.find((mapping) => {
      const userID = clean(mapping.userId);
      return userID !== "" && (userID === senderID || userID === senderOpenID);
    })?.projectId);
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
  return [...new Set(values.flatMap((value) => [
    normalizeForMatch(value),
    ...value.split(/[\s_-]+/).map(normalizeForMatch).filter((token) => token.length >= 3)
  ]).filter(Boolean))];
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

function activeProjectSource(value: unknown): FeishuActiveProjectSource {
  const source = clean(value);
  if (
    source === "explicit_project" || source === "issue_ref" ||
    source === "user_switch" || source === "card_select" ||
    source === "mapping_default"
  ) return source;
  return "user_switch";
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
