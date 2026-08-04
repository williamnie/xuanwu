import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getSkillMetadata, listSkillRegistry, readSkillRegistry, recommendSkillIntents } from "./registry.ts";

const FIXTURE_SKILLS = join(import.meta.dir, "../../test-fixtures/pi-skills");
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
    const skillPath = await writeSkill(root, "xuanwu", {
      description: "Use when working on runner issues, verification, and commits.",
      name: "xuanwu"
    });

    const registry = readSkillRegistry({ roots: [{ label: "fixture", path: join(root, "skills") }] });
    const skills = listSkillRegistry({ roots: [{ label: "fixture", path: join(root, "skills") }] });
    const skill = getSkillMetadata("xuanwu", { roots: [{ label: "fixture", path: join(root, "skills") }] });

    expect(registry.diagnostics).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skill).toMatchObject({
      allowed_roles: expect.arrayContaining(["pi", "executor"]),
      description: "Use when working on runner issues, verification, and commits.",
      id: "xuanwu",
      instruction_bytes: expect.any(Number),
      instruction_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      instructions: expect.stringContaining("# Skill body"),
      name: "xuanwu",
      risk_level: "medium",
      source_path: "fixture:xuanwu/SKILL.md",
      trigger_rules: expect.stringContaining("runner issues")
    });
    expect(skill?.version).toMatch(/^sha256:/);
    expect(skill?.source_path).not.toContain(root);
    expect(JSON.stringify(registry)).not.toContain(root);
    expect(skillPath).toContain("SKILL.md");
  });

  test("loads intake and domain runtime manifests from fixture skills", () => {
    const registry = readSkillRegistry({
      availableTools: [
        { name: "source.fetch_context", permission: "read" },
        { name: "issue.create", permission: "write" },
        { name: "issue.status_lookup", permission: "read" },
        { name: "message.reply_draft", permission: "read" }
      ],
      roots: [{ label: "fixture", path: FIXTURE_SKILLS }]
    });

    const byID = new Map(registry.items.map((skill) => [skill.id, skill]));

    expect(registry.diagnostics).toEqual([]);
    expect(byID.get("fixture-intake")).toMatchObject({
      id: "fixture-intake",
      input_object: "context_bundle",
      intent_tags: ["llm-first", "multi-source"],
      kind: "intake",
      output_objects: ["inbox_items", "ignored_groups"],
      primary_intents: ["bug_report", "reply_needed", "other"],
      required_tools: ["source.fetch_context"],
      runtime_manifest_path: "fixture:fixture-intake/manifest.json"
    });
    expect(byID.get("fixture-domain")).toMatchObject({
      id: "fixture-domain",
      input_object: "inbox_item",
      kind: "domain",
      output_objects: ["action_proposals"],
      primary_intents: ["bug_report", "status_question", "reply_needed", "monitor_thread", "other"],
      required_tools: ["issue.create", "issue.status_lookup", "message.reply_draft"],
      runtime_manifest_path: "fixture:fixture-domain/manifest.json"
    });
  });

  test("diagnoses invalid manifests, missing tools, and permission conflicts without blocking registry load", async () => {
    const root = await fixtureRoot();
    await writeManifestSkill(root, "healthy", intakeManifest({ required_tools: ["available.read"] }));
    await writeManifestSkill(root, "bad-schema", { ...intakeManifest(), input_schema: [] });
    await writeManifestSkill(root, "bad-execution", intakeManifest({
      execution: { adapter: "module", handler: "../escape.ts", sandbox: "none", timeout_ms: 0 }
    }));
    await writeManifestSkill(root, "needs-tool", intakeManifest({ required_tools: ["missing.tool"] }));
    await writeManifestSkill(root, "conflict", intakeManifest({
      permissions: { max_tool_permission: "read" },
      required_tools: ["write.tool"]
    }));

    const registry = readSkillRegistry({
      availableTools: [
        { name: "available.read", permission: "read" },
        { name: "write.tool", permission: "write" }
      ],
      roots: [{ label: "fixture", path: join(root, "skills") }]
    });

    expect(registry.items.map((item) => item.id)).toEqual(["bad-execution", "bad-schema", "conflict", "healthy", "needs-tool"]);
    expect(registry.items.find((item) => item.id === "bad-execution")).not.toHaveProperty("kind");
    expect(registry.items.find((item) => item.id === "bad-schema")).not.toHaveProperty("kind");
    expect(registry.items.find((item) => item.id === "healthy")).toMatchObject({ kind: "intake" });
    expect(registry.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "manifest_invalid", source_path: "fixture:bad-schema/manifest.json" }),
      expect.objectContaining({ code: "manifest_invalid", source_path: "fixture:bad-execution/manifest.json" }),
      expect.objectContaining({ code: "missing_tool", source_path: "fixture:needs-tool/manifest.json" }),
      expect.objectContaining({ code: "permission_conflict", source_path: "fixture:conflict/manifest.json" })
    ]));
    expect(JSON.stringify(registry)).not.toContain(root);
  });

  test("recommends skill intents from issue text", async () => {
    const root = await fixtureRoot();
    await writeSkill(root, "xuanwu", {
      description: "Use when working on runner issues, PI automation, verification, and commits.",
      name: "xuanwu"
    });
    await writeSkill(root, "browser", {
      description: "Use when browser UI inspection is required.",
      name: "browser"
    });

    const recommendations = recommendSkillIntents({
      description: "Implement PI automation for a runner issue, then verify and commit.",
      title: "PI OpenClaw runner issue"
    }, { roots: [{ path: join(root, "skills") }] });

    expect(recommendations.map((item) => item.id)).toContain("xuanwu");
    expect(recommendations[0]).toMatchObject({ reason: expect.stringContaining("matched") });
  });

  test("reports bad or missing skill files without leaking absolute roots", async () => {
    const root = await fixtureRoot();
    await writeSkill(root, "healthy", {
      description: "Use when healthy skill metadata should be visible.",
      name: "healthy"
    });
    await mkdir(join(root, "skills", "broken"), { recursive: true });
    await writeFile(join(root, "skills", "broken", "SKILL.md"), "# Missing front matter");

    const registry = readSkillRegistry({
      roots: [
        { label: "fixture", path: join(root, "skills") },
        { label: "missing-fixture", path: join(root, "missing-skills") }
      ]
    });

    expect(registry.items.map((item) => item.id)).toEqual(["healthy"]);
    expect(registry.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "missing_front_matter",
        source_path: "fixture:broken/SKILL.md"
      }),
      expect.objectContaining({
        code: "root_missing",
        source_path: "missing-fixture"
      })
    ]));
    expect(JSON.stringify(registry)).not.toContain(root);
  });

  test("default registry includes repo-local skills", () => {
    const skill = getSkillMetadata("xuanwu");
    const executable = getSkillMetadata("pi-domain-proposal");

    expect(skill).toMatchObject({
      id: "xuanwu",
      source_path: "repo:skills/xuanwu/SKILL.md"
    });
    expect(executable).toMatchObject({
      execution: {
        adapter: "builtin",
        handler: "builtin:pi-domain-proposal",
        sandbox: "capability",
        timeout_ms: 1000
      },
      id: "pi-domain-proposal",
      kind: "domain"
    });
  });

  test("loads canonical runner skills from packaged binary assets", async () => {
    const root = await fixtureRoot();
    await writeManifestSkill(root, "pi-domain-proposal", executableDomainManifest());

    const executable = getSkillMetadata("pi-domain-proposal", {
      roots: [{ label: "runner-package", path: join(root, "skills") }]
    });

    expect(executable).toMatchObject({
      id: "pi-domain-proposal",
      kind: "domain",
      runtime_manifest_path: "runner-package:skills/pi-domain-proposal/manifest.json",
      source_path: "runner-package:skills/pi-domain-proposal/SKILL.md"
    });
  });
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-skill-registry-"));
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

async function writeManifestSkill(root: string, id: string, manifest: Record<string, unknown>): Promise<void> {
  await writeSkill(root, id, {
    description: `Use when ${id} fixture metadata should be visible.`,
    name: id
  });
  await writeFile(join(root, "skills", id, "manifest.json"), JSON.stringify(manifest, null, 2));
}

function intakeManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_object: "context_bundle",
    input_schema: { type: "object" },
    kind: "intake",
    manifest_version: "pi-skill.v0",
    output_objects: ["inbox_items", "ignored_groups"],
    output_schema: { type: "object" },
    permissions: { max_tool_permission: "write" },
    primary_intents: ["bug_report", "other"],
    required_tools: [],
    ...overrides
  };
}

function executableDomainManifest(): Record<string, unknown> {
  return intakeManifest({
    execution: {
      adapter: "builtin",
      handler: "builtin:pi-domain-proposal",
      sandbox: "capability",
      timeout_ms: 1000
    },
    input_object: "inbox_item",
    kind: "domain",
    output_objects: ["action_proposals"]
  });
}
