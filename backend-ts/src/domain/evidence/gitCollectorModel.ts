import type { DomainActor } from "../../xuanwu/coreDomainContracts.ts";
import {
  type EvidenceArtifactRef,
  type EvidenceID,
  type EvidenceRecord,
  type RunAttemptID,
  type RunID,
  type WorkID
} from "./contracts.ts";

export const GIT_UNTRACKED_POLICIES = ["include_all", "exclude"] as const;

export type GitUntrackedPolicy = typeof GIT_UNTRACKED_POLICIES[number];

type GitEvidenceContext = {
  attempt_id?: RunAttemptID;
  audit_event_ref: string;
  collected_at?: string;
  evidence_id: EvidenceID;
  producer: DomainActor;
  run_id?: RunID;
  source_ref: string;
  work_id: WorkID;
};

export type CollectGitEvidenceInput = {
  artifact_refs?: readonly EvidenceArtifactRef[];
  base_revision?: string;
  context: GitEvidenceContext;
  pathspecs?: readonly string[];
  repository_path: string;
  untracked_policy?: GitUntrackedPolicy;
};

export type GitSnapshotArtifactWrite = {
  audit_event_ref: string;
  bytes: number;
  content: string;
  evidence_id: EvidenceID;
  sha256: string;
  source_ref: string;
};

export interface GitEvidenceArtifactStore {
  writeGitSnapshot(input: GitSnapshotArtifactWrite): Promise<EvidenceArtifactRef> | EvidenceArtifactRef;
}

export interface GitEvidenceCollector {
  collect(input: CollectGitEvidenceInput): Promise<EvidenceRecord>;
}

export type GitEvidenceCollectorOptions = {
  artifact_store?: GitEvidenceArtifactStore;
  git_binary?: string;
  max_git_output_bytes?: number;
};

export type GitStatusSummary = {
  conflict_count: number;
  dirty: boolean;
  paths: string[];
  staged_change_count: number;
  tracked_dirty: boolean;
  unstaged_change_count: number;
  untracked_count: number | null;
};

export type GitDiffSummary = {
  binary_file_count: number;
  changed_file_count: number;
  deletions: number;
  files: GitChangedFileDiff[];
  insertions: number;
  paths: string[];
};

export type GitChangedFileDiff = {
  additions: number | null;
  binary: boolean;
  deletions: number | null;
  path: string;
};

export type GitChangedFileDetail = {
  additions: number | null;
  binary: boolean | null;
  deletions: number | null;
  path: string;
  size_bytes: number | null;
};

export type GitSnapshotManifest = {
  base_revision: string | null;
  changed_files: GitChangedFileDetail[];
  changed_paths: string[];
  diff_stats: Omit<GitDiffSummary, "files" | "paths">;
  head_ref: string | null;
  head_revision: string | null;
  ignored_policy: "exclude";
  schema_version: 2;
  status: Omit<GitStatusSummary, "paths">;
  untracked_policy: GitUntrackedPolicy;
  working_tree_paths: string[];
};

export const MAX_FACT_TEXT_BYTES = 8 * 1024;

export const GIT_ARTIFACT_ROOT = "artifacts/evidence-git-snapshot";

export const OBJECT_ID_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
