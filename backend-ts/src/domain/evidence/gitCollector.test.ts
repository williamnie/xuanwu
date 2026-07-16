import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRunAttemptID } from "../run/contracts.ts";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { validateEvidence } from "./contracts.ts";
import {
  FileSystemGitEvidenceArtifactStore,
  createGitEvidenceCollector,
  type CollectGitEvidenceInput
} from "./gitCollector.ts";

const COLLECTED_AT = "2026-07-16T10:00:00.000Z";
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("Git Evidence collector", () => {
  test("collects a clean repository while excluding ignored paths", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, ".gitignore"), "*.ignored\n");
    writeFileSync(join(repository, "tracked.txt"), "one\n");
    git(repository, "add", ".gitignore", "tracked.txt");
    git(repository, "commit", "-m", "initial");
    writeFileSync(join(repository, "private.ignored"), "must not be observed\n");
    const head = revision(repository);

    const evidence = await createGitEvidenceCollector().collect(fixture(repository, head));

    expect(evidence).toMatchObject({
      kind: "git",
      status: "passed",
      decisive_output: {
        facts: {
          base_revision: head,
          changed_path_count: 0,
          changed_paths_json: "[]",
          head_ref: "refs/heads/main",
          head_revision: head,
          ignored_policy: "exclude",
          is_unborn: false,
          untracked_count: 0,
          untracked_policy: "include_all",
          working_tree_dirty: false
        }
      },
      provenance: {
        assertion_origin: "system_observation",
        source_kind: "git_repository",
        source_ref: "git-repository:fixture"
      }
    });
    expect(evidence.decisive_output.summary).toContain("working tree clean");
    expect(JSON.parse(String(evidence.decisive_output.facts.changed_paths_json))).not.toContain("private.ignored");
    expect(validateEvidence(evidence)).toMatchObject({ known_kind: true, ok: true });
  });

  test("collects staged, unstaged and untracked paths with combined diff stats", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, ".gitignore"), "*.ignored\n");
    writeFileSync(join(repository, "tracked.txt"), "one\n");
    git(repository, "add", ".gitignore", "tracked.txt");
    git(repository, "commit", "-m", "initial");
    const base = revision(repository);
    writeFileSync(join(repository, "tracked.txt"), "one\ntwo\n");
    writeFileSync(join(repository, "staged.txt"), "staged\n");
    writeFileSync(join(repository, "untracked.txt"), "untracked\n");
    writeFileSync(join(repository, "private.ignored"), "ignored\n");
    git(repository, "add", "staged.txt");

    const evidence = await createGitEvidenceCollector().collect(fixture(repository, base));
    const paths = JSON.parse(String(evidence.decisive_output.facts.changed_paths_json));
    const details = JSON.parse(String(evidence.decisive_output.facts.changed_file_details_json));

    expect(paths).toEqual(["staged.txt", "tracked.txt", "untracked.txt"]);
    expect(evidence.decisive_output.facts).toMatchObject({
      changed_path_count: 3,
      diff_changed_file_count: 2,
      insertions: 2,
      deletions: 0,
      staged_change_count: 1,
      tracked_dirty: true,
      unstaged_change_count: 1,
      untracked_count: 1,
      working_tree_dirty: true
    });
    expect(paths).not.toContain("private.ignored");
    expect(details).toEqual([
      { additions: 1, binary: false, deletions: 0, path: "staged.txt", size_bytes: 7 },
      { additions: 1, binary: false, deletions: 0, path: "tracked.txt", size_bytes: 8 },
      { additions: null, binary: null, deletions: null, path: "untracked.txt", size_bytes: 10 }
    ]);
    expect(validateEvidence(evidence).ok).toBe(true);
  });

  test("records binary paths without inventing line stats", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "asset.bin"), Buffer.from([0, 1, 2]));
    git(repository, "add", "asset.bin");
    git(repository, "commit", "-m", "binary base");
    const base = revision(repository);
    writeFileSync(join(repository, "asset.bin"), Buffer.from([0, 1, 3, 4]));

    const evidence = await createGitEvidenceCollector().collect(fixture(repository, base));

    expect(evidence.decisive_output.facts).toMatchObject({
      binary_file_count: 1,
      diff_changed_file_count: 1,
      insertions: 0,
      deletions: 0
    });
    expect(JSON.parse(String(evidence.decisive_output.facts.changed_file_details_json))).toEqual([{
      additions: null,
      binary: true,
      deletions: null,
      path: "asset.bin",
      size_bytes: 4
    }]);
  });

  test("makes untracked exclusion explicit instead of reporting an invented zero", async () => {
    const repository = initRepository(true);
    writeFileSync(join(repository, "untracked.txt"), "not observed\n");

    const evidence = await createGitEvidenceCollector().collect({
      ...fixture(repository, revision(repository)),
      untracked_policy: "exclude"
    });

    expect(evidence.decisive_output.facts).toMatchObject({
      changed_path_count: 0,
      changed_paths_json: "[]",
      tracked_dirty: false,
      untracked_count: null,
      untracked_policy: "exclude",
      working_tree_dirty: false
    });
  });

  test("records an unborn branch and its staged initial tree without inventing HEAD or base", async () => {
    const repository = initRepository(false);
    writeFileSync(join(repository, "first.txt"), "first\n");
    git(repository, "add", "first.txt");

    const evidence = await createGitEvidenceCollector().collect(fixture(repository));

    expect(evidence.decisive_output.facts).toMatchObject({
      base_revision: null,
      changed_paths_json: "[\"first.txt\"]",
      diff_changed_file_count: 1,
      diff_scope: "index_to_unborn",
      head_ref: "refs/heads/main",
      head_revision: null,
      insertions: 1,
      is_detached: false,
      is_unborn: true,
      staged_change_count: 1,
      working_tree_dirty: true
    });
    expect(evidence.decisive_output.summary).toContain("unborn refs/heads/main");
    expect(validateEvidence(evidence).ok).toBe(true);
  });

  test("keeps the supplied base stable across branch switches", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "main.txt"), "main\n");
    git(repository, "add", "main.txt");
    git(repository, "commit", "-m", "main");
    const mainRevision = revision(repository);
    git(repository, "switch", "-c", "feature");
    writeFileSync(join(repository, "feature.txt"), "feature\n");
    git(repository, "add", "feature.txt");
    git(repository, "commit", "-m", "feature");
    const featureRevision = revision(repository);

    const feature = await createGitEvidenceCollector().collect(fixture(repository, mainRevision));
    expect(feature.decisive_output.facts).toMatchObject({
      base_revision: mainRevision,
      changed_paths_json: "[\"feature.txt\"]",
      head_ref: "refs/heads/feature",
      head_revision: featureRevision,
      revision_changed_from_base: true,
      working_tree_dirty: false
    });

    git(repository, "switch", "main");
    const main = await createGitEvidenceCollector().collect(fixture(repository, mainRevision));
    expect(main.decisive_output.facts).toMatchObject({
      base_revision: mainRevision,
      changed_paths_json: "[]",
      head_ref: "refs/heads/main",
      head_revision: mainRevision,
      revision_changed_from_base: false,
      working_tree_dirty: false
    });
  });

  test("stores an auditable content-addressed manifest instead of truncating many changed paths", async () => {
    const repository = initRepository(true);
    for (let index = 0; index < 100; index += 1) {
      writeFileSync(join(repository, `${String(index).padStart(3, "0")}-${"long-path-".repeat(10)}.txt`), "x\n");
    }
    const input = fixture(repository, revision(repository));
    await expect(createGitEvidenceCollector().collect(input))
      .rejects.toThrow("no artifact store was provided");

    const stateDir = mkdtempSync(join(tmpdir(), "git-evidence-artifacts-"));
    tempDirs.push(stateDir);
    const evidence = await createGitEvidenceCollector({
      artifact_store: new FileSystemGitEvidenceArtifactStore(stateDir)
    }).collect(input);

    expect(evidence.decisive_output.facts).toMatchObject({
      changed_file_details_json: null,
      changed_path_count: 100,
      changed_paths_inline: false,
      changed_paths_json: null,
      working_tree_paths_json: null
    });
    expect(evidence.artifact_refs).toHaveLength(1);
    const artifact = evidence.artifact_refs[0]!;
    expect(artifact).toMatchObject({ kind: "report", media_type: "application/json" });
    const artifactPath = join(stateDir, artifact.ref);
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toMatchObject({
      schema_version: 2,
      changed_files: expect.arrayContaining([expect.objectContaining({ size_bytes: 2 })])
    });
    expect(JSON.parse(readFileSync(artifactPath, "utf8")).changed_paths).toHaveLength(100);
    expect(statSync(artifactPath).mode & 0o777).toBe(0o600);
    expect(validateEvidence(evidence).ok).toBe(true);
  });

  test("does not discover a parent repository or load task-external Git config", async () => {
    const parentRepository = initRepository();
    const nestedTask = join(parentRepository, "nested-task");
    mkdirSync(nestedTask);
    await expect(createGitEvidenceCollector().collect(fixture(nestedTask)))
      .rejects.toThrow("repository_path must point to a Git working tree root");

    const repository = initRepository();
    writeFileSync(join(repository, "tracked.txt"), "safe\n");
    git(repository, "add", "tracked.txt");
    git(repository, "commit", "-m", "safe");
    const sensitiveHome = mkdtempSync(join(tmpdir(), "git-evidence-sensitive-home-"));
    tempDirs.push(sensitiveHome);
    const marker = join(sensitiveHome, "external-config-ran");
    const hook = join(sensitiveHome, "fsmonitor.sh");
    writeFileSync(hook, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o700);
    writeFileSync(join(sensitiveHome, ".gitconfig"), `[core]\n\tfsmonitor = ${hook}\n`);
    const previousHome = process.env.HOME;
    process.env.HOME = sensitiveHome;
    try {
      const evidence = await createGitEvidenceCollector().collect(fixture(repository, revision(repository)));
      expect(evidence.status).toBe("passed");
      expect(existsSync(marker)).toBe(false);
      expect(JSON.stringify(evidence)).not.toContain(sensitiveHome);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
    }
  });
});

function fixture(repositoryPath: string, baseRevision?: string): CollectGitEvidenceInput {
  const runID = makeDomainID("run", "issue_runs", "665:git");
  return {
    ...(baseRevision ? { base_revision: baseRevision } : {}),
    context: {
      attempt_id: makeRunAttemptID(runID, 1),
      audit_event_ref: "issue_events:665:git:snapshot",
      collected_at: COLLECTED_AT,
      evidence_id: makeDomainID("evidence", "git", "665:snapshot"),
      producer: { id: "runner-git-collector", kind: "runner" },
      run_id: runID,
      source_ref: "git-repository:fixture",
      work_id: makeDomainID("work", "issues", 665)
    },
    repository_path: repositoryPath
  };
}

function initRepository(withCommit = false): string {
  const path = mkdtempSync(join(tmpdir(), "git-evidence-fixture-"));
  tempDirs.push(path);
  git(path, "init", "--initial-branch=main");
  if (withCommit) {
    writeFileSync(join(path, ".gitkeep"), "");
    git(path, "add", ".gitkeep");
    git(path, "commit", "-m", "initial fixture");
  }
  return path;
}

function git(repository: string, ...args: string[]): string {
  const result = Bun.spawnSync([
    "git",
    "-c", "user.name=Evidence Fixture",
    "-c", "user.email=evidence-fixture@example.test",
    "-C", repository,
    ...args
  ], {
    env: {
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      PATH: process.env.PATH ?? ""
    },
    stderr: "pipe",
    stdout: "pipe"
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function revision(repository: string): string {
  return git(repository, "rev-parse", "HEAD");
}
