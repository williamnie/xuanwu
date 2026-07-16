import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Value } from "@sinclair/typebox/value";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import type { EvidenceRecord } from "../evidence/contracts.ts";
import type { GitChangedFileDetail, GitSnapshotManifest } from "../evidence/gitCollector.ts";
import {
  HANDOFF_DIFF_SUMMARY_SCHEMA,
  HANDOFF_LARGE_FILE_THRESHOLD_BYTES,
  buildHandoffDiffSummary
} from "./diffSummary.ts";

const NOW = "2026-07-16T13:00:00.000Z";
const PRIVATE_DIFF = "PRIVATE_PATCH_BODY_DO_NOT_COPY: old customer payload -> new customer payload";
const DETAILS: GitChangedFileDetail[] = [
  {
    additions: 180,
    binary: false,
    deletions: 2,
    path: "backend-ts/src/domain/handoff/diffSummary.test.ts",
    size_bytes: 9_000
  },
  {
    additions: 200,
    binary: false,
    deletions: 10,
    path: "backend-ts/src/domain/handoff/diffSummary.ts",
    size_bytes: 14_000
  },
  {
    additions: 30,
    binary: false,
    deletions: 0,
    path: "bun.lock",
    size_bytes: 30_000
  },
  {
    additions: 20,
    binary: false,
    deletions: 0,
    path: "docs/generated/api.md",
    size_bytes: HANDOFF_LARGE_FILE_THRESHOLD_BYTES + 1
  },
  {
    additions: null,
    binary: true,
    deletions: null,
    path: "frontend/public/logo.png",
    size_bytes: 20_000
  },
  {
    additions: null,
    binary: null,
    deletions: null,
    path: "scratch/new-note.txt",
    size_bytes: 100
  }
];

describe("Handoff Changed Files / Diff Summary", () => {
  test("groups multi-type paths and produces stable stats, notable files, and risk hints", () => {
    const summary = buildHandoffDiffSummary({ git_evidence: evidence() });

    expect(Value.Check(HANDOFF_DIFF_SUMMARY_SCHEMA, summary)).toBe(true);
    expect(summary).toMatchObject({
      schema_version: 1,
      detail_level: "per_file_v2",
      changed_files: DETAILS.map((file) => file.path),
      diff_stats: {
        changed_path_count: 6,
        tracked_diff_file_count: 5,
        insertions: 430,
        deletions: 12,
        binary_file_count: 1,
        untracked_file_count: 1
      },
      notable_files: {
        binary: ["frontend/public/logo.png"],
        large: [{
          path: "docs/generated/api.md",
          size_bytes: HANDOFF_LARGE_FILE_THRESHOLD_BYTES + 1
        }],
        generated: ["bun.lock", "docs/generated/api.md"]
      }
    });
    expect(summary.path_groups).toEqual([
      { group: "(root)", files: ["bun.lock"] },
      {
        group: "backend-ts",
        files: [
          "backend-ts/src/domain/handoff/diffSummary.test.ts",
          "backend-ts/src/domain/handoff/diffSummary.ts"
        ]
      },
      { group: "docs", files: ["docs/generated/api.md"] },
      { group: "frontend", files: ["frontend/public/logo.png"] },
      { group: "scratch", files: ["scratch/new-note.txt"] }
    ]);
    expect(summary.risk_hints.map((risk) => risk.id)).toEqual([
      "binary_diff",
      "large_files",
      "generated_files"
    ]);
  });

  test("keeps notification text aggregate-only and never copies the Evidence diff excerpt", () => {
    const summary = buildHandoffDiffSummary({ git_evidence: evidence() });

    expect(summary.notification_summary).toBe(
      "6 changed path(s); +430/-12; 1 binary; 1 large; 2 generated-looking."
    );
    expect(summary.notification_summary).not.toContain("backend-ts");
    expect(JSON.stringify({
      notification_summary: summary.notification_summary,
      risk_hints: summary.risk_hints,
      summary: summary.summary
    })).not.toContain(PRIVATE_DIFF);
  });

  test("reads and verifies an overflow snapshot artifact", () => {
    const manifest = snapshotManifest();
    const content = `${JSON.stringify(manifest)}\n`;
    const sha256 = createHash("sha256").update(content).digest("hex");
    const gitEvidence = evidence({ inline: false, snapshotSha256: sha256 });
    gitEvidence.artifact_refs = [{
      kind: "report",
      ref: `artifacts/evidence-git-snapshot/${sha256.slice(0, 2)}/${sha256}.json`,
      media_type: "application/json",
      sha256
    }];

    const summary = buildHandoffDiffSummary({
      git_evidence: gitEvidence,
      snapshot_artifact: { content, ref: gitEvidence.artifact_refs[0]!.ref }
    });

    expect(summary.detail_level).toBe("per_file_v2");
    expect(summary.changed_files).toEqual(DETAILS.map((file) => file.path));
    expect(() => buildHandoffDiffSummary({
      git_evidence: gitEvidence,
      snapshot_artifact: { content: `${content}tampered`, ref: gitEvidence.artifact_refs[0]!.ref }
    })).toThrow("checksum mismatch");
  });

  test("keeps legacy path-only Evidence readable while making metadata loss explicit", () => {
    const gitEvidence = evidence();
    delete gitEvidence.decisive_output.facts.changed_file_details_json;

    const summary = buildHandoffDiffSummary({ git_evidence: gitEvidence });

    expect(summary.detail_level).toBe("paths_only_v1");
    expect(summary.notable_files.binary).toEqual([]);
    expect(summary.notable_files.large).toEqual([]);
    expect(summary.notable_files.generated).toEqual(["bun.lock", "docs/generated/api.md"]);
    expect(summary.risk_hints.map((risk) => risk.id)).toEqual([
      "binary_diff",
      "generated_files",
      "file_metadata_unavailable"
    ]);
  });

  test("fails closed on mismatched stats or non-authoritative Git claims", () => {
    const mismatched = evidence();
    mismatched.decisive_output.facts.insertions = 431;
    expect(() => buildHandoffDiffSummary({ git_evidence: mismatched }))
      .toThrow("aggregate diff stats do not match");

    const agentClaim = evidence();
    agentClaim.provenance.assertion_origin = "agent_claim";
    agentClaim.provenance.source_kind = "agent_statement";
    expect(() => buildHandoffDiffSummary({ git_evidence: agentClaim }))
      .toThrow("trusted Git repository observation");
  });
});

function evidence(options: { inline?: boolean; snapshotSha256?: string } = {}): EvidenceRecord {
  const inline = options.inline ?? true;
  return {
    schema_version: 1,
    id: makeDomainID("evidence", "git", "673:diff-summary"),
    work_id: makeDomainID("work", "issues", 673),
    revision: 0,
    kind: "git",
    status: "passed",
    created_at: NOW,
    observed_at: NOW,
    updated_at: NOW,
    completed_at: NOW,
    decisive_output: {
      summary: "Git snapshot fixture",
      excerpt: PRIVATE_DIFF,
      facts: {
        binary_file_count: 1,
        changed_file_details_json: inline ? JSON.stringify(DETAILS) : null,
        changed_path_count: 6,
        changed_paths_inline: inline,
        changed_paths_json: inline ? JSON.stringify(DETAILS.map((file) => file.path)) : null,
        deletions: 12,
        diff_changed_file_count: 5,
        insertions: 430,
        snapshot_sha256: options.snapshotSha256 ?? "a".repeat(64),
        untracked_count: 1
      }
    },
    artifact_refs: [],
    provenance: {
      assertion_origin: "system_observation",
      source_kind: "git_repository",
      source_ref: "git-repository:fixture",
      audit_event_ref: "issue_events:673:git:snapshot",
      producer: { id: "runner-git-collector", kind: "runner" }
    },
    redaction: {
      status: "not_required",
      policy_ref: "evidence-redaction:v1",
      redacted_paths: []
    }
  };
}

function snapshotManifest(): GitSnapshotManifest {
  return {
    schema_version: 2,
    head_revision: "b".repeat(40),
    head_ref: "refs/heads/main",
    base_revision: "c".repeat(40),
    status: {
      dirty: true,
      tracked_dirty: true,
      staged_change_count: 1,
      unstaged_change_count: 3,
      conflict_count: 0,
      untracked_count: 1
    },
    working_tree_paths: DETAILS.map((file) => file.path),
    changed_files: DETAILS,
    changed_paths: DETAILS.map((file) => file.path),
    diff_stats: {
      changed_file_count: 5,
      insertions: 430,
      deletions: 12,
      binary_file_count: 1
    },
    untracked_policy: "include_all",
    ignored_policy: "exclude"
  };
}
