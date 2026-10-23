import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createProject } from "../../db/repositories/projects.ts";
import { createDefaultRouter } from "../server.ts";

const fixtures: { root: string; db: RunnerDatabase }[] = [];
afterEach(async () => {
  for (const { root, db } of fixtures.splice(0)) {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-path-check-"));
  const db = await openDatabase({ stateDir: join(root, "state") });
  fixtures.push({ root, db });
  const router = createDefaultRouter({ database: db });
  const check = (cwd?: string) => router.handle(new Request(`http://localhost/api/projects/path-check${cwd === undefined ? "" : `?${new URLSearchParams({ cwd })}`}`));
  return { root, db, check };
}

test("path check rejects missing, relative, home shorthand and null-byte paths", async () => {
  const { check } = await fixture();
  for (const cwd of [undefined, "", " ", "relative/repo", "~/repo", "/tmp/\0repo"]) {
    const response = await check(cwd);
    expect(response.status).toBe(400);
  }
});

test("path check distinguishes missing paths, files and directories without Git", async () => {
  const { root, check } = await fixture();
  const file = join(root, "plain-file");
  await writeFile(file, "read only");
  for (const [path, exists, directory] of [[join(root, "missing"), false, false], [file, true, false], [root, true, true]] as const) {
    const response = await check(path);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ exists, directory, git_repo: false, existing_project_id: null });
  }
});

test("path check uses only .git metadata, including linked-worktree files", async () => {
  const { root, check } = await fixture();
  const repository = join(root, "Repo With Spaces");
  const worktree = join(root, "linked");
  await mkdir(join(repository, ".git"), { recursive: true });
  await mkdir(worktree);
  // An intentionally non-functional repository proves no Git command is needed.
  await writeFile(join(worktree, ".git"), "gitdir: /unavailable/worktree/metadata\n");
  for (const path of [repository, worktree]) {
    expect(await (await check(path)).json()).toMatchObject({ exists: true, directory: true, git_repo: true });
  }
  expect(await (await check(repository)).json()).toMatchObject({ suggested_id: "repo-with-spaces" });
});

test("path check resolves existing cwd and collision-free IDs without any database or audit writes", async () => {
  const { root, db, check } = await fixture();
  const existing = join(root, "existing");
  const candidate = join(root, "another", "existing");
  await mkdir(existing);
  await mkdir(candidate, { recursive: true });
  createProject(db, { id: "existing", cwd: existing });
  const before = db.sqlite.query("select total_changes() as changes").get();
  // Any write, including an audit insert, must fail during these requests.
  db.sqlite.exec("PRAGMA query_only = ON");
  expect(await (await check(`${existing}/../existing/`)).json()).toMatchObject({ existing_project_id: "existing", suggested_id: "existing" });
  const first = await (await check(candidate)).json() as { suggested_id: string };
  expect(first.suggested_id).toMatch(/^existing-[a-f0-9]{8}$/);
  expect(await (await check(candidate)).json()).toMatchObject({ suggested_id: first.suggested_id, existing_project_id: null });
  expect(db.sqlite.query("select total_changes() as changes").get()).toEqual(before);
  expect(db.sqlite.query("select count(*) as count from projects").get()).toEqual({ count: 1 });
});
