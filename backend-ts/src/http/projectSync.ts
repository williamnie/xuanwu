import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, normalize, relative, sep } from "node:path";
import { homedir } from "node:os";
import type { RunnerDatabase } from "../db/database.ts";
import { listProjects, type Project } from "../db/repositories/projects.ts";
import {
  createAutomaticallyManagedProject,
  ensureProjectAutomaticTakeover
} from "../domain/project/automaticTakeover.ts";

const STATE_PATH_ENV = "XUANWU_CODEX_STATE";
const HASH_LENGTH = 8;

type CodexState = {
  "active-workspace-roots"?: unknown;
  "electron-saved-workspace-roots"?: unknown;
  "remote-projects"?: unknown;
};
type RemoteProject = { hostId?: unknown; remotePath?: unknown };
type ProjectCandidate = { cwd: string };
type SkippedProject = { cwd: string; reason: string };
type ProjectDiscovery = { projects: ProjectCandidate[]; skipped: SkippedProject[]; source: string };
type SyncResult = {
  created: Project[];
  existing: Project[];
  skipped: SkippedProject[];
  source: string;
  summary: { created: number; discovered: number; existing: number; skipped: number };
};

export function syncCodexProjects(db: RunnerDatabase): SyncResult {
  const discovery = discoverCodexProjects();
  const result = createMissingProjects(db, discovery);
  return { ...result, summary: syncSummary(discovery, result) };
}

function discoverCodexProjects(): ProjectDiscovery {
  const source = defaultCodexStatePath();
  const body = readFileSync(source, "utf8");
  return buildDiscovery(source, JSON.parse(body) as CodexState);
}

function buildDiscovery(source: string, state: CodexState): ProjectDiscovery {
  const discovery: ProjectDiscovery = { projects: [], skipped: [], source };
  const seen = new Set<string>();
  for (const root of [...stringArray(state["electron-saved-workspace-roots"]), ...stringArray(state["active-workspace-roots"])]) {
    addLocalRoot(discovery, seen, root);
  }
  for (const remote of remoteProjects(state["remote-projects"])) {
    discovery.skipped.push({ cwd: remoteProjectLabel(remote), reason: "remote_project" });
  }
  return discovery;
}

function addLocalRoot(discovery: ProjectDiscovery, seen: Set<string>, raw: string): void {
  const cwd = normalizeWorkspacePath(raw);
  if (cwd === "" || seen.has(cwd)) return;
  seen.add(cwd);
  const reason = skipReason(cwd);
  if (reason !== "") discovery.skipped.push({ cwd, reason });
  else discovery.projects.push({ cwd });
}

function createMissingProjects(db: RunnerDatabase, discovery: ProjectDiscovery): Omit<SyncResult, "summary"> {
  const result = { source: discovery.source, created: [] as Project[], existing: [] as Project[], skipped: discovery.skipped };
  const { byCwd, usedIds } = projectIndexes(listProjects(db));
  for (const candidate of discovery.projects) {
    const existing = byCwd.get(candidate.cwd);
    if (existing) result.existing.push(ensureProjectAutomaticTakeover(db, existing.id));
    else result.created.push(createSyncedProject(db, candidate.cwd, byCwd, usedIds));
  }
  return result;
}

function createSyncedProject(db: RunnerDatabase, cwd: string, byCwd: Map<string, Project>, usedIds: Set<string>): Project {
  const project = createAutomaticallyManagedProject(db, { id: nextProjectID(basename(cwd), cwd, usedIds), cwd });
  byCwd.set(project.cwd, project);
  usedIds.add(project.id);
  return project;
}

function projectIndexes(projects: Project[]): { byCwd: Map<string, Project>; usedIds: Set<string> } {
  return { byCwd: new Map(projects.map((item) => [item.cwd, item])), usedIds: new Set(projects.map((item) => item.id)) };
}

function syncSummary(discovery: ProjectDiscovery, result: Omit<SyncResult, "summary">): SyncResult["summary"] {
  return {
    discovered: discovery.projects.length + discovery.skipped.length,
    created: result.created.length,
    existing: result.existing.length,
    skipped: result.skipped.length
  };
}

function defaultCodexStatePath(): string {
  const envPath = cleanString(Bun.env[STATE_PATH_ENV]);
  return envPath || join(homedir() || ".", ".codex", ".codex-global-state.json");
}

function normalizeWorkspacePath(raw: string): string {
  const value = cleanString(raw);
  if (value === "") return "";
  const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  return normalize(expanded);
}

function skipReason(cwd: string): string {
  if (isSensitiveFolder(cwd)) return "sensitive_folder";
  if (!existsSync(cwd)) return "path_not_found";
  if (!statSync(cwd).isDirectory()) return "not_directory";
  return isCodexWorktree(cwd) ? "codex_worktree" : "";
}

function isSensitiveFolder(cwd: string): boolean {
  const parts = cwd.split(sep).filter(Boolean);
  if (parts.includes("Downloads") || parts.includes("Music") || parts.includes("Movies") || parts.includes("Pictures")) return true;
  return parts.includes("Mobile Documents") || parts.some((part) => part.includes("CloudDocs"));
}

function isCodexWorktree(cwd: string): boolean {
  const rel = relative(join(homedir(), ".codex", "worktrees"), cwd);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

function nextProjectID(name: string, cwd: string, used: Set<string>): string {
  const base = projectIDBase(name);
  if (!used.has(base)) return base;
  const withHash = `${base}-${createHash("sha1").update(cwd).digest("hex").slice(0, HASH_LENGTH)}`;
  return uniqueID(withHash, used);
}

function uniqueID(base: string, used: Set<string>): string {
  for (let suffix = 2; ; suffix += 1) {
    const id = suffix === 2 ? base : `${base}-${suffix}`;
    if (!used.has(id)) return id;
  }
}

function projectIDBase(name: string): string {
  return cleanString(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "project";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function remoteProjects(value: unknown): RemoteProject[] {
  return Array.isArray(value) ? value.filter((item): item is RemoteProject => item !== null && typeof item === "object") : [];
}

function remoteProjectLabel(project: RemoteProject): string {
  const hostID = cleanString(project.hostId);
  const remotePath = cleanString(project.remotePath);
  return hostID === "" ? remotePath : `${hostID}:${remotePath}`;
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
