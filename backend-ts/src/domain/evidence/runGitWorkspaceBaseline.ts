import { createHash } from "node:crypto";
import type { RunnerDatabase } from "../../db/database.ts";
import { recordIssueEvent } from "../../db/repositories/issueEvents.ts";
import {
  ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT,
  workspaceBaseline,
  requiredText,
  normalizedPath,
  workspaceStatus,
  compareWorkspaceEntry,
  canonicalTimestamp,
  gitObjectID,
  revisionBefore,
  gitOutput,
  changedPathsBetween,
  entrySignature
} from "./runGitWorkspaceBaselineObservation.ts";

export const ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT = "issue.run_git_workspace_baseline.v1";

export type WorkspaceEntry = {
  content_oid: string;
  path: string;
  status: string;
};

export type CapturedGitWorkspaceBaseline = {
  base_revision: string;
  captured_at: string;
  entries: WorkspaceEntry[];
  snapshot_sha256: string;
};

export type WorkspaceBaseline = CapturedGitWorkspaceBaseline & {
  contract: typeof ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT;
  run_id: string;
};

type IssueRunGitDeliveryScope = {
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

export function recordCapturedIssueRunGitWorkspaceBaseline(
  db: RunnerDatabase,
  issueID: number,
  runID: string,
  input: CapturedGitWorkspaceBaseline
): WorkspaceBaseline {
  const entries = input.entries.map((entry) => ({
    content_oid: requiredText(entry.content_oid, "workspace content oid"),
    path: normalizedPath(entry.path),
    status: workspaceStatus(entry.status)
  })).sort(compareWorkspaceEntry);
  const snapshotSha256 = createHash("sha256").update(`${JSON.stringify(entries)}\n`).digest("hex");
  if (snapshotSha256 !== input.snapshot_sha256) throw new Error("workspace snapshot fingerprint is invalid");
  const baseline = {
    base_revision: input.base_revision.trim().toLowerCase(),
    captured_at: canonicalTimestamp(input.captured_at),
    contract: ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT,
    entries,
    run_id: requiredText(runID, "Run id"),
    snapshot_sha256: snapshotSha256
  };
  if (!gitObjectID(baseline.base_revision)) throw new Error("Run Git base revision must be a full object id");
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
  const baseline = readIssueRunGitWorkspaceBaseline(db, issueID, input.run_id);
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

export function readIssueRunGitWorkspaceBaseline(db: RunnerDatabase, issueID: number, runID: string): WorkspaceBaseline | null {
  const rows = db.sqlite.query<{ payload: string }, [number, string, string]>(`
    select payload from issue_events
    where issue_id=? and type=? and json_valid(payload) and json_extract(payload, '$.run_id')=?
    order by id desc limit 20
  `).all(issueID, ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT, runID);
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

export { ISSUE_RUN_GIT_WORKSPACE_BASELINE_CONTRACT } from "./runGitWorkspaceBaselineObservation.ts";
