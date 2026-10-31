import { expect, test } from "bun:test";
import { getAttentionInboxItem } from "../../db/repositories/intakeRuns.ts";
import { createDefaultRouter } from "../server.ts";
import type { TestFixture } from "./piSkillsApi.testFixture.ts";

export function registerListsSkillsWithDiagnosticsAndCases(testScope: TestFixture) {
  const { BASE_URL, openFixture, writeSkill, writeBadSkill, writeManifestSkill, intakeManifest, domainManifest, mcpDocsServer, seedSkillRunFixture, jsonRequest } = testScope;
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
        expect(listBody.skills.find((skill: { id: string }) => skill.id === "local-fixture")).toMatchObject({
          availability_status: "ready",
          discovery_status: "discovered",
          lifecycle: {
            availability: "ready",
            discovery: "discovered",
            execution: "not_executed",
            load: "not_loaded"
          },
          load_status: "not_loaded"
        });
        expect(listBody.skills.find((skill: { id: string }) => skill.id === "local-fixture")).not.toHaveProperty("instructions");
  
        expect(detail.status).toBe(200);
        await expect(detail.json()).resolves.toMatchObject({
          skill: {
            instruction_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            instructions: expect.stringContaining("name: local-fixture"),
            id: "local-fixture",
            lifecycle: {
              availability: "ready",
              discovery: "discovered",
              execution: "not_executed",
              load: "loaded"
            },
            load_status: "loaded",
            source_path: "codex-home:local-fixture/SKILL.md",
            trigger_rules: expect.stringContaining("local fixture")
          }
        });
      } finally {
        fixture.db.close();
      }
    });
  
  test("binds skill required_tools to MCP tool capability ids", async () => {
      const fixture = await openFixture();
      await writeManifestSkill(fixture.root, "fixture-mcp-domain", domainManifest({
        required_tools: ["docs:tool:search"]
      }));
      Bun.env.CODEX_HOME = fixture.root;
      Bun.env.XUANWU_MCP_REGISTRY_JSON = JSON.stringify({ servers: [mcpDocsServer()] });
      try {
        const router = createDefaultRouter({ database: fixture.db });
        const listed = await router.handle(new Request(`${BASE_URL}/api/pi/skills`));
        const body = await listed.json() as Record<string, any>;
        const skill = body.skills.find((item: Record<string, unknown>) => item.id === "fixture-mcp-domain");
  
        expect(listed.status).toBe(200);
        expect(skill).toMatchObject({
          availability_status: "ready",
          enabled: true,
          required_tools: ["docs:tool:search"],
          resolved_tools: [{
            capability_id: "docs:tool:search",
            grant: "docs:tool:search",
            name: "search",
            permission: "read",
            provider_id: "mcp-docs",
            status: "resolved"
          }],
          runtime_status: "enabled"
        });
        expect(body.diagnostics).not.toEqual(expect.arrayContaining([
          expect.objectContaining({ code: "missing_tool", source_path: "codex-home:fixture-mcp-domain/manifest.json" })
        ]));
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
          availability_status: "blocked",
          executable: true,
          execution: {
            handler: "builtin:pi-domain-proposal",
            sandbox: "capability",
            timeout_ms: 1000
          },
          input_object: "inbox_item",
          kind: "domain",
          missing_capabilities: ["missing.tool"],
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
  
  test("keeps legacy domain manifests visible but refuses execution without an allowlisted handler", async () => {
      const fixture = await openFixture();
      await writeManifestSkill(fixture.root, "manifest-only-domain", domainManifest({ execution: undefined }));
      Bun.env.CODEX_HOME = fixture.root;
      try {
        const router = createDefaultRouter({ database: fixture.db });
        const listed = await jsonRequest(router, "/api/pi/skills") as Record<string, any>;
        const skill = listed.skills.find((item: Record<string, unknown>) => item.id === "manifest-only-domain");
        const response = await router.handle(new Request(`${BASE_URL}/api/pi/skills/manifest-only-domain/domain-runs`, {
          body: JSON.stringify({ item_id: 1 }),
          method: "POST"
        }));
  
        expect(skill).toMatchObject({ enabled: false, executable: false, runtime_status: "manifest_only" });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ message: "domain skill 缺少可执行 runtime" });
      } finally {
        fixture.db.close();
      }
    });
  
  test("exposes isolated handler failures in domain run history without mutating the inbox item", async () => {
      const fixture = await openFixture();
      await writeManifestSkill(fixture.root, "bad-handler", domainManifest({
        execution: { adapter: "builtin", handler: "builtin:not-registered", sandbox: "capability", timeout_ms: 1000 }
      }));
      Bun.env.CODEX_HOME = fixture.root;
      try {
        const seed = seedSkillRunFixture(fixture.db);
        const router = createDefaultRouter({ database: fixture.db });
        const response = await router.handle(new Request(`${BASE_URL}/api/pi/skills/bad-handler/domain-runs`, {
          body: JSON.stringify({ item_id: seed.itemID }),
          method: "POST"
        }));
        const history = await jsonRequest(router, "/api/pi/skills/domain-runs?skill_id=bad-handler") as Array<Record<string, any>>;
  
        expect(response.status).toBe(500);
        expect(history).toEqual([expect.objectContaining({
          item_id: seed.itemID,
          proposal_status: "",
          skill_id: "bad-handler",
          status: "failed"
        })]);
        expect(history[0]?.error).toContain("not allowlisted");
        expect(getAttentionInboxItem(fixture.db, seed.itemID)?.status).toBe("new");
      } finally {
        fixture.db.close();
      }
    });
}
