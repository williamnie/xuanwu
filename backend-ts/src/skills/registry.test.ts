import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkillMetadata, listSkillRegistry, recommendSkillIntents } from "./registry.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI skill registry", () => {
  test("reads skill metadata from SKILL.md front matter", async () => {
    const root = await fixtureRoot();
    const skillPath = await writeSkill(root, "codex-issue-runner", {
      description: "Use when working on runner issues, verification, and commits.",
      name: "codex-issue-runner"
    });

    const skills = listSkillRegistry({ roots: [{ path: join(root, "skills") }] });
    const skill = getSkillMetadata("codex-issue-runner", { roots: [{ path: join(root, "skills") }] });

    expect(skills).toHaveLength(1);
    expect(skill).toMatchObject({
      allowed_roles: expect.arrayContaining(["pi", "executor"]),
      description: "Use when working on runner issues, verification, and commits.",
      id: "codex-issue-runner",
      name: "codex-issue-runner",
      risk_level: "medium",
      source_path: skillPath,
      trigger_rules: expect.stringContaining("runner issues")
    });
  });

  test("recommends skill intents from issue text", async () => {
    const root = await fixtureRoot();
    await writeSkill(root, "codex-issue-runner", {
      description: "Use when working on runner issues, PI automation, verification, and commits.",
      name: "codex-issue-runner"
    });
    await writeSkill(root, "browser", {
      description: "Use when browser UI inspection is required.",
      name: "browser"
    });

    const recommendations = recommendSkillIntents({
      description: "Implement PI automation for a runner issue, then verify and commit.",
      title: "PI OpenClaw runner issue"
    }, { roots: [{ path: join(root, "skills") }] });

    expect(recommendations.map((item) => item.id)).toContain("codex-issue-runner");
    expect(recommendations[0]).toMatchObject({ reason: expect.stringContaining("matched") });
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-skill-registry-"));
  tempRoots.push(root);
  return root;
}

async function writeSkill(root: string, id: string, frontMatter: { description: string; name: string }): Promise<string> {
  const dir = join(root, "skills", id);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(path, [
    "---",
    `name: ${frontMatter.name}`,
    `description: ${frontMatter.description}`,
    "---",
    "",
    "# Skill body"
  ].join("\n"));
  return path;
}
