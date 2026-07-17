import type { RunnerDatabase } from "../database.ts";
import { getProject } from "./projects.ts";

export const GIT_EVENT_PROVIDERS = ["github", "gitlab"] as const;
export type GitEventProvider = typeof GIT_EVENT_PROVIDERS[number];

export type GitRepoMapping = {
  created_at: string;
  project_id: string;
  provider: GitEventProvider;
  repository: string;
  updated_at: string;
};

export type GitRepoMappingAudit = {
  actor: string;
  correlation_id: string;
  event_id: string;
  reason: string;
};

export function upsertGitRepoMapping(
  db: RunnerDatabase,
  input: { audit: GitRepoMappingAudit; project_id: string; provider: GitEventProvider; repository: string },
  timestamp = new Date()
): GitRepoMapping {
  const provider = gitEventProvider(input.provider);
  const repository = normalizeGitRepository(input.repository);
  const projectID = requiredText(input.project_id, "project_id");
  if (!getProject(db, projectID)) throw new Error("project not found");
  const audit = normalizeAudit(input.audit);
  const previous = getGitRepoMapping(db, provider, repository);
  const now = timestamp.toISOString();
  db.sqlite.run(`insert into git_repo_mappings (provider, repository, project_id, created_at, updated_at)
    values (?, ?, ?, ?, ?)
    on conflict(provider, repository) do update set project_id=excluded.project_id, updated_at=excluded.updated_at`,
  [provider, repository, projectID, previous?.created_at ?? now, now]);
  db.sqlite.run(`insert into git_repo_mapping_events
    (provider, repository, project_id, action, audit_json, created_at) values (?, ?, ?, ?, ?, ?)`,
  [provider, repository, projectID, previous ? "updated" : "created", JSON.stringify(audit), now]);
  const saved = getGitRepoMapping(db, provider, repository);
  if (!saved) throw new Error("git repository mapping missing after write");
  return saved;
}

export function getGitRepoMapping(db: RunnerDatabase, providerValue: unknown, repositoryValue: unknown): GitRepoMapping | null {
  const provider = gitEventProvider(providerValue);
  const repository = normalizeGitRepository(repositoryValue);
  const row = db.sqlite.query<Record<string, unknown>, [string, string]>(`
    select provider, repository, project_id, created_at, updated_at
    from git_repo_mappings where provider=? and repository=?
  `).get(provider, repository);
  return row ? mapRow(row) : null;
}

export function gitEventProvider(value: unknown): GitEventProvider {
  const provider = requiredText(value, "provider").toLowerCase();
  if (!GIT_EVENT_PROVIDERS.includes(provider as GitEventProvider)) throw new Error("provider must be github or gitlab");
  return provider as GitEventProvider;
}

export function normalizeGitRepository(value: unknown): string {
  let repository = requiredText(value, "repository").replace(/\\.git$/i, "");
  try {
    const url = new URL(repository);
    repository = url.pathname.replace(/^\/+|\/+$/g, "");
  } catch {}
  repository = repository.replace(/^git@[^:]+:/i, "").replace(/^\/+|\/+$/g, "").toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)+$/.test(repository)) {
    throw new Error("repository must be an owner/name path");
  }
  return repository;
}

function normalizeAudit(value: GitRepoMappingAudit): GitRepoMappingAudit {
  return {
    actor: requiredText(value?.actor, "audit.actor"),
    correlation_id: requiredText(value?.correlation_id, "audit.correlation_id"),
    event_id: requiredText(value?.event_id, "audit.event_id"),
    reason: requiredText(value?.reason, "audit.reason")
  };
}

function mapRow(row: Record<string, unknown>): GitRepoMapping {
  return {
    provider: gitEventProvider(row.provider),
    repository: normalizeGitRepository(row.repository),
    project_id: requiredText(row.project_id, "project_id"),
    created_at: requiredText(row.created_at, "created_at"),
    updated_at: requiredText(row.updated_at, "updated_at")
  };
}

function requiredText(value: unknown, label: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (text === "") throw new Error(`${label} is required`);
  return text;
}
