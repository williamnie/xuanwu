import { normalize } from "node:path";
import { addUsage, clean, numeric, zeroUsage } from "./helpers.ts";
import { UNKNOWN_USAGE_KEY, type TokenUsage, type UsageIssueRef, type UsageMeta, type UsageOptions, type UsageProjectRef } from "./types.ts";

export function newDimensionState(options: UsageOptions) {
  return {
    issues: new Map((options.issues ?? []).map((issue) => [normalizeSessionID(issue.session_id), issue])),
    projects: new Map<string, Record<string, unknown>>(),
    projectsByCwd: new Map((options.projects ?? []).map((project) => [normalizeCWD(project.cwd), project])),
    sessions: new Map<string, Record<string, unknown>>()
  };
}

export function addDimensionUsage(dim: ReturnType<typeof newDimensionState>, meta: UsageMeta, usage: TokenUsage): void {
  if (usage.total_tokens === 0) return;
  const projectRef = dim.projectsByCwd.get(normalizeCWD(meta.cwd));
  const project = ensureProject(dim, projectRef);
  addUsage(project.usage as TokenUsage, usage);
  const session = ensureSession(dim, project.id as string, meta.id);
  addUsage(session.usage as TokenUsage, usage);
  addIssueUsage(dim, project, session, meta.id, usage);
}

export function finishDimensions(dim: ReturnType<typeof newDimensionState>, totalTokens: number): Array<Record<string, unknown>> {
  for (const session of dim.sessions.values()) {
    const project = dim.projects.get(session.project_id as string);
    if (project) (project.sessions as Array<Record<string, unknown>>).push(session);
  }
  return [...dim.projects.values()].map((project) => ({
    ...project,
    percent: totalTokens > 0 ? (((project.usage as TokenUsage).total_tokens / totalTokens) * 100) : 0,
    issues: sortedIssues(project.issues as Array<Record<string, unknown>>),
    sessions: sortedUsage(project.sessions as Array<Record<string, unknown>>)
  })).sort(compareUsage);
}

function ensureProject(dim: ReturnType<typeof newDimensionState>, ref: UsageProjectRef | undefined): Record<string, unknown> {
  const id = ref?.id ?? UNKNOWN_USAGE_KEY;
  let project = dim.projects.get(id);
  if (project) return project;
  project = { id, name: ref?.name || id, cwd: ref?.cwd ?? "", unknown: !ref, usage: zeroUsage(), sessions: [], issues: [] };
  dim.projects.set(id, project);
  return project;
}

function ensureSession(dim: ReturnType<typeof newDimensionState>, projectID: string, rawID: string): Record<string, unknown> {
  const id = normalizeSessionID(rawID) || UNKNOWN_USAGE_KEY;
  const key = `${projectID}\0${id}`;
  let session = dim.sessions.get(key);
  if (session) return session;
  session = { id, project_id: projectID, unknown: id === UNKNOWN_USAGE_KEY, usage: zeroUsage(), issues: [] };
  dim.sessions.set(key, session);
  return session;
}

function addIssueUsage(
  dim: ReturnType<typeof newDimensionState>,
  project: Record<string, unknown>,
  session: Record<string, unknown>,
  sessionID: string,
  usage: TokenUsage
): void {
  const issue = dim.issues.get(normalizeSessionID(sessionID));
  if (!issue) return;
  const aggregate = issueAggregate(issue, usage);
  upsertIssue(project.issues as Array<Record<string, unknown>>, aggregate);
  upsertIssue(session.issues as Array<Record<string, unknown>>, aggregate);
}

function issueAggregate(issue: UsageIssueRef, usage: TokenUsage): Record<string, unknown> {
  return {
    id: issue.id,
    project_id: issue.project_id,
    session_id: normalizeSessionID(issue.session_id),
    title: issue.title,
    status: issue.status,
    usage
  };
}

function upsertIssue(items: Array<Record<string, unknown>>, next: Record<string, unknown>): void {
  const index = items.findIndex((item) => item.id === next.id);
  if (index >= 0) items[index] = next;
  else items.push(next);
}

function sortedUsage(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return items.sort(compareUsage).map((item) => ({ ...item, issues: sortedIssues(item.issues as Array<Record<string, unknown>>) }));
}

function sortedIssues(items: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return items.sort((a, b) => usageTotal(b) - usageTotal(a) || numeric(a.id) - numeric(b.id));
}

function compareUsage(a: Record<string, unknown>, b: Record<string, unknown>): number {
  if (Boolean(a.unknown) !== Boolean(b.unknown)) return Boolean(a.unknown) ? 1 : -1;
  return usageTotal(b) - usageTotal(a) || String(a.id).localeCompare(String(b.id));
}

function usageTotal(item: Record<string, unknown>): number {
  return ((item.usage as TokenUsage | undefined)?.total_tokens ?? 0);
}

function normalizeCWD(value: string): string {
  return clean(value) === "" ? "" : normalize(clean(value));
}

function normalizeSessionID(value: string): string {
  const text = clean(value);
  const separator = text.indexOf(":");
  return separator < 0 ? text : text.slice(separator + 1).trim();
}
