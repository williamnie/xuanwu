import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import {
  ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT,
  issueRunGitDeliveryScope,
  recordIssueRunGitWorkspaceBaseline
} from "./runGitWorkspaceBaseline.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true });
});

describe("Run Git workspace attribution", () => {
  test("selects clean committed files and current-Run untracked artifacts", async () => {
    const fixture = await repositoryFixture();
    try {
      recordBaseline(fixture);
      write(fixture.repository, "src/committed.ts", "export const committed = true;\n");
      git(fixture.repository, ["add", "src/committed.ts"]);
      commit(fixture.repository, "current Work");
      write(fixture.repository, "artifacts/current.json", "{\"current\":true}\n");

      expect(scope(fixture)).toEqual({
        base_revision: fixture.baseRevision,
        pathspecs: ["artifacts/current.json", "src/committed.ts"],
        uncertainty_reasons: []
      });
    } finally {
      fixture.db.close();
    }
  });

  test("excludes pre-existing tracked/untracked changes from a shared dirty tree", async () => {
    const fixture = await repositoryFixture();
    try {
      write(fixture.repository, "shared.txt", "other Work tracked\n");
      write(fixture.repository, "shared-untracked.txt", "other Work untracked\n");
      recordBaseline(fixture);
      write(fixture.repository, "src/current.ts", "export const current = true;\n");
      git(fixture.repository, ["add", "src/current.ts"]);
      commit(fixture.repository, "current Work");

      expect(scope(fixture)).toEqual({
        base_revision: fixture.baseRevision,
        pathspecs: ["src/current.ts"],
        uncertainty_reasons: []
      });
    } finally {
      fixture.db.close();
    }
  });

  test("excludes changed pre-existing paths and reports attribution uncertainty", async () => {
    const fixture = await repositoryFixture();
    try {
      write(fixture.repository, "shared.txt", "other Work baseline dirty\n");
      recordBaseline(fixture);
      write(fixture.repository, "shared.txt", "mixed ownership cannot be proven\n");
      write(fixture.repository, "src/current.ts", "export const current = true;\n");

      const result = scope(fixture);
      expect(result.pathspecs).toEqual(["src/current.ts"]);
      expect(result.uncertainty_reasons).toEqual([
        "Pre-existing workspace paths changed during the Run and were excluded as unattributable: shared.txt"
      ]);
    } finally {
      fixture.db.close();
    }
  });

  test("falls back to committed files with explicit uncertainty when no baseline exists", async () => {
    const fixture = await repositoryFixture();
    try {
      write(fixture.repository, "src/committed.ts", "export const committed = true;\n");
      git(fixture.repository, ["add", "src/committed.ts"]);
      commit(fixture.repository, "committed without workspace baseline");

      const result = scope(fixture);
      expect(result.pathspecs).toEqual(["src/committed.ts"]);
      expect(result.uncertainty_reasons).toEqual([
        "Run workspace baseline is unavailable; only committed paths are attributed and dirty/untracked paths are excluded"
      ]);
    } finally {
      fixture.db.close();
    }
  });

  test("rejects a baseline whose content-addressed snapshot was altered", async () => {
    const fixture = await repositoryFixture();
    try {
      recordBaseline(fixture);
      const row = fixture.db.sqlite.query<{ id: number; payload: string }, [number, string]>(`
        select id, payload from issue_events where issue_id=? and type=? order by id desc limit 1
      `).get(fixture.issueID, ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT);
      if (!row) throw new Error("missing baseline event");
      const altered = JSON.parse(row.payload);
      altered.entries.push({ content_oid: "missing", path: "injected.txt", status: "??" });
      fixture.db.sqlite.run("update issue_events set payload=? where id=?", [JSON.stringify(altered), row.id]);
      write(fixture.repository, "src/committed.ts", "export const committed = true;\n");
      git(fixture.repository, ["add", "src/committed.ts"]);
      commit(fixture.repository, "committed after altered baseline");

      expect(scope(fixture)).toMatchObject({
        pathspecs: ["src/committed.ts"],
        uncertainty_reasons: [
          "Run workspace baseline is unavailable; only committed paths are attributed and dirty/untracked paths are excluded"
        ]
      });
    } finally {
      fixture.db.close();
    }
  });
});

type Fixture = {
  baseRevision: string;
  db: RunnerDatabase;
  issueID: number;
  repository: string;
  runID: string;
};

async function repositoryFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "run-git-attribution-"));
  roots.push(root);
  const repository = join(root, "repository");
  mkdirSync(repository, { recursive: true });
  git(repository, ["init", "-q"]);
  write(repository, "README.md", "baseline\n");
  write(repository, "shared.txt", "shared baseline\n");
  git(repository, ["add", "README.md", "shared.txt"]);
  commit(repository, "baseline");
  const baseRevision = gitText(repository, ["rev-parse", "HEAD"]);
  const db = await openDatabase({ stateDir: join(root, "state") });
  db.sqlite.run(`
    insert into projects (id, name, cwd, provider, created_at, updated_at)
    values ('fixture', 'fixture', ?, 'codex', ?, ?)
  `, [repository, new Date().toISOString(), new Date().toISOString()]);
  db.sqlite.run(`
    insert into issues (project_id, title, status, created_at, updated_at)
    values ('fixture', 'fixture', 'in_progress', ?, ?)
  `, [new Date().toISOString(), new Date().toISOString()]);
  const issueID = db.sqlite.query<{ id: number }, []>("select last_insert_rowid() as id").get()!.id;
  const runID = `issue-${issueID}-attempt-1`;
  db.sqlite.run(`
    insert into issue_runs (id, issue_id, attempt, status, provider, git_base_revision, started_at)
    values (?, ?, 1, 'in_progress', 'codex', ?, ?)
  `, [runID, issueID, baseRevision, new Date().toISOString()]);
  return { baseRevision, db, issueID, repository, runID };
}

function recordBaseline(fixture: Fixture): void {
  recordIssueRunGitWorkspaceBaseline(fixture.db, fixture.issueID, {
    base_revision: fixture.baseRevision,
    captured_at: new Date().toISOString(),
    repository_path: fixture.repository,
    run_id: fixture.runID
  });
  expect(fixture.db.sqlite.query<{ count: number }, [number, string]>(`
    select count(*) as count from issue_events where issue_id=? and type=?
  `).get(fixture.issueID, ISSUE_RUN_GIT_WORKSPACE_BASELINE_EVENT)?.count).toBe(1);
}

function scope(fixture: Fixture) {
  return issueRunGitDeliveryScope(fixture.db, fixture.issueID, {
    base_revision: fixture.baseRevision,
    repository_path: fixture.repository,
    run_id: fixture.runID
  });
}

function write(repository: string, path: string, value: string): void {
  const target = join(repository, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, value);
}

function commit(repository: string, message: string): void {
  git(repository, [
    "-c", "user.name=Runner Test",
    "-c", "user.email=runner@example.invalid",
    "commit", "-qm", message
  ]);
}

function git(repository: string, args: string[]): void {
  execFileSync("git", args, { cwd: repository, stdio: "pipe" });
}

function gitText(repository: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
}
