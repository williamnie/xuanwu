import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listCronTasks } from "../db/repositories/cronTasks.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { listIssues } from "../db/repositories/issues.ts";
import { createPiDelegation, createPiMemoryItem, getPiMemoryItem, listPiActionEvents, listPiActions, listPiMemoryItems } from "../db/repositories/pi.ts";
import { EventBus } from "../events/bus.ts";
import { createPiRuntimeSession } from "./piRuntime.ts";
import { createDefaultRouter } from "./server.ts";

const BASE_URL = "http://127.0.0.1:3008";
const tempRoots: string[] = [];

async function openFixtureDatabase(): Promise<RunnerDatabase> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-runtime-smoke-"));
  tempRoots.push(root);
  return openDatabase({ stateDir: join(root, "state") });
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("Bun PI runtime v1 smoke", () => {
  test("auto-registers local faux provider for preview smoke agent", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ bus: new EventBus(), database });

      const created = await post(router, "/api/pi/conversations", {
        id: "conv-auto-faux",
        project_id: "demo",
        pi_agent_id: "pi-faux"
      });
      const message = await post(router, "/api/pi/conversations/conv-auto-faux/messages", {
        prompt: "Reply ok only"
      });

      expect(created.status).toBe(201);
      expect(message.status).toBe(201);
      expect(await message.json()).toMatchObject({
        conversation_id: "conv-auto-faux",
        status: "completed",
        text: "pi-smoke-response-ok"
      });
    } finally {
      database.close();
    }
  });

  test("runner chat executes issue create and scheduled enqueue through chat tools", async () => {
    const database = await openFixtureDatabase();
    const faux = registerFauxProvider({ api: "pi-smoke-faux-api", provider: "pi-smoke-faux" });
    const bus = new EventBus();
    const events = bus.subscribe();
    try {
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("project_list", {}, { id: "project-list" }),
          fauxToolCall("issue_create_proposal", {
            description: "Follow-up body",
            title: "Follow-up issue"
          }, { id: "issue-proposal" }),
          fauxToolCall("issue_schedule_enqueue", {
            issue_id: 1,
            next_run_at: "2999-01-01T00:00:00.000Z"
          }, { id: "schedule-enqueue" }),
          fauxToolCall("memory_write_candidate", {
            kind: "preference",
            content: "Prefer PI memory candidates before long-term memory"
          }, { id: "memory-candidate" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("smoke done")
      ]);
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);
      const router = createDefaultRouter({ bus, database });

      const created = await post(router, "/api/pi/conversations", {
        id: "conv-smoke",
        project_id: "demo",
        pi_agent_id: "pi-faux"
      });
      const message = await post(router, "/api/pi/conversations/conv-smoke/messages", {
        prompt: "Create one action and one memory candidate"
      });

      expect(created.status).toBe(201);
      expect(message.status).toBe(201);
      expect(await message.json()).toMatchObject({
        conversation_id: "conv-smoke",
        status: "completed",
        text: "smoke done"
      });
      expect(listIssues(database, { projectId: "demo" })).toMatchObject([
        { description: "Follow-up body", status: "triage", title: "Follow-up issue" }
      ]);
      expect(listCronTasks(database)).toMatchObject([
        { action: "enqueue_issues", mode: "once", next_run_at: "2999-01-01T00:00:00.000Z", status: "active" }
      ]);
      expect(JSON.parse(listCronTasks(database)[0]?.action_payload_json ?? "{}")).toEqual({ issue_ids: [1] });
      expect(listPiActions(database, { status: "pending" })).toEqual([]);
      expect(listPiActions(database, { status: "completed" }).map((action) => action.action_type).sort())
        .toEqual(["issue.create", "issue.schedule_enqueue", "memory.write_candidate", "project.list"].sort());
      const candidates = listPiMemoryItems(database, { disabled: 1 });
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        kind: "preference",
        source_id: "conv-smoke",
        source_type: "pi.conversation"
      });
      expect(listPiMemoryItems(database, { disabled: 0 })).toEqual([]);
      expect(getPiMemoryItem(database, candidates[0]?.id ?? "")?.disabled).toBe(1);
      expect(await collectEventTypes(events, 80)).toContain("pi.memory_candidate");
      expect(faux.state.callCount).toBe(2);
    } finally {
      events.close();
      faux.unregister();
      database.close();
    }
  });

  test("assembles PI runtime tools from registry and audits the source", async () => {
    const database = await openFixtureDatabase();
    try {
      writeFauxModelsConfig(database);

      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord(),
        conversationID: "conv-tool-registry",
        project: projectRecord("demo")
      });
      const activeTools = runtime.session.getActiveToolNames();
      runtime.dispose();

      expect(activeTools).toEqual(expect.arrayContaining([
        "read",
        "issue_read",
        "issue_create_proposal",
        "issue_enqueue_proposal",
        "memory_search"
      ]));
      const audit = listPiActionEvents(database, { conversationId: "conv-tool-registry" })
        .find((event) => event.event_type === "runtime_tool_registry_snapshot");
      expect(audit).toBeTruthy();
      const payload = JSON.parse(audit?.payload_json ?? "{}");
      expect(payload).toMatchObject({
        provider_ids: ["runner-builtin"],
        source: "registry"
      });
      expect(payload.tool_names).toEqual(expect.arrayContaining(["read", "issue_enqueue_proposal"]));
      expect(payload.counts.sdk_tools).toBeGreaterThan(0);
      expect(payload.counts.custom_tools).toBeGreaterThan(0);
    } finally {
      database.close();
    }
  });

  test("injects only authorized skill metadata into PI runtime prompt and audits the summary", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo", JSON.stringify({
        allowed: ["codex-issue-runner"],
        recommended: ["codex-issue-runner", "verification-before-completion"]
      }));
      const issue = createIssue(database, {
        project_id: "demo",
        recommended_skill_intents: ["verification-before-completion"],
        required_skill_intents: ["codex-issue-runner"],
        title: "Skill scoped issue"
      });
      createPiDelegation(database, {
        allowed_skill_intents_json: ["codex-issue-runner"],
        id: "delegation-a",
        project_id: "demo"
      });
      createPiMemoryItem(database, {
        confidence: "high",
        content: "Issue-specific PI context",
        id: "issue-memory",
        kind: "issue_memory",
        scope: "issue",
        scope_id: String(issue.id),
        source_id: "turn-1",
        source_type: "conversation"
      });
      createPiMemoryItem(database, {
        content: "Disabled memory should stay hidden",
        disabled: 1,
        id: "disabled-memory",
        kind: "decision",
        scope: "issue",
        scope_id: String(issue.id)
      });
      insertFauxAgent(database);
      writeFauxModelsConfig(database);

      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord(),
        authorization: {
          allowedSkillIntents: ["codex-issue-runner", "verification-before-completion"],
          mode: "delegated"
        },
        conversationID: "conv-skill-context",
        delegationID: "delegation-a",
        issueID: issue.id,
        project: projectRecord("demo")
      });
      const prompt = runtime.session.systemPrompt;
      runtime.dispose();

      expect(prompt).toContain("Relevant Skill Metadata:");
      expect(prompt).toContain("Repo-aware issue proposal workflow:");
      expect(prompt).toContain("repo_search");
      expect(prompt).toContain("repo_context_pack");
      expect(prompt).toContain("issue_create_proposal");
      expect(prompt).toContain("最多追问一个关键问题");
      expect(prompt).toContain('"id": "codex-issue-runner"');
      expect(prompt).not.toContain('"id": "verification-before-completion"');
      expect(prompt).toContain("Issue-specific PI context");
      expect(prompt).toContain("pi_memory_items/issue-memory");
      expect(prompt).not.toContain("Disabled memory should stay hidden");
      const events = listPiActionEvents(database, { conversationId: "conv-skill-context" });
      expect(events.map((event) => event.event_type)).toContain("skill_prompt_context_injected");
      const audit = JSON.parse(events.find((event) => event.event_type === "skill_prompt_context_injected")?.payload_json ?? "{}");
      expect(audit).toMatchObject({
        injected_skill_ids: ["codex-issue-runner"],
        scope: { delegation_id: "delegation-a", issue_id: issue.id, project_id: "demo" },
        unauthorized_skill_intents: ["verification-before-completion"]
      });
      expect(JSON.stringify(audit)).toContain("Create, enqueue, inspect");
    } finally {
      database.close();
    }
  });

  test("injects agent-specific instructions into PI runtime system prompt after core constraints", async () => {
    const database = await openFixtureDatabase();
    try {
      insertProject(database, "demo");
      insertFauxAgent(database);
      writeFauxModelsConfig(database);

      const runtime = await createPiRuntimeSession(database, {
        agent: agentRecord({
          instructions: "自定义 PI 行为：先用中文总结项目风险，再提出最小 action。"
        }),
        conversationID: "conv-agent-instructions",
        project: projectRecord("demo")
      });
      const prompt = runtime.session.systemPrompt;
      runtime.dispose();

      expect(prompt).toContain("Agent-specific runner behavior");
      expect(prompt).toContain("自定义 PI 行为：先用中文总结项目风险，再提出最小 action。");
      expect(prompt.indexOf("Role contract: PI is manager/orchestrator")).toBeLessThan(
        prompt.indexOf("Agent-specific runner behavior")
      );
      expect(prompt).toContain("must not override the core runtime contract");
    } finally {
      database.close();
    }
  });
});

function post(router: ReturnType<typeof createDefaultRouter>, path: string, body: Record<string, unknown>) {
  return router.handle(new Request(`${BASE_URL}${path}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" }
  }));
}

async function collectEventTypes(events: ReturnType<EventBus["subscribe"]>, limit: number): Promise<string[]> {
  const types: string[] = [];
  for (let index = 0; index < limit; index += 1) {
    const event = await nextEvent(events);
    if (!event) break;
    types.push(event.type);
    if (types.includes("pi.memory_candidate")) break;
  }
  return types;
}

async function nextEvent(events: ReturnType<EventBus["subscribe"]>) {
  return await Promise.race([
    events.next(),
    Bun.sleep(20).then(() => undefined)
  ]);
}

function insertFauxAgent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pi-faux", "PI Faux", "pi-smoke-faux", "faux-1", "off", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function agentRecord(patch: Partial<ReturnType<typeof agentRecordBase>> = {}) {
  return { ...agentRecordBase(), ...patch };
}

function agentRecordBase() {
  return {
    id: "pi-faux", name: "PI Faux", provider: "pi-sdk", model_provider: "pi-smoke-faux", model_id: "faux-1",
    thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
  };
}

function projectRecord(id: string) {
  return {
    id, name: id, cwd: `/tmp/${id}`, provider: "codex", provider_config_json: "{}", auto_run: 0,
    model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
    default_service_tier: "",
    sort_order: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    default_mcp_policy: "{}", default_skill_policy: JSON.stringify({
      allowed: ["codex-issue-runner"],
      recommended: ["codex-issue-runner", "verification-before-completion"]
    }),
    loop_status: "stopped", provider_capabilities: []
  };
}

function insertProject(db: RunnerDatabase, id: string, skillPolicy = "{}"): void {
  db.sqlite.run(
    `insert into projects
       (id, name, cwd, provider, provider_config_json, default_skill_policy_json, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, id, `/tmp/${id}`, "codex", '{"capabilities":["issue_execution"]}', skillPolicy, 1,
      "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "pi-smoke-faux": {
        api: "pi-smoke-faux-api",
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
  if (!existsSync(join(agentDir, "models.json"))) throw new Error("models config missing");
}
