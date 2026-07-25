import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";

export const ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT = "issue.run_git_workspace_baseline.v1";
export const ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT = "xw.issue-run-git-workspace-baseline.v1";

type WorkspaceEntry = {
  content_oid: string;
  path: string;
  status: string;
};

type WorkspaceBaseline = {
  base_revision: string;
  captured_at: string;
  contract: typeof ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT;
  entries: WorkspaceEntry[];
  run_id: string;
  snapshot_sha256: string;
};

export type IssueRunGitDeliveryScope = {
  base_revision: string;
  pathspecs: string[];
  uncertainty_reasons: string[];
};

export function recordIssueRunGitWorkspaceBaseline(
  db: RunnerDatabase,
  issueID: number,
  input: {
    base_revision: string;
    captured_at: string;
    repository_path: string;
    run_id: string;
  }
): WorkspaceBaseline {
  const baseline = workspaceBaseline(input);
  recordIssueEvent(db, issueID, ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT, baseline);
  return baseline;
}

export function issueRunGitDeliveryScope(
  db: RunnerDatabase,
  issueID: number,
  input: {
    base_revision: string;
    repository_path: string;
    run_id: string;
  }
): IssueRunGitDeliveryScope {
  const runWindow = db.sqlite.query<{ ended_at: string; started_at: string }, [number, string]>(`
    select ended_at, started_at from issue_runs where issue_id=? and id=?
  `).get(issueID, input.run_id);
  const recordedBaseRevision = gitObjectID(input.base_revision)
    ? input.base_revision.trim().toLowerCase()
    : "";
  const inferredBaseRevision = recordedBaseRevision === "" && runWindow?.started_at
    ? revisionBefore(input.repository_path, runWindow.started_at)
    : "";
  const baseRevision = recordedBaseRevision || inferredBaseRevision;
  if (baseRevision === "") {
    return {
      base_revision: "",
      pathspecs: [],
      uncertainty_reasons: ["Run Git base revision is unavailable; Work file attribution cannot be proven"]
    };
  }

  const currentHeadRevision = gitOutput(input.repository_path, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const endedRevision = runWindow?.ended_at
    ? revisionBefore(input.repository_path, runWindow.ended_at)
    : "";
  const headRevision = gitObjectID(endedRevision) ? endedRevision : currentHeadRevision;
  const committedPaths = gitObjectID(headRevision)
    ? changedPathsBetween(input.repository_path, baseRevision, headRevision)
    : [];
  const baseline = storedBaseline(db, issueID, input.run_id);
  if (!baseline || baseline.base_revision !== baseRevision) {
    const inference = recordedBaseRevision === ""
      ? "Run Git base revision was inferred from its persisted start time"
      : "Run workspace baseline is unavailable";
    return {
      base_revision: baseRevision,
      pathspecs: committedPaths,
      uncertainty_reasons: [
        `${inference}; only committed paths are attributed and dirty/untracked paths are excluded`
      ]
    };
  }

  let current: WorkspaceBaseline;
  try {
    current = workspaceBaseline({
      base_revision: baseRevision,
      captured_at: new Date().toISOString(),
      repository_path: input.repository_path,
      run_id: input.run_id
    });
  } catch {
    return {
      base_revision: baseRevision,
      pathspecs: committedPaths,
      uncertainty_reasons: [
        "Current workspace snapshot is unavailable; only committed paths are attributed and dirty/untracked paths are excluded"
      ]
    };
  }

  const before = new Map(baseline.entries.map((entry) => [entry.path, entry]));
  const after = new Map(current.entries.map((entry) => [entry.path, entry]));
  const uncertainPaths = new Set<string>();
  const attributed = new Set<string>();

  for (const path of committedPaths) {
    if (before.has(path)) uncertainPaths.add(path);
    else attributed.add(path);
  }
  for (const entry of current.entries) {
    const previous = before.get(entry.path);
    if (!previous) {
      attributed.add(entry.path);
      continue;
    }
    if (entrySignature(previous) !== entrySignature(entry)) uncertainPaths.add(entry.path);
  }
  for (const entry of baseline.entries) {
    if (!after.has(entry.path) && !committedPaths.includes(entry.path)) uncertainPaths.add(entry.path);
  }
  for (const path of uncertainPaths) attributed.delete(path);

  return {
    base_revision: baseRevision,
    pathspecs: [...attributed].sort(),
    uncertainty_reasons: uncertainPaths.size > 0
      ? [`Pre-existing workspace paths changed during the Run and were excluded as unattributable: ${[...uncertainPaths].sort().join(", ")}`]
      : []
  };
}

export function gitPathspecFingerprint(pathspecs: readonly string[]): string {
  return createHash("sha256").update(`${JSON.stringify([...pathspecs].sort())}\n`).digest("hex");
}

function workspaceBaseline(input: {
  base_revision: string;
  captured_at: string;
  repository_path: string;
  run_id: string;
}): WorkspaceBaseline {
  const baseRevision = input.base_revision.trim().toLowerCase();
  if (!gitObjectID(baseRevision)) throw new Error("Run Git base revision must be a full object id");
  const entries = workspaceEntries(input.repository_path);
  const canonical = JSON.stringify(entries);
  return {
    base_revision: baseRevision,
    captured_at: canonicalTimestamp(input.captured_at),
    contract: ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT,
    entries,
    run_id: requiredText(input.run_id, "Run id"),
    snapshot_sha256: createHash("sha256").update(`${canonical}\n`).digest("hex")
  };
}

function workspaceEntries(repositoryPath: string): WorkspaceEntry[] {
  const result = Bun.spawnSync({
    cmd: [
      "git", "status", "--porcelain=v1", "-z", "--no-renames",
      "--untracked-files=all", "--ignored=no", "--"
    ],
    cwd: repositoryPath,
    stderr: "pipe",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) throw new Error("Git workspace status is unavailable");
  return result.stdout.toString().split("\0").filter(Boolean).map((field) => {
    if (field.length < 4 || field[2] !== " ") throw new Error("Git workspace status is malformed");
    const status = field.slice(0, 2);
    const path = normalizedPath(field.slice(3));
    return {
      content_oid: worktreeObjectID(repositoryPath, path),
      path,
      status
    };
  }).sort(compareWorkspaceEntry);
}

function worktreeObjectID(repositoryPath: string, path: string): string {
  const result = Bun.spawnSync({
    cmd: ["git", "hash-object", "--no-filters", "--", path],
    cwd: repositoryPath,
    stderr: "ignore",
    stdout: "pipe"
  });
  const value = result.exitCode === 0 ? result.stdout.toString().trim().toLowerCase() : "";
  return gitObjectID(value) ? value : "missing";
}

function storedBaseline(db: RunnerDatabase, issueID: number, runID: string): WorkspaceBaseline | null {
  const rows = db.sqlite.query<{ payload: string }, [number, string]>(`
    select payload from issue_events
    where issue_id=? and type=?
    order by id desc limit 20
  `).all(issueID, ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT);
  for (const row of rows) {
    try {
      const value = JSON.parse(row.payload) as Partial<WorkspaceBaseline>;
      if (value.contract !== ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT || value.run_id !== runID ||
        !Array.isArray(value.entries) || typeof value.base_revision !== "string") continue;
      const entries = value.entries.map((entry) => ({
        content_oid: requiredText(entry.content_oid, "workspace content oid"),
        path: normalizedPath(entry.path),
        status: workspaceStatus(entry.status)
      })).sort(compareWorkspaceEntry);
      const snapshotSha256 = requiredText(value.snapshot_sha256, "workspace snapshot sha256");
      const expectedSnapshot = createHash("sha256")
        .update(`${JSON.stringify(entries)}\n`)
        .digest("hex");
      if (snapshotSha256 !== expectedSnapshot) continue;
      const baseRevision = value.base_revision.trim().toLowerCase();
      if (!gitObjectID(baseRevision)) continue;
      return {
        base_revision: baseRevision,
        captured_at: canonicalTimestamp(value.captured_at),
        contract: ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT,
        entries,
        run_id: runID,
        snapshot_sha256: snapshotSha256
      };
    } catch {
      continue;
    }
  }
  return null;
}

function changedPathsBetween(repositoryPath: string, baseRevision: string, headRevision: string): string[] {
  if (baseRevision === headRevision) return [];
  const result = Bun.spawnSync({
    cmd: [
      "git", "diff", "--name-only", "--no-ext-diff", "--no-renames", "-z",
      baseRevision, headRevision, "--"
    ],
    cwd: repositoryPath,
    stderr: "ignore",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) return [];
  return [...new Set(result.stdout.toString().split("\0").filter(Boolean).map(normalizedPath))].sort();
}

function gitOutput(repositoryPath: string, args: string[]): string {
  try {
    const result = Bun.spawnSync({
      cmd: ["git", ...args],
      cwd: repositoryPath,
      stderr: "ignore",
      stdout: "pipe"
    });
    return result.exitCode === 0 ? result.stdout.toString().trim().toLowerCase() : "";
  } catch {
    return "";
  }
}

function revisionBefore(repositoryPath: string, timestamp: string): string {
  const revision = gitOutput(repositoryPath, ["rev-list", "-1", `--before=${timestamp}`, "HEAD"]);
  return gitObjectID(revision) ? revision : "";
}

function entrySignature(entry: WorkspaceEntry): string {
  return `${entry.status}\0${entry.content_oid}`;
}

function compareWorkspaceEntry(left: WorkspaceEntry, right: WorkspaceEntry): number {
  return Buffer.from(left.path).compare(Buffer.from(right.path));
}

function gitObjectID(value: string): boolean {
  return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.trim().toLowerCase());
}

function normalizedPath(value: string): string {
  const path = requiredText(value, "workspace path").replaceAll("\\", "/");
  if (path.startsWith("/") || path === ".." || path.startsWith("../") || path.includes("/../")) {
    throw new Error("workspace path escapes the repository");
  }
  return path;
}

function workspaceStatus(value: unknown): string {
  if (typeof value !== "string" || value.length !== 2 || value === "  " ||
    !/^[ MADRCUT?!]{2}$/.test(value)) {
    throw new Error("workspace status must be a two-character Git porcelain status");
  }
  return value;
}

function canonicalTimestamp(value: unknown): string {
  const text = requiredText(value, "timestamp");
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new Error("timestamp must be ISO-8601");
  return date.toISOString();
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`);
  return value.trim();
}
