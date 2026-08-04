import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSmokeRuntime, resolveDefaultRepoRoot } from "../spikes/piSmokeSupport.ts";
import { createControlledPiResourceLoader } from "./piRuntimeResources.ts";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("controlled PI runtime resources", () => {
  test("loads an empty resource fixture without weakening the core prompt", async () => {
    const fixture = await fixtureRoot();
    const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot());
    const loader = await createControlledPiResourceLoader(sdk, {
      agentDir: join(fixture, "agent"),
      allowedSkillIDs: [],
      cwd: join(fixture, "project"),
      runtimeRoot: join(fixture, "runtime"),
      systemPrompt: "fixture core prompt"
    });

    expect(loader.snapshot()).toMatchObject({
      counts: { agents: 0, diagnostics: 0, extensions: 0, prompts: 0, skills: 0 },
      loaded: { agents: [], extensions: [], prompts: [], skills: [] },
      outcome: "loaded",
      sources: []
    });
    expect(loader.getSystemPrompt()).toBe("fixture core prompt");
    expect(loader.getAppendSystemPrompt().join("\n")).toContain("Controlled Supervisor resource summary:");
  });

  test("loads allowlisted resources, isolates bad files, and refreshes on reload", async () => {
    const fixture = await fixtureRoot();
    const project = join(fixture, "project");
    const runtime = join(fixture, "runtime");
    const agentDir = join(fixture, "agent");
    const piPackage = join(fixture, "pi-package");
    await write(join(project, "AGENTS.md"), "# Project agent\nKeep changes scoped.\n");
    await writeSkill(runtime, "healthy-skill", "Healthy controlled skill.");
    await writeSkill(runtime, "blocked-skill", "Must be removed by the skill allowlist.");
    await writeSkill(piPackage, "package-skill", "Skill staged with PI package assets.");
    await write(join(runtime, "skills", "bad-skill", "SKILL.md"), "---\nname: bad-skill\n---\n# Missing description\n");
    await write(join(project, ".pi", "prompts", "investigate.md"), "---\ndescription: Investigate safely\n---\nInspect evidence first.\n");
    await write(join(runtime, "plugins", "fixture-plugin", "prompts", "plugin-status.md"), "---\ndescription: Plugin status\n---\nRead plugin status.\n");
    await write(join(project, ".pi", "extensions", "healthy.ts"), [
      "export default function fixture(pi: any) {",
      "  pi.on('agent_start', () => undefined);",
      "  pi.registerTool({ name: 'fixture_write', label: 'Fixture write', description: 'Must stay blocked', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [], details: {} }) });",
      "}"
    ].join("\n"));
    await write(join(project, ".pi", "extensions", "bad.ts"), "export default function broken( {\n");

    const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot());
    const snapshots: Array<ReturnType<Awaited<ReturnType<typeof createControlledPiResourceLoader>>["snapshot"]>> = [];
    const loader = await createControlledPiResourceLoader(sdk, {
      agentDir,
      allowedSkillIDs: ["healthy-skill", "bad-skill", "package-skill"],
      cwd: project,
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      piPackageDir: piPackage,
      runtimeRoot: runtime,
      systemPrompt: "fixture core prompt"
    });

    const first = loader.snapshot();
    expect(first).toMatchObject({
      counts: { agents: 1, extensions: 1, prompts: 2, skills: 2 },
      loaded: {
        agents: ["project-agent:AGENTS.md"],
        extensions: ["project:healthy.ts"],
        prompts: ["investigate", "plugin-status"],
        skills: ["healthy-skill", "package-skill"]
      },
      outcome: "loaded",
      sources: ["builtin", "pi-package", "plugin:fixture-plugin", "project"]
    });
    expect(first.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "extension_parse_failed", source_path: "project:bad.ts" }),
      expect.objectContaining({ code: "extension_tools_blocked", source_path: "project:healthy.ts" }),
      expect.objectContaining({ code: "skill_not_allowlisted", source_path: "builtin:blocked-skill/SKILL.md" }),
      expect.objectContaining({ code: "skill_warning", source_path: "builtin:bad-skill/SKILL.md" })
    ]));
    expect(JSON.stringify(first)).not.toContain(fixture);
    expect(loader.getExtensions().extensions[0]?.tools.size).toBe(0);
    expect(loader.getAppendSystemPrompt().join("\n")).toContain("skills: 2 (healthy-skill, package-skill)");

    loader.extendResources({
      skillPaths: [{
        path: join(fixture, "outside", "SKILL.md"),
        metadata: { origin: "top-level", scope: "temporary", source: "fixture" }
      }]
    });
    expect(loader.snapshot().diagnostics).toContainEqual(expect.objectContaining({ code: "skill_not_allowlisted" }));

    await write(join(project, ".pi", "prompts", "status.md"), "---\ndescription: Status safely\n---\nRead authoritative status.\n");
    await loader.reload();
    expect(loader.snapshot()).toMatchObject({
      generation: 2,
      loaded: { prompts: ["investigate", "plugin-status", "status"] },
      outcome: "loaded"
    });
    expect(snapshots.length).toBeGreaterThanOrEqual(3);
  });

  test("rejects project and plugin symlink escapes", async () => {
    const fixture = await fixtureRoot();
    const project = join(fixture, "project");
    const runtime = join(fixture, "runtime");
    const outside = join(fixture, "outside");
    await writeSkill(outside, "escaped-skill", "Must stay outside the resource allowlist.");
    await mkdir(join(project, ".pi"), { recursive: true });
    await symlink(join(outside, "skills"), join(project, ".pi", "skills"));
    await mkdir(join(runtime, "plugins"), { recursive: true });
    await symlink(outside, join(runtime, "plugins", "escaped-plugin"));

    const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot());
    const loader = await createControlledPiResourceLoader(sdk, {
      agentDir: join(fixture, "agent"),
      allowedSkillIDs: ["escaped-skill"],
      cwd: project,
      runtimeRoot: runtime,
      systemPrompt: "fixture core prompt"
    });

    expect(loader.snapshot().loaded.skills).toEqual([]);
    expect(loader.snapshot().diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "skill_not_allowlisted" }),
      expect.objectContaining({ code: "loader_not_allowlisted" })
    ]));
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-resources-"));
  tempRoots.push(root);
  return root;
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

async function writeSkill(root: string, id: string, description: string): Promise<void> {
  await write(join(root, "skills", id, "SKILL.md"), [
    "---",
    `name: ${id}`,
    `description: ${description}`,
    "---",
    "",
    `# ${id}`
  ].join("\n"));
}
