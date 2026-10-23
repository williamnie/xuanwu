import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { type RunnerDatabase } from "../../db/database.ts";
import { listPiActionEvents, listPiActions } from "../../db/repositories/pi.ts";
import { URL_FETCH_TOOL_NAME } from "../../pi/tools/httpToolProvider.ts";
import { createPiRuntimeSession } from "./piRuntime.ts";
import { FIXTURE_TIME, insertIssue, insertProject, insertRow, useTestDatabase } from "../../testing/harness.ts";
import { useFauxPi } from "../../testing/fauxPi.ts";

const openFixtureDatabase = useTestDatabase("xuanwu-bun-pi-tools-");
const fauxPi = useFauxPi();

describe("PI project tools", () => {
  test("exposes read-only SDK tools and runner action tools", async () => {
    const { db, faux, agent, project, projectCwd } = await openFixture();
    insertIssue(db, { title: "Todo issue", status: "todo" });
    insertIssue(db, { title: "Done issue", status: "done", created_at: "2026-01-02T00:00:00Z", updated_at: "2026-01-02T00:00:00Z" });
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("project_status", {}, { id: "status" }),
        fauxToolCall("repo_tree", { path: ".", max_depth: 1 }, { id: "repo-tree" }),
        fauxToolCall("repo_search", { query: "Demo", path: "README.md", max_results: 3 }, { id: "repo-search" }),
        fauxToolCall("repo_read_excerpt", { path: "README.md", start_line: 1, max_lines: 2 }, { id: "repo-read" }),
        fauxToolCall("issue_enqueue_proposal", { issue_id: 1, rationale: "ready" }, { id: "enqueue" }),
        fauxToolCall("issue_schedule_enqueue", { issue_id: 1, next_run_at: "2999-01-01T00:00:00.000Z" }, { id: "schedule-enqueue" }),
        fauxToolCall("read", { path: "README.md", limit: 5 }, { id: "read" }),
        fauxToolCall("write", { path: "blocked.txt", content: "must-not-write" }, { id: "write" }),
        fauxToolCall("edit", { path: "README.md", edits: [{ oldText: "# Demo", newText: "# Mutated" }] }, { id: "edit" }),
        fauxToolCall("bash", { command: "echo must-not-run" }, { id: "bash" })
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("done")
    ]);

    const { probes, runtime } = await promptWithProbes(db, { agent, conversationID: "conv-tools", project }, "Check project tools");

    expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining([
      "capability_search", "capability_invoke", "project_status", "repo_tree", "repo_search",
      "repo_read_excerpt", "issue_enqueue_proposal", "issue_schedule_enqueue", URL_FETCH_TOOL_NAME
    ]));
    expect(runtime.session.getActiveToolNames()).not.toEqual(expect.arrayContaining(["write", "edit", "bash"]));
    expect(runtime.session.getAllTools().map((tool) => tool.name).sort()).toEqual(runtime.session.getActiveToolNames().sort());
    for (const [tool, text] of [
      ["project_status", '"total_issues": 2'],
      ["project_status", '"todo": 1'],
      ["repo_tree", '"path": "README.md"'],
      ["repo_search", '"path": "README.md"'],
      ["repo_read_excerpt", '"source": "repo_read_excerpt"'],
      ["issue_enqueue_proposal", '"requires_confirmation": true'],
      ["issue_schedule_enqueue", '"requires_confirmation": true']
    ] as const) {
      expect(probes.get(tool)?.isError).toBe(false);
      expect(probes.get(tool)?.text).toContain(text);
    }
    expect(listPiActions(db, { status: "pending" }).map((action) => action.action_type).sort())
      .toEqual(["issue.enqueue", "issue.schedule_enqueue"]);
    expect(listPiActions(db, { status: "completed" }).map((action) => action.action_type))
      .toEqual(expect.arrayContaining(["repo.tree", "repo.search", "repo.read_excerpt"]));
    expect(probes.get("read")?.isError).toBe(false);
    const readAction = listPiActions(db).find((action) => action.action_type === "sdk.read");
    expect(readAction).toMatchObject({ gate_decision: "execute", source: "pi_sdk_tool", status: "completed" });
    expect(listPiActionEvents(db, { actionId: readAction?.id ?? "" }).map((event) => event.event_type))
      .toEqual(["candidate", "gate_decision", "execution_started", "execution_result"]);
    for (const tool of ["write", "edit", "bash"]) {
      expect(probes.get(tool)?.isError).toBe(true);
      expect(probes.get(tool)?.text).toContain(`Tool ${tool} not found`);
    }
    expect(existsSync(join(projectCwd, "blocked.txt"))).toBe(false);
    expect(readFileSync(join(projectCwd, "README.md"), "utf8")).toBe("# Demo\n");
  });

  test("global Runner tool calls do not fail when project_id is omitted", async () => {
    const { db, faux, agent } = await openFixture();
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("project_status", {}, { id: "global-status" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("done")
    ]);

    const { probes } = await promptWithProbes(db, { agent, conversationID: "conv-global-tools" }, "Check global status");

    expect(probes.get("project_status")?.isError).toBe(false);
    expect(probes.get("project_status")?.text).toContain('"items"');
    expect(probes.get("project_status")?.text).toContain('"demo"');
  });

  test("records standard audit envelopes for builtin tool success, failure, and redaction", async () => {
    const { db, faux, agent, project, projectCwd } = await openFixture();
    writeFileSync(join(projectCwd, "README.md"), ["# Demo", "AUTH_TOKEN=super-secret-token-value", "A".repeat(2000)].join("\n"));
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall("repo_read_excerpt", { max_lines: 3, path: "README.md", start_line: 1 }, { id: "read-secret" }),
        fauxToolCall("repo_read_excerpt", { path: "missing.txt", start_line: 1 }, { id: "read-missing" })
      ], { stopReason: "toolUse" }),
      fauxAssistantMessage("done")
    ]);

    await promptWithProbes(db, { agent, conversationID: "conv-tool-audit", project, source: "rpc" }, "Audit tool calls");

    const audit = listPiActionEvents(db, { conversationId: "conv-tool-audit" })
      .filter((event) => event.event_type === "tool_call_audit")
      .map((event) => JSON.parse(event.payload_json) as Record<string, any>);
    const success = audit.find((event) => event.tool_call_id === "read-secret");
    const failure = audit.find((event) => event.tool_call_id === "read-missing");
    const serialized = JSON.stringify(audit);

    expect(audit).toHaveLength(2);
    expect(success).toMatchObject({ provider_id: "runner-builtin", source: "rpc", status: "succeeded", tool: "repo_read_excerpt" });
    expect(Number(success?.duration_ms)).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(success?.input_summary)).toContain("README.md");
    expect(JSON.stringify(success?.output_summary).length).toBeLessThanOrEqual(900);
    expect(failure).toMatchObject({
      error: expect.objectContaining({ type: "tool_error", message: expect.any(String) }),
      provider_id: "runner-builtin",
      status: "failed",
      tool: "repo_read_excerpt"
    });
    expect(serialized).toContain("[redacted");
    expect(serialized).not.toContain("super-secret-token-value");
    expect(serialized).not.toContain("AUTH_TOKEN=super-secret-token-value");
  });
});

/** Project "demo" checked out in a temp dir with a README, plus a "pi-faux" agent on a scripted faux model. */
async function openFixture() {
  const db = await openFixtureDatabase();
  const projectCwd = join(db.path, "..", "..", "project");
  mkdirSync(projectCwd, { recursive: true });
  writeFileSync(join(projectCwd, "README.md"), "# Demo\n");
  insertProject(db, "demo", { cwd: projectCwd, sort_order: 1 });
  insertRow(db, "pi_agents", { id: "pi-faux", name: "PI Faux", created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME });
  const faux = fauxPi(db, { agentId: "pi-faux" });
  const agent = {
    id: "pi-faux", name: "PI Faux", provider: "pi-sdk", model_provider: faux.getModel().provider, model_id: "faux-1",
    thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME
  };
  const project = {
    id: "demo", name: "Demo", cwd: projectCwd, provider: "codex", provider_config_json: "{}", auto_run: 0,
    model: "", approval_policy: "never", sandbox: "workspace-write", default_agent_profile_id: "",
    default_service_tier: "", sort_order: 1, created_at: FIXTURE_TIME, updated_at: FIXTURE_TIME,
    default_mcp_policy: "{}", default_skill_policy: "{}", loop_status: "stopped", provider_capabilities: []
  };
  return { db, faux, agent, project, projectCwd };
}

/** Runs one chat prompt in a fresh runtime session and records each tool's final result. */
async function promptWithProbes(
  db: RunnerDatabase,
  input: Omit<Parameters<typeof createPiRuntimeSession>[1], "promptProfile">,
  prompt: string
) {
  const runtime = await createPiRuntimeSession(db, { ...input, promptProfile: "chat" });
  const probes = new Map<string, { isError: boolean; text: string }>();
  const unsubscribe = runtime.session.subscribe((event) => {
    if (event.type !== "tool_execution_end") return;
    const content: unknown[] = Array.isArray(event.result.content) ? event.result.content : [];
    const text = content.map((block) => (block as { text?: unknown })?.text).filter((part) => typeof part === "string").join("\n");
    probes.set(event.toolName, { isError: event.isError, text });
  });
  await runtime.session.prompt(prompt, { expandPromptTemplates: false, source: "rpc" });
  unsubscribe();
  runtime.dispose();
  return { probes, runtime };
}
