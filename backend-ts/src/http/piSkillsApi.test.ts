import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { createContextBundle } from "../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun, getAttentionInboxItem } from "../db/repositories/intakeRuns.ts";
import { createPiMemoryItem } from "../db/repositories/pi.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const previousCodexHome = Bun.env.CODEX_HOME;
const previousMcpRegistry = Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;
const tempRoots: string[] = [];

afterEach(async () => {
  if (previousCodexHome === undefined) delete Bun.env.CODEX_HOME;
  else Bun.env.CODEX_HOME = previousCodexHome;
  if (previousMcpRegistry === undefined) delete Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON;
  else Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = previousMcpRegistry;
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
    Bun.env.CODEX_RUNNER_MCP_REGISTRY_JSON = JSON.stringify({ servers: [mcpDocsServer()] });
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

  test("lists intake and domain runs, manual runs, links, and redacted failures", async () => {
    const fixture = await openFixture();
    await writeManifestSkill(fixture.root, "fixture-intake", intakeManifest());
    await writeManifestSkill(fixture.root, "fixture-domain", domainManifest());
    Bun.env.CODEX_HOME = fixture.root;
    try {
      const seed = seedSkillRunFixture(fixture.db);
      const router = createDefaultRouter({ database: fixture.db });

      const intakeRun = await jsonRequest(router, "/api/pi/skills/fixture-intake/intake-runs", {
        body: JSON.stringify({ bundle_id: seed.bundleID }),
        method: "POST"
      });
      expect(intakeRun.run).toMatchObject({
        bundle_id: seed.bundleID,
        input_object: "context_bundle",
        lifecycle: { execution: "running" },
        links: { context_bundle: `/api/pi/attention-inbox/context-bundles/${seed.bundleID}` },
        skill_id: "fixture-intake",
        status: "running"
      });

      const domainRun = await jsonRequest(router, "/api/pi/skills/fixture-domain/domain-runs", {
        body: JSON.stringify({ item_id: seed.itemID }),
        method: "POST"
      });
      expect(domainRun.run).toMatchObject({
        bundle_id: seed.bundleID,
        input_object: "inbox_item",
        item_id: seed.itemID,
        lifecycle: { execution: "executed" },
        links: {
          context_bundle: `/api/pi/attention-inbox/context-bundles/${seed.bundleID}`,
          inbox_item: `/api/pi/attention-inbox/items/${seed.itemID}`
        },
        skill_id: "fixture-domain",
        status: "succeeded"
      });

      const intakeRunsText = await textRequest(router, "/api/pi/skills/intake-runs?status=failed");
      expect(intakeRunsText).toContain("run_failed");
      expect(intakeRunsText).not.toContain("fixture-secret");
      expect(intakeRunsText).not.toContain("/Users/secret");
      const intakeDetailText = await textRequest(router, `/api/pi/attention-inbox/intake-runs/${seed.failedRunID}`);
      expect(intakeDetailText).not.toContain("fixture-secret");
      expect(intakeDetailText).not.toContain("/Users/secret");

      const domainRuns = await jsonRequest(router, "/api/pi/skills/domain-runs?skill_id=fixture-domain");
      expect(domainRuns).toEqual([expect.objectContaining({
        proposal_action_id: domainRun.action.id,
        schema_output: expect.objectContaining({
          action_proposals: expect.any(Array),
          context_retrieval: expect.objectContaining({
            memory_items: [
              expect.objectContaining({ id: "skill-api-inbox-memory", source_path: "pi_memory_items/skill-api-inbox-memory" }),
              expect.objectContaining({ id: "skill-api-source-memory" }),
              expect.objectContaining({ id: "skill-api-skill-memory" }),
              expect.objectContaining({ id: "skill-api-project-memory" })
            ]
          })
        })
      })]);
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
    execution: {
      adapter: "builtin",
      handler: "builtin:pi-domain-proposal",
      sandbox: "capability",
      timeout_ms: 1000
    },
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

function mcpDocsServer(): Record<string, unknown> {
  return {
    id: "docs",
    readiness: "ready",
    status: "enabled",
    tools: [
      { name: "search", description: "Search documentation", permission: "read", risk_level: "low" }
    ]
  };
}

function seedSkillRunFixture(db: RunnerDatabase): { bundleID: number; failedRunID: number; itemID: number } {
  const event = createExternalEvent(db, {
    actor: "alice",
    content: "登录页 500，需要处理",
    external_id: "m1",
    occurred_at: "2026-07-06T02:01:00Z",
    provider: "fixture-provider",
    raw_json: { secret: "raw-secret-not-in-run" },
    received_at: "2026-07-06T02:01:01Z",
    source: "fixture-im"
  });
  const bundle = createContextBundle(db, {
    context: [{
      actor: "alice",
      attachment_refs: [],
      event_ref: event.id,
      occurred_at: event.occurred_at,
      source_ref: "fixture-im:m1",
      summary: "登录页 500，需要处理"
    }],
    created_by: "user",
    event_refs: [event.id],
    reason: "manual fixture",
    source: "fixture-im",
    trigger: "manual",
    window: { from: event.occurred_at, to: event.occurred_at }
  });
  const failed = createIntakeRun(db, {
    bundle_id: bundle.id,
    error: "provider failed CODEX_API_KEY=fixture-secret at /Users/secret/run.log",
    skill_id: "fixture-intake",
    status: "failed"
  });
  const item = createAttentionInboxItem(db, {
    bundle_id: bundle.id,
    confidence: 0.9,
    evidence_refs: [`external_event:${event.id}`],
    intake_run_id: failed.id,
    primary_intent: "bug_report",
    source: "fixture-im",
    suggested_actions: ["triage_attention_item"],
    summary: "用户反馈登录页 500。",
    target_hints: [{ confidence: 0.9, id: "demo", kind: "project", reason: "fixture" }],
    title: "登录页 500"
  });
  seedMemory(db, item.id);
  return { bundleID: bundle.id, failedRunID: failed.id, itemID: item.id };
}

function seedMemory(db: RunnerDatabase, inboxItemID: number): void {
  for (const item of [
    ["skill-api-inbox-memory", "inbox", String(inboxItemID), "Inbox memory injected into domain skill."],
    ["skill-api-source-memory", "source", "fixture-im", "Source memory injected into skill runs."],
    ["skill-api-skill-memory", "skill", "fixture-domain", "Skill memory injected by skill id."],
    ["skill-api-project-memory", "project", "demo", "Project memory injected from target hints."]
  ] as const) {
    createPiMemoryItem(db, {
      content: item[3],
      id: item[0],
      kind: "workflow",
      scope: item[1],
      scope_id: item[2]
    });
  }
}

async function jsonRequest(router: ReturnType<typeof createDefaultRouter>, path: string, init: RequestInit = {}) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`, init));
  expect(response.status).toBeGreaterThanOrEqual(200);
  expect(response.status).toBeLessThan(300);
  return response.json();
}

async function textRequest(router: ReturnType<typeof createDefaultRouter>, path: string) {
  const response = await router.handle(new Request(`${BASE_URL}${path}`));
  expect(response.status).toBe(200);
  return response.text();
}
