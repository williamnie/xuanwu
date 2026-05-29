import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
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

describe("PI read-only project tools", () => {
  test("exposes project.status and read-only SDK tools only", async () => {
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
          fauxToolCall("project.status", {}, { id: "status" }),
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
        "find", "grep", "ls", "project.status", "read"
      ]);
      expect(runtime.session.getAllTools().map((tool) => tool.name).sort()).toEqual([
        "find", "grep", "ls", "project.status", "read"
      ]);
      expect(probes.get("project.status")?.isError).toBe(false);
      expect(probes.get("project.status")?.text).toContain('"total_issues": 2');
      expect(probes.get("project.status")?.text).toContain('"todo": 1');
      expect(probes.get("read")?.isError).toBe(false);
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
});

function agentRecord() {
  return {
    id: "pi-faux", name: "PI Faux", provider: "pi-sdk", model_provider: "pi-tools", model_id: "faux-1",
    thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z"
  };
}

function projectRecord(cwd: string) {
  return {
    id: "demo", name: "Demo", cwd, provider: "codex", provider_config_json: "{}", auto_run: 0,
    model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
    sort_order: 1, created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z",
    loop_status: "stopped", provider_capabilities: []
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
  runtime.session.dispose();
  return { probes, runtime };
}

function collectText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (typeof block === "object" && block && "text" in block && typeof block.text === "string") return block.text;
    return "";
  }).join("\n");
}

function insertAgent(db: RunnerDatabase): void {
  db.sqlite.run(
    `insert into pi_agents (id, name, model_provider, model_id, thinking_level, enabled, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    ["pi-faux", "PI Faux", "pi-tools", "faux-1", "off", 1, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"]
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

function writeFauxModelsConfig(db: RunnerDatabase): void {
  const agentDir = join(db.path, "..", "pi-runtime", "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "pi-tools": {
        api: "pi-tools-api",
        apiKey: "test",
        baseUrl: "http://localhost:0",
        models: [{ id: "faux-1" }]
      }
    }
  }));
}
