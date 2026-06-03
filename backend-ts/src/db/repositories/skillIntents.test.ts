import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../database.ts";
import { createIssue } from "./issueCreate.ts";
import { updateIssue } from "./issueUpdate.ts";
import { createPiDelegation, getPiDelegation, updatePiDelegation } from "./pi.ts";
import { createProject } from "./projects.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("skill intent persistence", () => {
  test("saves project default policy and issue required/recommended intents", async () => {
    const { cwd, db } = await openFixture();
    try {
      const project = createProject(db, {
        cwd,
        default_skill_policy: {
          allowed: ["codex-issue-runner", "verification-before-completion"],
          recommended: ["verification-before-completion"],
          required: ["codex-issue-runner"]
        },
        id: "demo"
      });
      const issue = createIssue(db, {
        project_id: project.id,
        recommended_skill_intents: "verification-before-completion",
        required_skill_intents: ["codex-issue-runner"],
        title: "Skill issue"
      });
      const patched = updateIssue(db, issue.id, {
        recommended_skill_intents: ["browser:control-in-app-browser"]
      });
      const delegation = createPiDelegation(db, {
        allowed_skill_intents_json: ["codex-issue-runner", "browser:control-in-app-browser"],
        id: "delegation-a",
        project_id: project.id
      });
      const patchedDelegation = updatePiDelegation(db, "delegation-a", {
        allowed_skill_intents_json: "verification-before-completion"
      });

      expect(JSON.parse(project.default_skill_policy)).toEqual({
        allowed: ["codex-issue-runner", "verification-before-completion"],
        recommended: ["verification-before-completion"],
        required: ["codex-issue-runner"]
      });
      expect(JSON.parse(issue.required_skill_intents)).toEqual(["codex-issue-runner"]);
      expect(JSON.parse(issue.recommended_skill_intents)).toEqual(["verification-before-completion"]);
      expect(JSON.parse(patched.recommended_skill_intents)).toEqual(["browser:control-in-app-browser"]);
      expect(JSON.parse(delegation.allowed_skill_intents_json)).toEqual(["codex-issue-runner", "browser:control-in-app-browser"]);
      expect(JSON.parse(patchedDelegation.allowed_skill_intents_json)).toEqual(["verification-before-completion"]);
      expect(getPiDelegation(db, "delegation-a")).toMatchObject(patchedDelegation);
    } finally {
      db.close();
    }
  });

  test("rejects malformed skill intent ids before persistence", async () => {
    const { cwd, db } = await openFixture();
    try {
      const project = createProject(db, { cwd, id: "demo" });
      const badCwd = join(cwd, "..", "other-project");
      await mkdir(badCwd, { recursive: true });
      expect(() => createIssue(db, {
        project_id: project.id,
        required_skill_intents: ["not a skill"],
        title: "Invalid skill"
      })).toThrow("skill id 不合法: not a skill");
      expect(() => createProject(db, {
        cwd: badCwd,
        default_skill_policy: { allowed: ["bad!skill"] },
        id: "other"
      })).toThrow("skill id 不合法: bad!skill");
      expect(() => createPiDelegation(db, {
        allowed_skill_intents_json: ["bad skill"],
        id: "delegation-b",
        project_id: project.id
      })).toThrow("skill id 不合法: bad skill");
    } finally {
      db.close();
    }
  });
});

async function openFixture(): Promise<{ cwd: string; db: RunnerDatabase }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-skill-intents-"));
  tempRoots.push(root);
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  return { cwd, db: await openDatabase({ stateDir: join(root, "state") }) };
}
