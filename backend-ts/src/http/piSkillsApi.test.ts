import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const previousCodexHome = Bun.env.CODEX_HOME;
const tempRoots: string[] = [];

afterEach(async () => {
  if (previousCodexHome === undefined) delete Bun.env.CODEX_HOME;
  else Bun.env.CODEX_HOME = previousCodexHome;
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI skill metadata API", () => {
  test("lists skills with diagnostics and reads one skill by id", async () => {
    const fixture = await openFixture();
    await writeSkill(fixture.root, "local-fixture", "Use when local fixture metadata should be visible.");
    await writeBadSkill(fixture.root, "broken");
    Bun.env.CODEX_HOME = fixture.root;
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/skills`));
      const detail = await router.handle(new Request(`${BASE_URL}/api/pi/skills/local-fixture`));

      expect(listed.status).toBe(200);
      const listBody = await listed.json() as Record<string, any>;
      expect(listBody.skills.map((skill: { id: string }) => skill.id)).toContain("local-fixture");
      expect(listBody.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "missing_front_matter", source_path: "codex-home:broken/SKILL.md" })
      ]));
      expect(JSON.stringify(listBody)).not.toContain(fixture.root);

      expect(detail.status).toBe(200);
      await expect(detail.json()).resolves.toMatchObject({
        skill: {
          id: "local-fixture",
          source_path: "codex-home:local-fixture/SKILL.md",
          trigger_rules: expect.stringContaining("local fixture")
        }
      });
    } finally {
      fixture.db.close();
    }
  });

  test("lists intake and domain manifest fields with loader diagnostics", async () => {
    const fixture = await openFixture();
    await writeManifestSkill(fixture.root, "fixture-intake", intakeManifest({ required_tools: ["read"] }));
    await writeManifestSkill(fixture.root, "fixture-domain", domainManifest({ required_tools: ["missing.tool"] }));
    Bun.env.CODEX_HOME = fixture.root;
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const listed = await router.handle(new Request(`${BASE_URL}/api/pi/skills`));

      expect(listed.status).toBe(200);
      const body = await listed.json() as Record<string, any>;
      const byID = new Map(body.skills.map((skill: Record<string, unknown>) => [skill.id, skill]));
      expect(byID.get("fixture-intake")).toMatchObject({
        input_object: "context_bundle",
        kind: "intake",
        output_objects: ["inbox_items", "ignored_groups"]
      });
      expect(byID.get("fixture-domain")).toMatchObject({
        input_object: "inbox_item",
        kind: "domain",
        output_objects: ["action_proposals"]
      });
      expect(body.diagnostics).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "missing_tool", source_path: "codex-home:fixture-domain/manifest.json" })
      ]));
    } finally {
      fixture.db.close();
    }
  });

  test("returns clear 404 for missing skills and has no skill execution route", async () => {
    const fixture = await openFixture();
    await writeSkill(fixture.root, "local-fixture", "Use when local fixture metadata should be visible.");
    Bun.env.CODEX_HOME = fixture.root;
    try {
      const router = createDefaultRouter({ database: fixture.db });
      const missing = await router.handle(new Request(`${BASE_URL}/api/pi/skills/not-found`));
      const post = await router.handle(new Request(`${BASE_URL}/api/pi/skills/local-fixture`, { method: "POST" }));

      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ message: "skill 不存在: not-found" });
      expect(post.status).toBe(405);
      expect(await post.json()).toEqual({ message: "method not allowed" });
    } finally {
      fixture.db.close();
    }
  });
});

async function openFixture(): Promise<{ db: RunnerDatabase; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-pi-skills-api-"));
  tempRoots.push(root);
  return { db: await openDatabase({ stateDir: join(root, "state") }), root };
}

async function writeSkill(root: string, id: string, description: string): Promise<void> {
  const dir = join(root, "skills", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${id}\ndescription: ${description}\n---\n`);
}

async function writeBadSkill(root: string, id: string): Promise<void> {
  const dir = join(root, "skills", id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), "# Missing front matter");
}

async function writeManifestSkill(root: string, id: string, manifest: Record<string, unknown>): Promise<void> {
  await writeSkill(root, id, `Use when ${id} fixture metadata should be visible.`);
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
    permissions: { max_tool_permission: "read" },
    primary_intents: ["bug_report", "other"],
    required_tools: [],
    ...overrides
  };
}

function domainManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    input_object: "inbox_item",
    input_schema: { type: "object" },
    kind: "domain",
    manifest_version: "pi-skill.v0",
    output_objects: ["action_proposals"],
    output_schema: { type: "object" },
    permissions: { max_tool_permission: "write" },
    primary_intents: ["status_question", "other"],
    required_tools: [],
    ...overrides
  };
}
