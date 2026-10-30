import { afterEach, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createContextBundle } from "../../db/repositories/contextBundles.ts";
import { createExternalEvent } from "../../db/repositories/externalEvents.ts";
import { createAttentionInboxItem, createIntakeRun } from "../../db/repositories/intakeRuns.ts";
import { createPiMemoryItem } from "../../db/repositories/pi.ts";
import { createDefaultRouter } from "../server.ts";



export function createTestFixture() {
  const BASE_URL = "http://127.0.0.1:3008";

  const previousCodexHome = Bun.env.CODEX_HOME;

  const previousMcpRegistry = Bun.env.XUANWU_MCP_REGISTRY_JSON;

  const tempRoots: string[] = [];

  afterEach(async () => {
    if (previousCodexHome === undefined) delete Bun.env.CODEX_HOME;
    else Bun.env.CODEX_HOME = previousCodexHome;
    if (previousMcpRegistry === undefined) delete Bun.env.XUANWU_MCP_REGISTRY_JSON;
    else Bun.env.XUANWU_MCP_REGISTRY_JSON = previousMcpRegistry;
    while (tempRoots.length > 0) {
      const path = tempRoots.pop();
      if (path) await rm(path, { recursive: true, force: true });
    }
  });

  async function openFixture(): Promise<{ db: RunnerDatabase; root: string }> {
    const root = await mkdtemp(join(tmpdir(), "xuanwu-pi-skills-api-"));
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
  return { BASE_URL, previousCodexHome, previousMcpRegistry, tempRoots, openFixture, writeSkill, writeBadSkill, writeManifestSkill, intakeManifest, domainManifest, mcpDocsServer, seedSkillRunFixture, seedMemory, jsonRequest, textRequest };
}
export type TestFixture = ReturnType<typeof createTestFixture>;
