#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "../backend-ts/src/db/database.ts";
import { listPiActionEvents } from "../backend-ts/src/db/repositories/pi.ts";
import { loadAssistantToolRegistrySnapshot } from "../backend-ts/src/pi/toolRegistrySnapshot.ts";
import { readSkillRegistry, recommendSkillIntents, type SkillMetadata } from "../backend-ts/src/skills/registry.ts";
import {
  executeSkillRuntime,
  SkillRuntimeError,
  type SkillRuntimeHandler
} from "../backend-ts/src/skills/runtime.ts";

const ISSUE_ID = 782;
const PROJECT_ID = "xuanwu";
const LOCAL_SKILL_ID = "agent-06-local-summary";
const TOOL_SKILL_ID = "agent-06-mcp-read";
const DISCOVERY_SERVER_NAME = "agent-05-fixture";
const SERVER_ID = `project-${DISCOVERY_SERVER_NAME}`;
const PROVIDER_ID = `mcp-${SERVER_ID}`;
const READ_CAPABILITY = `${SERVER_ID}:tool:fixture_read`;
const LOCAL_HANDLER = "fixture:deterministic-local-summary";
const TOOL_HANDLER = "fixture:audited-read-only-tool";

type JsonObject = Record<string, any>;
type Assertion = { detail?: unknown; evidence: string; id: string; passed: boolean };
type Options = {
  addr: string;
  artifactDir: string;
  codexHome: string;
  dbPath: string;
  serverScript: string;
  tokenFile: string;
};

const command = process.argv[2] ?? "";
const options = parseOptions(process.argv.slice(3));

if (command === "prepare") await prepare(options);
else if (command === "exercise") await exercise(options);
else if (command === "cleanup") await cleanup(options);
else {
  console.error("usage: bun scripts/skills-live-activation.ts <prepare|exercise|cleanup> --addr <host:port> --db <runner.db> --token-file <path> --codex-home <path> --artifact-dir <path>");
  process.exit(64);
}

async function prepare(input: Options): Promise<void> {
  await rm(input.artifactDir, { force: true, recursive: true });
  await mkdir(input.artifactDir, { recursive: true });
  await mkdir(input.codexHome, { recursive: true });
  await writeFixtureSkill(input, LOCAL_SKILL_ID, {
    description: "Use when converting an isolated activation phrase into a deterministic local summary.",
    handler: LOCAL_HANDLER,
    intent: "summarize_request",
    requiredTools: [],
    title: "Deterministic local summary"
  });
  await writeFixtureSkill(input, TOOL_SKILL_ID, {
    description: "Use when reading the isolated Agent-05 MCP fixture state through an audited read-only capability.",
    handler: TOOL_HANDLER,
    intent: "status_question",
    requiredTools: [READ_CAPABILITY],
    title: "Audited MCP fixture read"
  });
  await writeJson(controlPath(input), { online: true });
  await writeJson(statePath(input), { value: "agent-06-ready" });
  await prepareDiscoveryFixture(input);
  await writeReplay(input);
  await timeline(input, "prepare", "install-fixture-skills-and-mcp-config", "passed", {
    external_writes: 0,
    skill_ids: [LOCAL_SKILL_ID, TOOL_SKILL_ID]
  });
}

async function exercise(input: Options): Promise<void> {
  const startedAt = new Date().toISOString();
  const assertions: Assertion[] = [];
  try {
    const initialList = await api(input, "/api/pi/skills");
    await writeJson(artifact(input, "discovery.json"), initialList);
    const discovered = fixtureSkills(initialList);
    assertions.push(assertion(
      "discover_two_installed_skills",
      discovered.length === 2 && discovered.every((skill) => skill.discovery_status === "discovered"),
      "discovery.json",
      discovered.map(skillIdentity)
    ));
    await timeline(input, "discover", "read-live-skill-registry", pass(discovered.length === 2), {
      skill_ids: discovered.map((skill) => skill.id)
    });

    const initialLocalDetail = await api(input, `/api/pi/skills/${LOCAL_SKILL_ID}`);
    const initialToolDetail = await api(input, `/api/pi/skills/${TOOL_SKILL_ID}`);
    await writeJson(artifact(input, "local-load.json"), initialLocalDetail);
    await writeJson(artifact(input, "tool-load-before-enable.json"), initialToolDetail);
    assertions.push(assertion(
      "load_full_instructions_twice",
      fullInstructionsLoaded(initialLocalDetail.skill) && fullInstructionsLoaded(initialToolDetail.skill),
      "local-load.json + tool-load-before-enable.json",
      {
        local: instructionIdentity(initialLocalDetail.skill),
        tool: instructionIdentity(initialToolDetail.skill)
      }
    ));
    assertions.push(assertion(
      "tool_skill_initially_blocked_with_missing_capability",
      initialToolDetail.skill.availability_status === "blocked" &&
        initialToolDetail.skill.missing_capabilities?.includes(READ_CAPABILITY),
      "tool-load-before-enable.json"
    ));
    await timeline(input, "load", "load-full-skill-instructions", "passed", {
      hashes: [initialLocalDetail.skill.instruction_sha256, initialToolDetail.skill.instruction_sha256],
      versions: [initialLocalDetail.skill.version, initialToolDetail.skill.version]
    });

    const scan = await api(input, "/api/pi/mcp/discovery/scan", {
      body: { sources: ["project"], workspace_dir: discoveryWorkspace(input) },
      method: "POST"
    });
    await writeJson(artifact(input, "mcp-discovery.json"), scan);
    const introspection = await api(input, `/api/pi/mcp/servers/${SERVER_ID}/introspect`, { method: "POST" });
    await api(input, `/api/pi/mcp/servers/${SERVER_ID}`, { body: { enabled: true }, method: "PATCH" });
    await api(input, `/api/pi/mcp/capabilities/${encodeURIComponent(READ_CAPABILITY)}`, {
      body: { enabled: true },
      method: "PATCH"
    });
    await writeJson(artifact(input, "mcp-introspection.json"), introspection);
    const readyToolDetail = await api(input, `/api/pi/skills/${TOOL_SKILL_ID}`);
    await writeJson(artifact(input, "tool-ready.json"), readyToolDetail);
    assertions.push(assertion(
      "validate_and_resolve_required_tool",
      readyToolDetail.skill.availability_status === "ready" &&
        readyToolDetail.skill.resolved_tools?.some((tool: JsonObject) =>
          tool.grant === READ_CAPABILITY &&
          tool.provider_id === PROVIDER_ID &&
          tool.permission === "read" &&
          tool.status === "resolved"),
      "tool-ready.json"
    ));
    await timeline(input, "resolve", "introspect-enable-and-resolve-mcp-tool", "passed", {
      capability_id: READ_CAPABILITY,
      resolved_tools: readyToolDetail.skill.resolved_tools
    });

    const pipeline = {
      local: pipelineView(initialList, initialLocalDetail.skill, initialLocalDetail.skill),
      tool: pipelineView(initialList, initialToolDetail.skill, readyToolDetail.skill)
    };
    await writeJson(artifact(input, "skill-pipeline.json"), pipeline);
    assertions.push(assertion(
      "discover_load_validate_resolve_saved_for_both",
      pipeline.local.stages.every((stage: JsonObject) => stage.result === "passed") &&
        pipeline.tool.stages.every((stage: JsonObject) => stage.result === "passed"),
      "skill-pipeline.json"
    ));

    const intents = intentSelection(input);
    await writeJson(artifact(input, "intent-selection.json"), intents);
    const intentNoise = JSON.stringify(intents).includes('"expected":[]') ||
      JSON.stringify(intents).includes('["this","name"]');
    assertions.push(assertion(
      "explicit_intent_selects_expected_skills_without_noise",
      intents.local.selected_skill_id === LOCAL_SKILL_ID &&
        intents.tool.selected_skill_id === TOOL_SKILL_ID &&
        !intentNoise,
      "intent-selection.json",
      intents
    ));
    await timeline(input, "intent", "match-explicit-intents", pass(!intentNoise), intents);

    const localRun = await runSkill(input, LOCAL_SKILL_ID, "agent-06-local-run", localHandler());
    await writeJson(artifact(input, "local-run.json"), localRun);
    assertions.push(assertion(
      "local_skill_executes_with_checkable_output",
      localRun.run.status === "succeeded" &&
        localRun.output.final_output?.summary === "AGENT-06 local fixture summary",
      "local-run.json"
    ));
    await timeline(input, "execute", "execute-local-skill-runtime", "passed", {
      output: localRun.output.final_output,
      run_id: localRun.run.run_id
    });

    const firstToolRun = await runSkill(input, TOOL_SKILL_ID, "agent-06-tool-run", toolHandler());
    await writeJson(artifact(input, "tool-run.json"), firstToolRun);
    assertions.push(assertion(
      "tool_bound_skill_executes_real_mcp_read",
      readOutputSucceeded(firstToolRun),
      "tool-run.json",
      firstToolRun.output.final_output
    ));
    await timeline(input, "execute", "execute-tool-bound-skill-runtime", pass(readOutputSucceeded(firstToolRun)), {
      output: firstToolRun.output.final_output,
      run_id: firstToolRun.run.run_id
    });

    await api(input, `/api/pi/mcp/capabilities/${encodeURIComponent(READ_CAPABILITY)}`, {
      body: { enabled: false },
      method: "PATCH"
    });
    const blockedDetail = await api(input, `/api/pi/skills/${TOOL_SKILL_ID}`);
    const blockedRun = await runSkillExpectFailure(
      input,
      TOOL_SKILL_ID,
      "agent-06-tool-blocked-run",
      toolHandler()
    );
    await writeJson(artifact(input, "tool-blocked.json"), { api: blockedDetail, execution: blockedRun });
    assertions.push(assertion(
      "disabled_required_tool_blocks_without_false_success",
      blockedDetail.skill.availability_status === "blocked" &&
        blockedDetail.skill.missing_capabilities?.includes(READ_CAPABILITY) &&
        blockedRun.code === "required_tool_missing",
      "tool-blocked.json",
      blockedRun
    ));
    await timeline(input, "blocked", "disable-required-tool-and-execute", "passed", {
      availability: blockedDetail.skill.availability_status,
      error_code: blockedRun.code,
      missing_capabilities: blockedDetail.skill.missing_capabilities
    });

    await api(input, `/api/pi/mcp/capabilities/${encodeURIComponent(READ_CAPABILITY)}`, {
      body: { enabled: true },
      method: "PATCH"
    });
    const restoredDetail = await api(input, `/api/pi/skills/${TOOL_SKILL_ID}`);
    const restoredRun = await runSkill(input, TOOL_SKILL_ID, "agent-06-tool-restored-run", toolHandler());
    await writeJson(artifact(input, "tool-restored.json"), { api: restoredDetail, execution: restoredRun });
    assertions.push(assertion(
      "restored_tool_returns_ready_and_executes_again",
      restoredDetail.skill.availability_status === "ready" && readOutputSucceeded(restoredRun),
      "tool-restored.json"
    ));
    await timeline(input, "restore", "restore-required-tool-and-reexecute", "passed", {
      availability: restoredDetail.skill.availability_status,
      run_id: restoredRun.run.run_id
    });

    const domainRuns = await api(input, `/api/pi/skills/domain-runs?limit=20`);
    const audits = await api(input, `/api/pi/audit-events?issue_id=${ISSUE_ID}&event_type=tool_call_audit`);
    const relevantRuns = domainRuns.filter((run: JsonObject) =>
      [LOCAL_SKILL_ID, TOOL_SKILL_ID].includes(run.skill_id));
    const relevantAudits = audits.filter((event: JsonObject) => {
      const payload = parseJson(event.payload_json);
      return payload.provider_id === PROVIDER_ID && payload.tool === "fixture_read";
    }).map((event: JsonObject) => ({ ...event, payload: parseJson(event.payload_json) }));
    await writeJson(artifact(input, "api-run-states.json"), relevantRuns);
    await writeJson(artifact(input, "tool-audit.json"), relevantAudits);
    assertions.push(assertion(
      "api_distinguishes_loaded_ready_blocked_executed",
      initialLocalDetail.skill.load_status === "loaded" &&
        readyToolDetail.skill.availability_status === "ready" &&
        blockedDetail.skill.availability_status === "blocked" &&
        relevantRuns.filter((run: JsonObject) => run.lifecycle?.execution === "executed").length >= 3,
      "local-load.json + tool-ready.json + tool-blocked.json + api-run-states.json"
    ));
    assertions.push(assertion(
      "skill_identity_hash_tool_audit_and_output_are_correlated",
      relevantAudits.length >= 2 && relevantAudits.every((event: JsonObject) =>
        event.payload.permission === "read" &&
        event.payload.status === "succeeded" &&
        typeof event.payload.tool_call_id === "string" &&
        event.payload.tool_call_id.startsWith("skill:agent-06-tool-")) &&
        !JSON.stringify(relevantAudits).match(/secret|token|password|credential/i),
      "tool-audit.json",
      { audit_count: relevantAudits.length }
    ));

    await writeReport(input, startedAt, assertions);
    const failures = assertions.filter((item) => !item.passed);
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    assertions.push(assertion("exercise_completed", false, "timeline.jsonl", safeMessage(error)));
    await timeline(input, "fatal", "exercise", "failed", { error: safeMessage(error) });
    await writeReport(input, startedAt, assertions);
    throw error;
  }
}

async function runSkill(
  input: Options,
  skillID: string,
  runID: string,
  handler: SkillRuntimeHandler
): Promise<JsonObject> {
  const db = await openDatabase({ dbPath: input.dbPath });
  try {
    db.sqlite.run("pragma busy_timeout = 5000");
    const skill = loadedSkill(input, db, skillID);
    return await executeSkillRuntime({
      auditContext: {
        conversationID: "agent-06-skills-activation",
        issueID: ISSUE_ID,
        projectID: PROJECT_ID,
        source: "agentic_activation_issue_782"
      },
      db,
      evidenceRefs: ["fixture:agent-06"],
      handlers: { [skill.execution?.handler ?? ""]: handler },
      input: fixtureInput(skillID),
      runID,
      skill
    }) as unknown as JsonObject;
  } finally {
    db.close();
  }
}

async function runSkillExpectFailure(
  input: Options,
  skillID: string,
  runID: string,
  handler: SkillRuntimeHandler
): Promise<JsonObject> {
  try {
    await runSkill(input, skillID, runID, handler);
    return { code: "false_success", message: "skill unexpectedly succeeded", status: "succeeded" };
  } catch (error) {
    return {
      code: error instanceof SkillRuntimeError ? error.code : "unexpected_error",
      message: safeMessage(error),
      status: "blocked"
    };
  }
}

function loadedSkill(input: Options, db: Awaited<ReturnType<typeof openDatabase>>, skillID: string): SkillMetadata {
  const snapshot = loadAssistantToolRegistrySnapshot(db);
  const registry = readSkillRegistry({
    availableTools: snapshot.tools.map((tool) => ({
      aliases: [cleanString(tool.metadata?.capability_id)].filter(Boolean),
      name: tool.name,
      permission: tool.permission,
      provider_id: tool.provider_id
    })),
    roots: [{ label: "codex-home", path: resolve(input.codexHome, "skills") }]
  });
  const skill = registry.items.find((item) => item.id === skillID);
  if (!skill) throw new Error(`fixture skill missing: ${skillID}`);
  return skill;
}

function localHandler(): SkillRuntimeHandler {
  return (input, context) => ({
    action_proposals: [],
    final_output: {
      input_summary: cleanString((input.inbox_item as JsonObject)?.summary),
      summary: "AGENT-06 local fixture summary"
    },
    skill_id: context.skillID
  });
}

function toolHandler(): SkillRuntimeHandler {
  return async (_input, context) => ({
    action_proposals: [],
    final_output: await context.invokeTool(READ_CAPABILITY, { request_id: "issue-782-skill-runtime" }),
    skill_id: context.skillID
  });
}

function fixtureInput(skillID: string): JsonObject {
  return {
    inbox_item: {
      evidence_refs: ["fixture:agent-06"],
      id: skillID === LOCAL_SKILL_ID ? 6001 : 6002,
      primary_intent: skillID === LOCAL_SKILL_ID ? "summarize_request" : "status_question",
      source: "agentic-activation-fixture",
      suggested_actions: [],
      summary: skillID === LOCAL_SKILL_ID
        ? "Summarize the isolated Agent-06 fixture locally."
        : "Read the isolated Agent-05 MCP fixture state.",
      target_hints: [],
      title: skillID
    }
  };
}

function intentSelection(input: Options): JsonObject {
  const roots = [{ label: "codex-home", path: resolve(input.codexHome, "skills") }];
  const localIntent = {
    description: "Convert the isolated activation phrase into a deterministic local summary.",
    title: "Agent-06 deterministic local summary"
  };
  const toolIntent = {
    description: "Read the isolated Agent-05 MCP fixture state with an audited read-only capability.",
    title: "Agent-06 audited MCP fixture read"
  };
  const local = recommendSkillIntents(localIntent, { roots });
  const tool = recommendSkillIntents(toolIntent, { roots });
  return {
    local: {
      input: localIntent,
      selected_skill_id: local[0]?.id ?? "",
      selection_reason: local[0]?.reason ?? "",
      selection_score: local[0]?.score ?? 0
    },
    tool: {
      input: toolIntent,
      selected_skill_id: tool[0]?.id ?? "",
      selection_reason: tool[0]?.reason ?? "",
      selection_score: tool[0]?.score ?? 0
    }
  };
}

function pipelineView(list: JsonObject, loaded: JsonObject, resolved: JsonObject): JsonObject {
  const item = list.skills.find((skill: JsonObject) => skill.id === loaded.id);
  return {
    instruction_sha256: loaded.instruction_sha256,
    skill_id: loaded.id,
    stages: [
      { result: item?.discovery_status === "discovered" ? "passed" : "failed", stage: "discover" },
      {
        instruction_bytes: loaded.instruction_bytes,
        instruction_sha256: loaded.instruction_sha256,
        result: loaded.load_status === "loaded" && Boolean(loaded.instructions) ? "passed" : "failed",
        stage: "load"
      },
      {
        diagnostics: loaded.diagnostics,
        result: loaded.diagnostics?.filter((item: JsonObject) => item.code === "manifest_invalid").length === 0 ? "passed" : "failed",
        stage: "validate"
      },
      {
        required_tools: resolved.required_tools,
        resolved_tools: resolved.resolved_tools,
        result: resolved.missing_capabilities?.length === 0 ? "passed" : "failed",
        stage: "resolve_tools"
      }
    ],
    version: loaded.version
  };
}

async function writeFixtureSkill(
  input: Options,
  id: string,
  fixture: {
    description: string;
    handler: string;
    intent: string;
    requiredTools: string[];
    title: string;
  }
): Promise<void> {
  const dir = resolve(input.codexHome, "skills", id);
  await mkdir(dir, { recursive: true });
  await writeFile(resolve(dir, "SKILL.md"), [
    "---",
    `name: ${id}`,
    "version: 1.0.0",
    `description: ${fixture.description}`,
    "---",
    "",
    `# ${fixture.title}`,
    "",
    "This fixture must execute only through the controlled Skill Runtime.",
    "It may read isolated fixture state but must not perform external writes.",
    "",
    "## Output contract",
    "",
    "Return a deterministic, inspectable result correlated with the runtime run id."
  ].join("\n") + "\n");
  await writeJson(resolve(dir, "manifest.json"), {
    execution: {
      adapter: "builtin",
      handler: fixture.handler,
      sandbox: "capability",
      timeout_ms: 5000
    },
    input_object: "inbox_item",
    input_schema: {
      properties: {
        inbox_item: {
          properties: {
            evidence_refs: { items: { type: "string" }, minItems: 1, type: "array" },
            id: { minimum: 1, type: "integer" },
            primary_intent: { minLength: 1, type: "string" },
            summary: { minLength: 1, type: "string" }
          },
          required: ["id", "evidence_refs", "primary_intent", "summary"],
          type: "object"
        }
      },
      required: ["inbox_item"],
      type: "object"
    },
    intent_tags: ["agentic-activation", id === LOCAL_SKILL_ID ? "pure-local" : "mcp-read-only"],
    kind: "domain",
    manifest_version: "pi-skill.v0",
    output_objects: ["action_proposals"],
    output_schema: {
      properties: {
        action_proposals: { items: { type: "object" }, type: "array" },
        final_output: { type: "object" },
        skill_id: { const: id, type: "string" }
      },
      required: ["action_proposals", "final_output", "skill_id"],
      type: "object"
    },
    permissions: { max_tool_permission: "read" },
    primary_intents: [fixture.intent, "other"],
    required_tools: fixture.requiredTools
  });
}

async function prepareDiscoveryFixture(input: Options): Promise<void> {
  const workspace = discoveryWorkspace(input);
  await mkdir(workspace, { recursive: true });
  await writeJson(resolve(workspace, ".mcp.json"), {
    mcpServers: {
      [DISCOVERY_SERVER_NAME]: {
        args: [input.serverScript],
        command: process.execPath,
        description: "Safe local MCP server reused from Issue #781 activation verification.",
        env: {
          MCP_ACTIVATION_CONTROL_FILE: controlPath(input),
          MCP_ACTIVATION_STATE_FILE: statePath(input)
        }
      }
    }
  });
}

async function writeReport(input: Options, startedAt: string, assertions: Assertion[]): Promise<void> {
  const failures = assertions.filter((item) => !item.passed)
    .map((item) => `${item.id}: ${item.detail === undefined ? "assertion failed" : JSON.stringify(item.detail)}`);
  await writeJson(artifact(input, "report.json"), {
    artifact_refs: [
      "discovery.json", "local-load.json", "tool-load-before-enable.json", "mcp-discovery.json",
      "mcp-introspection.json", "tool-ready.json", "skill-pipeline.json", "intent-selection.json",
      "local-run.json", "tool-run.json", "tool-blocked.json", "tool-restored.json",
      "api-run-states.json", "tool-audit.json", "timeline.jsonl", "replay.md",
      "verification-command.log"
    ],
    assertions,
    ended_at: new Date().toISOString(),
    execution_context: {
      addr: input.addr,
      external_writes: 0,
      mode: "isolated_dev_runner",
      state_scope: resolve(input.dbPath, "..")
    },
    failure_reasons: failures,
    result: failures.length === 0 ? "passed" : "failed",
    started_at: startedAt
  });
}

async function writeReplay(input: Options): Promise<void> {
  const [host, port = "3791"] = input.addr.split(":");
  const frontendPort = String(Number.parseInt(port, 10) - 1);
  const root = resolve(input.dbPath, "..");
  const commandBase = [
    "bun scripts/skills-live-activation.ts",
    "--addr", shellQuote(input.addr),
    "--db", '"$ISSUE782_STATE_DIR/runner.db"',
    "--token-file", '"$ISSUE782_STATE_DIR/auth_token"',
    "--codex-home", '"$ISSUE782_STATE_DIR/codex-home"',
    "--artifact-dir", shellQuote(input.artifactDir)
  ].join(" ");
  await writeFile(artifact(input, "replay.md"), [
    "# Issue #782 Skills live runtime 复现",
    "",
    "所有测试仅使用隔离 DB、端口、CODEX_HOME 与 MCP fixture；`external_writes=0`。",
    "",
    "## 1. 准备隔离基线",
    "",
    "```bash",
    `export ISSUE782_STATE_DIR=${shellQuote(root)}`,
    'mkdir -p "$ISSUE782_STATE_DIR"',
    ': > "$ISSUE782_STATE_DIR/auth_token"',
    `${commandBase.replace("skills-live-activation.ts", "skills-live-activation.ts prepare")}`,
    "```",
    "",
    "## 2. 启动隔离 Runner",
    "",
    "```bash",
    'CODEX_HOME="$ISSUE782_STATE_DIR/codex-home" \\',
    'XUANWU_STATE_DIR="$ISSUE782_STATE_DIR" \\',
    'XUANWU_DB="$ISSUE782_STATE_DIR/runner.db" \\',
    'XUANWU_AUTH_TOKEN_FILE="$ISSUE782_STATE_DIR/auth_token" \\',
    `XUANWU_DEV_ADDR=${shellQuote(input.addr)} \\`,
    `FRONTEND_HOST=${shellQuote(host || "127.0.0.1")} FRONTEND_PORT=${shellQuote(frontendPort)} ./dev.sh`,
    "```",
    "",
    "## 3. 执行 discover/load/validate/resolve/execute/block/restore",
    "",
    "```bash",
    `CODEX_HOME="$ISSUE782_STATE_DIR/codex-home" ${commandBase.replace("skills-live-activation.ts", "skills-live-activation.ts exercise")}`,
    `jq -e '.result == "passed" and ([.assertions[].passed] | all)' ${shellQuote(artifact(input, "report.json"))}`,
    "```",
    "",
    "## 4. 清理 fixture",
    "",
    "```bash",
    `${commandBase.replace("skills-live-activation.ts", "skills-live-activation.ts cleanup")}`,
    "```",
    ""
  ].join("\n") + "\n");
}

async function cleanup(input: Options): Promise<void> {
  try {
    const state = await api(input, "/api/pi/mcp/discovery/results");
    if (state.servers?.some((server: JsonObject) => server.id === SERVER_ID)) {
      await api(input, `/api/pi/mcp/servers/${SERVER_ID}`, { body: { enabled: false }, method: "PATCH" });
      await api(input, `/api/pi/mcp/servers/${SERVER_ID}`, { method: "DELETE" });
    }
  } catch {
    // The isolated Runner may already be stopped; deleting local fixture files is sufficient.
  }
  await rm(controlPath(input), { force: true });
  await rm(statePath(input), { force: true });
}

async function api(input: Options, path: string, request: { body?: unknown; method?: string } = {}): Promise<any> {
  const token = (await readFile(input.tokenFile, "utf8")).trim();
  const response = await fetch(`http://${input.addr}${path}`, {
    body: request.body === undefined ? undefined : JSON.stringify(request.body),
    headers: {
      authorization: `Bearer ${token}`,
      ...(request.body === undefined ? {} : { "content-type": "application/json" })
    },
    method: request.method ?? "GET",
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : {};
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${payload.message ?? text.slice(0, 240)}`);
  return payload;
}

async function timeline(input: Options, phase: string, action: string, result: string, detail: unknown = {}): Promise<void> {
  const path = artifact(input, "timeline.jsonl");
  const previous = await Bun.file(path).exists() ? await Bun.file(path).text() : "";
  await Bun.write(path, `${previous}${JSON.stringify({ action, at: new Date().toISOString(), detail, phase, result })}\n`);
}

function fullInstructionsLoaded(skill: JsonObject): boolean {
  return skill.load_status === "loaded" &&
    typeof skill.instructions === "string" &&
    skill.instructions.includes("## Output contract") &&
    skill.instruction_sha256 === createHash("sha256").update(skill.instructions).digest("hex");
}

function fixtureSkills(payload: JsonObject): JsonObject[] {
  return payload.skills.filter((skill: JsonObject) => [LOCAL_SKILL_ID, TOOL_SKILL_ID].includes(skill.id));
}

function readOutputSucceeded(run: JsonObject): boolean {
  return run.run?.status === "succeeded" &&
    run.output?.final_output?.fixture === "agent-05" &&
    run.output?.final_output?.value === "agent-06-ready";
}

function instructionIdentity(skill: JsonObject): JsonObject {
  return {
    instruction_bytes: skill.instruction_bytes,
    instruction_sha256: skill.instruction_sha256,
    skill_id: skill.id,
    version: skill.version
  };
}

function skillIdentity(skill: JsonObject): JsonObject {
  return { skill_id: skill.id, version: skill.version };
}

function assertion(id: string, passed: boolean, evidence: string, detail?: unknown): Assertion {
  return { id, passed, evidence, ...(detail === undefined ? {} : { detail }) };
}

function pass(value: boolean): string {
  return value ? "passed" : "failed";
}

function artifact(input: Options, name: string): string {
  return resolve(input.artifactDir, name);
}

function controlPath(input: Options): string {
  return artifact(input, "fixture-control.json");
}

function statePath(input: Options): string {
  return artifact(input, "fixture-state.json");
}

function discoveryWorkspace(input: Options): string {
  return artifact(input, "discovery-workspace");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function parseJson(value: string): JsonObject {
  try { return JSON.parse(value) as JsonObject; } catch { return {}; }
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) values.set(args[index] ?? "", args[index + 1] ?? "");
  const artifactDir = resolve(values.get("--artifact-dir") || ".runner/artifacts/agentic-activation/issue-782");
  const dbPath = resolve(values.get("--db") || "/tmp/codex-issue-782/runner.db");
  const stateDir = resolve(dbPath, "..");
  return {
    addr: values.get("--addr") || "127.0.0.1:3791",
    artifactDir,
    codexHome: resolve(values.get("--codex-home") || resolve(stateDir, "codex-home")),
    dbPath,
    serverScript: resolve(values.get("--server-script") || "scripts/mcp-live-activation-server.ts"),
    tokenFile: resolve(values.get("--token-file") || resolve(stateDir, "auth_token"))
  };
}
