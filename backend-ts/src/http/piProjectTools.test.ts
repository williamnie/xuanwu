import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { listPiActionEvents, listPiActions } from "../db/repositories/pi.ts";
import { createPiRuntimeSession } from "./piRuntime.ts";

const tempRoots: string[] = [];

type Fixture = { db: RunnerDatabase; projectCwd: string };

async function openFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "codex-runner-bun-pi-tools-"));
  const projectCwd = join(root, "project");
  mkdirSync(projectCwd, { recursive: true });
  writeFileSync(join(projectCwd, "README.md"), "# Demo\n");
  tempRoots.push(root);
  return { db: await openDatabase({ stateDir: join(root, "state") }), projectCwd };
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const path = tempRoots.pop();
    if (path) await rm(path, { recursive: true, force: true });
  }
});

describe("PI project tools", () => {
  test("exposes read-only SDK tools and runner action tools", async () => {
    const { db, projectCwd } = await openFixture();
    const faux = registerFauxProvider({ api: "pi-tools-api", provider: "pi-tools" });
    try {
      insertProject(db, "demo", projectCwd);
      insertIssue(db, { projectId: "demo", title: "Todo issue", status: "todo", day: 1 });
      insertIssue(db, { projectId: "demo", title: "Done issue", status: "done", day: 2 });
      insertAgent(db);
      writeFauxModelsConfig(db);
      faux.setResponses([
        fauxAssistantMessage([
          fauxToolCall("project_status", {}, { id: "status" }),
          fauxToolCall("repo_tree", { path: ".", max_depth: 1 }, { id: "repo-tree" }),
          fauxToolCall("repo_search", { query: "Demo", path: "README.md", max_results: 3 }, { id: "repo-search" }),
          fauxToolCall("repo_read_excerpt", { path: "README.md", start_line: 1, max_lines: 2 }, { id: "repo-read" }),
          fauxToolCall("issue_enqueue_proposal", { issue_id: 1, rationale: "ready" }, { id: "enqueue" }),
          fauxToolCall("issue_schedule_enqueue", {
            issue_id: 1,
            next_run_at: "2999-01-01T00:00:00.000Z"
          }, { id: "schedule-enqueue" }),
          fauxToolCall("read", { path: "README.md", limit: 5 }, { id: "read" }),
          fauxToolCall("write", { path: "blocked.txt", content: "must-not-write" }, { id: "write" }),
          fauxToolCall("edit", {
            path: "README.md",
            edits: [{ oldText: "# Demo", newText: "# Mutated" }]
          }, { id: "edit" }),
          fauxToolCall("bash", { command: "echo must-not-run" }, { id: "bash" })
        ], { stopReason: "toolUse" }),
        fauxAssistantMessage("done")
      ]);
      const { probes, runtime } = await runToolProbeSession(db, projectCwd);

      expect(runtime.session.getActiveToolNames().sort()).toEqual([
        "agent_profile_recommend", "executor_issue_create_proposal", "executor_profile_assign_proposal",
        "find", "grep", "issue_comment", "issue_create_proposal", "issue_enqueue_proposal",
        "issue_list", "issue_read", "issue_schedule_enqueue", "issue_state_diagnose", "issue_state_repair_proposal",
"ls", "mcp_capability_read", "mcp_registry_list",
        "mcp_requirement_recommend", "mcp_resource_list", "mcp_resource_read",
        "memory_search", "memory_write_candidate", "needs_user_escalation",
        "project_list", "project_status", "read", "repo_read_excerpt", "repo_search", "repo_tree",
        "report_workflow_request", "review_workflow_request", "session_list",
        "session_read_summary", "session_steer_proposal", "skill_intent_audit",
        "skill_list", "skill_read", "skill_recommend", "verification_workflow_request"
      ]);
      expect(runtime.session.getAllTools().map((tool) => tool.name).sort()).toEqual(runtime.session.getActiveToolNames().sort());
      expect(probes.get("project_status")?.isError).toBe(false);
      expect(probes.get("project_status")?.text).toContain('"total_issues": 2');
      expect(probes.get("project_status")?.text).toContain('"todo": 1');
      expect(probes.get("repo_tree")?.isError).toBe(false);
      expect(probes.get("repo_tree")?.text).toContain('"path": "README.md"');
      expect(probes.get("repo_search")?.isError).toBe(false);
      expect(probes.get("repo_search")?.text).toContain('"path": "README.md"');
      expect(probes.get("repo_read_excerpt")?.isError).toBe(false);
      expect(probes.get("repo_read_excerpt")?.text).toContain('"source": "repo_read_excerpt"');
      expect(probes.get("issue_enqueue_proposal")?.isError).toBe(false);
      expect(probes.get("issue_enqueue_proposal")?.text).toContain('"requires_confirmation": true');
      expect(probes.get("issue_schedule_enqueue")?.isError).toBe(false);
      expect(probes.get("issue_schedule_enqueue")?.text).toContain('"requires_confirmation": true');
      expect(listPiActions(db, { status: "pending" }).map((action) => action.action_type).sort()).toEqual([
        "issue.enqueue",
        "issue.schedule_enqueue"
      ].sort());
      expect(listPiActions(db, { status: "completed" }).map((action) => action.action_type)).toEqual(
        expect.arrayContaining(["repo.tree", "repo.search", "repo.read_excerpt"])
      );
      expect(probes.get("read")?.isError).toBe(false);
      const readAction = listPiActions(db).find((action) => action.action_type === "sdk.read");
      expect(readAction).toMatchObject({
        gate_decision: "execute",
        source: "pi_sdk_tool",
        status: "completed"
      });
      expect(listPiActionEvents(db, { actionId: readAction?.id ?? "" }).map((event) => event.event_type)).toEqual([
        "candidate",
        "gate_decision",
        "execution_started",
        "execution_result"
      ]);
      expect(probes.get("write")?.isError).toBe(true);
      expect(probes.get("write")?.text).toContain("Tool write not found");
      expect(probes.get("edit")?.isError).toBe(true);
      expect(probes.get("edit")?.text).toContain("Tool edit not found");
      expect(probes.get("bash")?.isError).toBe(true);
      expect(probes.get("bash")?.text).toContain("Tool bash not found");
      expect(existsSync(join(projectCwd, "blocked.txt"))).toBe(false);
      expect(readFileSync(join(projectCwd, "README.md"), "utf8")).toBe("# Demo\n");
    } finally {
      faux.unregister();
      db.close();
    }
  });

  test("global Runner tool calls do not fail when project_id is omitted", async () => {
    const { db, projectCwd } = await openFixture();
    const faux = registerFauxProvider({ api: "pi-global-tools-api", provider: "pi-global-tools" });
    try {
      insertProject(db, "demo", projectCwd);
      insertAgent(db, { api: "pi-global-tools", provider: "pi-global-tools" });
      writeFauxModelsConfig(db, { api: "pi-global-tools-api", provider: "pi-global-tools" });
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall("project_status", {}, { id: "global-status" })], { stopReason: "toolUse" }),
        fauxAssistantMessage("done")
      ]);
      const runtime = await createPiRuntimeSession(db, {
        agent: agentRecord({ model_provider: "pi-global-tools" }),
        conversationID: "conv-global-tools"
      });
      const probes = new Map<string, { isError: boolean; text: string }>();
      const unsubscribe = runtime.session.subscribe((event) => {
        if (event.type !== "tool_execution_end") return;
        probes.set(event.toolName, { isError: event.isError, text: collectText(event.result.content) });
      });

      await runtime.session.prompt("Check global status", { expandPromptTemplates: false, source: "rpc" });
      unsubscribe();
      runtime.dispose();

      expect(probes.get("project_status")?.isError).toBe(false);
      expect(probes.get("project_status")?.text).toContain('"items"');
      expect(probes.get("project_status")?.text).toContain('"demo"');
    } finally {
      faux.unregister();
      db.close();
    }
  });

});

function agentRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "pi-faux", name: "PI Faux", provider: "pi-sdk", model_provider: "pi-tools", model_id: "faux-1",
    thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    ...overrides
  };
}

function projectRecord(cwd: string) {
  return {
    id: "demo", name: "Demo", cwd, provider: "codex", provider_config_json: "{}", auto_run: 0,
    model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
    sort_order: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    default_mcp_policy: "{}", default_skill_policy: "{}", loop_status: "stopped", provider_capabilities: []
  };
}

async function runToolProbeSession(db: RunnerDatabase, projectCwd: string) {
  const runtime = await createPiRuntimeSession(db, {
    agent: agentRecord(),
    conversationID: "conv-tools",
    project: projectRecord(projectCwd)
  });
  const probes = new Map<string, { isError: boolean; text: string }>();
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type !== "tool_execution_end") return;
    probes.set(event.toolName, { isError: event.isError, text: collectText(event.result.content) });
  });
  await runtime.session.prompt("Check project tools", { expandPromptTemplates: false, source: "rpc" });
  unsubscribe();
  runtime.dispose();
  return { probes, runtime };
}

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "object" && block && "text" in block && typeof block.text === "string") return block.text;
    return "";
  }).join("\n");
}

function insertAgent(db: RunnerDatabase, overrides: { api?: string; provider?: string } = {}): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pi-faux", "PI Faux", overrides.provider ?? "pi-tools", "faux-1", "off", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertProject(db: RunnerDatabase, id: string, cwd: string): void {
  db.sqlite.run(
    `insert into projects (id, name, cwd, sort_order, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?)`,
    [id, id, cwd, 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
  );
}

function insertIssue(db: RunnerDatabase, issue: { day: number; projectId: string; status: string; title: string }): void {
  const timestamp = `2026-01-${String(issue.day).padStart(2, "0")}T00:00:00Z`;
  db.sqlite.run(
    `insert into issues (project_id, title, status, created_at, updated_at) values (?, ?, ?, ?, ?)`,
    [issue.projectId, issue.title, issue.status, timestamp, timestamp]
  );
}

function writeFauxModelsConfig(db: RunnerDatabase, overrides: { api?: string; provider?: string } = {}): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  const provider = overrides.provider ?? "pi-tools";
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [provider]: {
        api: overrides.api ?? "pi-tools-api",
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
}
