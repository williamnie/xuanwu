import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeDomainID } from "../../xuanwu/coreDomainContracts.ts";
import { createGitEvidenceCollector } from "../evidence/gitCollector.ts";
import { createLocalGitAdapter } from "../git/adapter.ts";
import {
  createLocalBranchCommitHandoffService,
  resolveLocalGitHandoffProjectPolicy,
  type LocalBranchCommitHandoffRequest,
  type LocalGitHandoffAuditEvent,
  type LocalGitHandoffAuditSink,
  type LocalGitHandoffProjectPolicy
} from "./localBranchCommit.ts";

const NOW = "2026-07-16T14:00:00.000Z";
const WORK_ID = makeDomainID("work", "issues", 674);
const RUN_ID = makeDomainID("run", "issue_runs", "674:1");
const EVIDENCE_ID = makeDomainID("evidence", "git", "674:local-commit");
const ADR_PATH = join(import.meta.dir, "../../../../docs/architecture/xuanwu/0038-local-branch-commit-handoff.md");
const tempDirs: string[] = [];

afterEach(() => {
  for (const path of tempDirs.splice(0)) rmSync(path, { force: true, recursive: true });
});

describe("local Branch / Commit Handoff", () => {
  test("creates a scoped branch commit while preserving the active dirty worktree and index byte-for-byte", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "selected.txt"), "selected change\n");
    writeFileSync(join(repository, "staged.txt"), "pre-existing staged change\n");
    git(repository, "add", "staged.txt");
    writeFileSync(join(repository, "dirty.txt"), "unrelated dirty change\n");
    writeFileSync(join(repository, "untracked.txt"), "unrelated untracked change\n");
    const statusBefore = gitBytes(repository, "status", "--porcelain=v1", "-z", "--untracked-files=all");
    const indexTreeBefore = git(repository, "write-tree");
    const audit = auditSink();

    const result = await service(audit).execute(request(repository));

    expect(result).toMatchObject({
      branch_created: true,
      branch_ref: "refs/heads/xw/674-local-branch-commit",
      handoff: {
        baseline_revision: revision(repository, "main"),
        changed_files: ["selected.txt"],
        delivery: {
          mode: "branch_commit",
          branch_ref: "refs/heads/xw/674-local-branch-commit"
        },
        evidence_ids: [EVIDENCE_ID],
        final_revision: expect.stringMatching(/^[a-f0-9]{40}$/),
        status: "ready"
      }
    });
    expect(result.commit_revision).toBe(revision(repository, "xw/674-local-branch-commit"));
    expect(git(repository, "branch", "--show-current")).toBe("main");
    expect(gitBytes(repository, "status", "--porcelain=v1", "-z", "--untracked-files=all")).toEqual(statusBefore);
    expect(git(repository, "write-tree")).toBe(indexTreeBefore);
    expect(git(repository, "diff-tree", "--no-commit-id", "--name-only", "-r", result.commit_revision))
      .toBe("selected.txt");
    expect(git(repository, "show", `${result.commit_revision}:selected.txt`)).toBe("selected change");
    expect(git(repository, "show", `${result.commit_revision}:staged.txt`)).toBe("base staged");
    expect(git(repository, "show", "-s", "--format=%s", result.commit_revision))
      .toBe("feat(handoff): create local branch commit");
    expect(git(repository, "show", "-s", "--format=%an <%ae>", result.commit_revision))
      .toBe("Xuanwu Runner <xuanwu@example.test>");
    expect(revision(repository, `${result.commit_revision}^`)).toBe(result.handoff.baseline_revision);
    expect(result.git_evidence.provenance.audit_event_ref).toBe("issue_events:674:handoff:intent");
    expect(result.git_evidence.decisive_output.facts).toMatchObject({
      pathspec_count: 1,
      pathspec_scope: "selected_paths",
      pathspec_sha256: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(result.diff_summary.source_evidence_id).toBe(EVIDENCE_ID);
    expect(audit.events.map((event) => event.event_type)).toEqual([
      "handoff.local_git.intent.v1",
      "handoff.local_git.outcome.v1"
    ]);
    expect(audit.events[1]?.facts).toMatchObject({
      commit_revision: result.commit_revision,
      status: "succeeded",
      tree_verified: true
    });
  });

  test("reuses an existing policy branch only when it still points at the exact baseline", async () => {
    const repository = initRepository();
    git(repository, "branch", "xw/674-reuse-existing-branch");
    writeFileSync(join(repository, "selected.txt"), "reuse change\n");
    const audit = auditSink();

    const result = await service(audit).execute(request(repository, {
      work_title: "Reuse existing branch"
    }));

    expect(result.branch_created).toBe(false);
    expect(result.branch_ref).toBe("refs/heads/xw/674-reuse-existing-branch");
    expect(revision(repository, "xw/674-reuse-existing-branch")).toBe(result.commit_revision);
    expect(revision(repository, "main")).toBe(result.handoff.baseline_revision);
  });

  test("fails closed before mutation when current project policy does not allow commit Handoffs", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "selected.txt"), "policy denied\n");
    const audit = auditSink();
    const deniedPolicy = policy({ allowed_actions_json: "[]" });

    await expect(service(audit, deniedPolicy).execute(request(repository)))
      .rejects.toThrow("project policy does not allow handoff.commit");
    expect(audit.events).toEqual([]);
    expect(git(repository, "branch", "--list", "xw/674-local-branch-commit")).toBe("");
  });

  test("records a failed outcome and leaves no branch or staged side effect when commit creation fails", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "selected.txt"), "will fail\n");
    writeFileSync(join(repository, "dirty.txt"), "keep me\n");
    git(repository, "add", "dirty.txt");
    const statusBefore = gitBytes(repository, "status", "--porcelain=v1", "-z", "--untracked-files=all");
    const wrapper = failingGitWrapper();
    const adapter = createLocalGitAdapter({ git_binary: wrapper });
    const audit = auditSink();
    const runner = createLocalBranchCommitHandoffService({
      audit_sink: audit,
      git_adapter: adapter,
      git_evidence_collector: createGitEvidenceCollector({ git_binary: wrapper }),
      now: () => NOW,
      project_policy_reader: { read: () => policy() }
    });

    await expect(runner.execute(request(repository))).rejects.toThrow("git commit-tree failed with exit 42");
    expect(git(repository, "branch", "--list", "xw/674-local-branch-commit")).toBe("");
    expect(gitBytes(repository, "status", "--porcelain=v1", "-z", "--untracked-files=all")).toEqual(statusBefore);
    expect(audit.events.map((event) => event.event_type)).toEqual([
      "handoff.local_git.intent.v1",
      "handoff.local_git.outcome.v1"
    ]);
    expect(audit.events[1]?.facts).toMatchObject({ status: "failed" });
    expect(String(audit.events[1]?.facts.error)).not.toContain("fixture-secret");
  });

  test("CAS-deletes a newly created branch when the required success audit cannot be recorded", async () => {
    const repository = initRepository();
    writeFileSync(join(repository, "selected.txt"), "audit failure\n");
    const events: LocalGitHandoffAuditEvent[] = [];
    const audit: LocalGitHandoffAuditSink = {
      record(event) {
        if (event.event_type === "handoff.local_git.outcome.v1" && event.facts.status === "succeeded") {
          throw new Error("audit store unavailable");
        }
        events.push(event);
      }
    };

    await expect(service(audit).execute(request(repository))).rejects.toThrow("audit store unavailable");
    expect(git(repository, "branch", "--list", "xw/674-local-branch-commit")).toBe("");
    expect(events.map((event) => event.event_type)).toEqual([
      "handoff.local_git.intent.v1",
      "handoff.local_git.rollback.v1"
    ]);
    expect(events[1]?.facts).toMatchObject({ rollback_status: "succeeded" });
  });

  test("documents authority, compatibility window, rollback, and final deletion gates", () => {
    const adr = readFileSync(ADR_PATH, "utf8");
    expect(adr).toContain("Git repository 继续是 branch、tree、commit 和 diff 的唯一 source of truth");
    expect(adr).toContain("本期双写窗口：** 0");
    expect(adr).toContain("target branch 不自动 checkout");
    expect(adr).toContain("handoff.local_git.rollback.v1");
    expect(adr).toContain("最终删除门禁");
  });
});

function service(audit: LocalGitHandoffAuditSink, projectPolicy: LocalGitHandoffProjectPolicy = policy()) {
  return createLocalBranchCommitHandoffService({
    audit_sink: audit,
    now: () => NOW,
    project_policy_reader: { read: () => projectPolicy }
  });
}

function request(
  repositoryPath: string,
  overrides: Partial<LocalBranchCommitHandoffRequest> = {}
): LocalBranchCommitHandoffRequest {
  return {
    audit: {
      actor: { id: "runner:issue-674", kind: "runner" },
      correlation_id: "issue-674-local-handoff",
      intent_event_id: "issue_events:674:handoff:intent",
      outcome_event_id: "issue_events:674:handoff:outcome",
      rollback_event_id: "issue_events:674:handoff:rollback"
    },
    commit_message: "feat(handoff): create local branch commit",
    git_evidence: {
      evidence_id: EVIDENCE_ID,
      producer: { id: "runner:issue-674", kind: "runner" },
      run_id: RUN_ID
    },
    linked_evidence: [],
    project_id: "fixture",
    repository_path: repositoryPath,
    repository_ref: "git-repository:fixture",
    run_ids: [RUN_ID],
    runs: [{ id: RUN_ID, work_id: WORK_ID }],
    selected_paths: ["selected.txt"],
    work_id: WORK_ID,
    work_title: "Local branch commit",
    ...overrides
  };
}

function policy(
  overrides: Partial<Omit<Parameters<typeof resolveLocalGitHandoffProjectPolicy>[0], "allowed_actions_json">> & {
    allowed_actions_json?: string;
  } = {}
): LocalGitHandoffProjectPolicy {
  return resolveLocalGitHandoffProjectPolicy({
    allowed_actions_json: '["handoff.commit"]',
    allowed_base_branches: ["main"],
    branch_prefix: "xw/",
    branch_reuse: "same_baseline",
    commit_identity: { name: "Xuanwu Runner", email: "xuanwu@example.test" },
    commit_subject_prefixes: ["feat(handoff):"],
    max_commit_subject_length: 120,
    policy_ref: "project-policy:fixture:handoff-local-git@1",
    project_id: "fixture",
    ...overrides
  });
}

function auditSink(): LocalGitHandoffAuditSink & { events: LocalGitHandoffAuditEvent[] } {
  const events: LocalGitHandoffAuditEvent[] = [];
  return { events, record: (event) => { events.push(event); } };
}

function initRepository(): string {
  const path = mkdtempSync(join(tmpdir(), "xw-local-handoff-fixture-"));
  tempDirs.push(path);
  git(path, "init", "--initial-branch=main");
  writeFileSync(join(path, "selected.txt"), "base selected\n");
  writeFileSync(join(path, "staged.txt"), "base staged\n");
  writeFileSync(join(path, "dirty.txt"), "base dirty\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "initial fixture");
  return path;
}

function failingGitWrapper(): string {
  const root = mkdtempSync(join(tmpdir(), "xw-local-handoff-git-wrapper-"));
  tempDirs.push(root);
  const path = join(root, "git-fail-commit-tree");
  const gitBinary = gitCommandPath();
  writeFileSync(path, `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "commit-tree" ]; then\n` +
    `    echo "forced commit failure token=fixture-secret" >&2\n    exit 42\n  fi\ndone\nexec "${gitBinary}" "$@"\n`);
  chmodSync(path, 0o700);
  return path;
}

function gitCommandPath(): string {
  const result = Bun.spawnSync(["sh", "-c", "command -v git"], { stderr: "pipe", stdout: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function git(repository: string, ...args: string[]): string {
  return gitBytes(repository, ...args).toString("utf8").trim();
}

function gitBytes(repository: string, ...args: string[]): Buffer {
  const result = Bun.spawnSync([
    "git",
    "-c", "user.name=Handoff Fixture",
    "-c", "user.email=handoff-fixture@example.test",
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
  return Buffer.from(result.stdout);
}

function revision(repository: string, ref: string): string {
  return git(repository, "rev-parse", ref);
}
