#!/usr/bin/env bun

import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openDatabase } from "../backend-ts/src/db/database.ts";
import { listPiActionEvents, listPiActions, updatePiAction } from "../backend-ts/src/db/repositories/pi.ts";
import { createPiMcpActions } from "../backend-ts/src/pi/mcpActionTools.ts";
import { mcpServerLifecycleStates } from "../frontend/src/utils/mcpLifecycle.js";

const SERVER_ID = "project-agent-05-fixture";
const PROVIDER_ID = `mcp-${SERVER_ID}`;
const READ_CAPABILITY = `${SERVER_ID}:tool:fixture_read`;
const WRITE_CAPABILITY = `${SERVER_ID}:tool:fixture_write`;
const CONVERSATION_ID = "agent-05-live-issue-781";
const ISSUE_ID = 781;
const PROJECT_ID = "codex-issue-runner";

type JsonObject = Record<string, any>;
type Assertion = { evidence: string; id: string; passed: boolean; detail?: unknown };
type Options = {
  addr: string;
  artifactDir: string;
  dbPath: string;
  serverScript: string;
  tokenFile: string;
};

const command = process.argv[2] ?? "";
const options = parseOptions(process.argv.slice(3));

if (command === "exercise") await exercise(options);
else if (command === "verify-persistence") await verifyPersistence(options);
else if (command === "cleanup") await cleanup(options);
else {
  console.error("usage: bun scripts/mcp-live-activation.ts <exercise|verify-persistence|cleanup> --addr <host:port> --db <runner.db> --token-file <path> --artifact-dir <path>");
  process.exit(64);
}

async function exercise(input: Options): Promise<void> {
  await rm(input.artifactDir, { force: true, recursive: true });
  await mkdir(input.artifactDir, { recursive: true });
  const startedAt = new Date().toISOString();
  await writeJson(controlPath(input), { online: true });
  await writeJson(statePath(input), { value: "baseline" });
  await writeReplay(input);
  await timeline(input, "preflight", "inspect-isolated-runner-state", "started");

  const initial = await api(input, "/api/pi/mcp/discovery/results");
  await writeJson(resolve(input.artifactDir, "initial-state.json"), initial);
  if (initial.servers.some((item: JsonObject) => item.id === SERVER_ID)) {
    await api(input, `/api/pi/mcp/servers/${encodeURIComponent(SERVER_ID)}`, {
      body: { enabled: false },
      method: "PATCH"
    });
    await api(input, `/api/pi/mcp/servers/${encodeURIComponent(SERVER_ID)}`, { method: "DELETE" });
  }
  await prepareDiscoveryFixture(input);
  const scan = await api(input, "/api/pi/mcp/discovery/scan", {
    body: { sources: ["project"], workspace_dir: discoveryWorkspace(input) },
    method: "POST"
  });
  await writeJson(resolve(input.artifactDir, "discovery-scan.json"), scan);
  const discoveredState = await api(input, "/api/pi/mcp/discovery/results");
  await writeJson(resolve(input.artifactDir, "discovered-state.json"), discoveredState);
  const server = fixtureServer(discoveredState);
  const discovered = { ...server };
  await timeline(input, "connect", "discover-disabled-server", server.status === "discovered" && server.enabled === false ? "passed" : "failed", {
    enabled: server.enabled,
    readiness: server.readiness,
    server_id: server.id,
    status: server.status
  });

  const introspection = await api(input, `/api/pi/mcp/servers/${encodeURIComponent(SERVER_ID)}/introspect`, { method: "POST" });
  await writeJson(resolve(input.artifactDir, "introspection.json"), introspection);
  await api(input, `/api/pi/mcp/servers/${encodeURIComponent(SERVER_ID)}`, {
    body: { enabled: true },
    method: "PATCH"
  });
  for (const capabilityID of [READ_CAPABILITY, WRITE_CAPABILITY]) {
    await api(input, `/api/pi/mcp/capabilities/${encodeURIComponent(capabilityID)}`, {
      body: { enabled: true },
      method: "PATCH"
    });
  }
  const enabled = await api(input, "/api/pi/mcp/discovery/results");
  await writeJson(resolve(input.artifactDir, "enabled-ready.json"), enabled);
  await timeline(input, "introspection", "initialize-list-tools-enable", "passed", {
    capability_ids: introspection.capabilities.map((item: JsonObject) => item.id),
    readiness: fixtureServer(enabled).readiness
  });

  const firstRead = await readFixture(input, "before-disconnect");
  await writeJson(resolve(input.artifactDir, "read-before-disconnect.json"), firstRead);
  await timeline(input, "read", "read-only-invocation-before-disconnect", resultStatus(firstRead), {
    invocation_id: firstRead.result?.invocation_id,
    output: firstRead.result?.output
  });

  const writeGate = await writeGateProbe(input);
  await writeJson(resolve(input.artifactDir, "write-gate.json"), writeGate);
  await timeline(input, "permission", "write-tool-action-gate", writeGate.no_side_effect && ["ask", "deny"].includes(writeGate.result.decision) ? "passed" : "failed", {
    action_id: writeGate.result.action_id,
    decision: writeGate.result.decision,
    no_side_effect: writeGate.no_side_effect
  });

  await writeJson(controlPath(input), { online: false });
  const disconnected = await readFixture(input, "disconnected");
  await writeJson(resolve(input.artifactDir, "disconnected-call.json"), disconnected);
  const degraded = await api(input, `/api/pi/mcp/servers/${encodeURIComponent(SERVER_ID)}/introspect`, { method: "POST" });
  await writeJson(resolve(input.artifactDir, "degraded-state.json"), degraded);
  await timeline(input, "recovery", "disconnect-and-diagnose", disconnected.result?.status === "failed" ? "passed" : "failed", {
    error: disconnected.result?.error,
    readiness: degraded.server?.readiness,
    status: degraded.server?.status
  });

  await writeJson(controlPath(input), { online: true });
  const reintrospection = await api(input, `/api/pi/mcp/servers/${encodeURIComponent(SERVER_ID)}/introspect`, { method: "POST" });
  await writeJson(resolve(input.artifactDir, "reintrospection.json"), reintrospection);
  for (const capabilityID of [READ_CAPABILITY, WRITE_CAPABILITY]) {
    await api(input, `/api/pi/mcp/capabilities/${encodeURIComponent(capabilityID)}`, {
      body: { enabled: true },
      method: "PATCH"
    });
  }
  const secondRead = await readFixture(input, "after-reconnect");
  await writeJson(resolve(input.artifactDir, "read-after-reconnect.json"), secondRead);
  const recovered = await api(input, "/api/pi/mcp/discovery/results");
  await writeJson(resolve(input.artifactDir, "recovered-state.json"), recovered);
  await timeline(input, "recovery", "reconnect-and-read", resultStatus(secondRead), {
    invocation_id: secondRead.result?.invocation_id,
    readiness: fixtureServer(recovered).readiness,
    status: fixtureServer(recovered).status
  });

  const stateModel = {
    degraded: degraded.server,
    disabled: server,
    discovered,
    enabled: fixtureServer(enabled),
    ready: fixtureServer(recovered),
    ui_lifecycle: {
      degraded: mcpServerLifecycleStates(degraded.server),
      disabled: mcpServerLifecycleStates(server),
      discovered: mcpServerLifecycleStates(discovered),
      enabled: mcpServerLifecycleStates(fixtureServer(enabled)),
      ready: mcpServerLifecycleStates(fixtureServer(recovered))
    }
  };
  await writeJson(resolve(input.artifactDir, "state-model.json"), stateModel);

  const assertions: Assertion[] = [
    assertion("real_connection_and_introspection", introspection.server?.readiness === "ready" && introspection.capabilities.length >= 2, "introspection.json"),
    assertion("real_read_only_call_before_disconnect", readSucceeded(firstRead), "read-before-disconnect.json"),
    assertion("write_gate_ask_or_deny_without_side_effect", ["ask", "deny"].includes(writeGate.result.decision) && writeGate.no_side_effect, "write-gate.json"),
    assertion("disconnect_returns_diagnostic_error", disconnected.result?.status === "failed" && Boolean(disconnected.result?.error?.code), "disconnected-call.json"),
    assertion("degraded_state_is_visible", degraded.server?.enabled === true && degraded.server?.readiness === "failed", "degraded-state.json"),
    assertion("reconnect_restores_same_read_call", readSucceeded(secondRead), "read-after-reconnect.json"),
    assertion("ui_api_state_model_distinguishes_lifecycle", stateModelComplete(stateModel), "state-model.json"),
    assertion("core_restart_preserves_alias_and_ready", false, "post-restart.json", "pending Core restart"),
    assertion("tool_call_audit_is_complete_and_redacted", false, "tool-call-audit.json", "pending post-restart audit verification")
  ];
  await writeReport(input, startedAt, assertions);
}

async function verifyPersistence(input: Options): Promise<void> {
  const reportPath = resolve(input.artifactDir, "report.json");
  const existing = JSON.parse(await readFile(reportPath, "utf8")) as JsonObject;
  const state = await api(input, "/api/pi/mcp/discovery/results");
  const registry = await api(input, "/api/pi/mcp/capabilities");
  const tools = await api(input, "/api/pi/tools");
  const read = await readFixture(input, "after-core-restart");
  const audits = await api(input, `/api/pi/audit-events?issue_id=${ISSUE_ID}&event_type=tool_call_audit`);
  const relevantAudits = (audits as JsonObject[]).filter((event) => {
    const payload = parseJson(event.payload_json);
    return payload.provider_id === PROVIDER_ID && payload.tool === "fixture_read";
  });
  const auditPayloads = relevantAudits.map((event) => parseJson(event.payload_json));
  const server = fixtureServer(state);
  const alias = tools.tools.find((tool: JsonObject) =>
    tool.provider_id === PROVIDER_ID && tool.name === "fixture_read" && tool.metadata?.capability_id === READ_CAPABILITY);
  const capability = registry.capabilities.find((item: JsonObject) => item.id === READ_CAPABILITY);
  const auditComplete = auditPayloads.length >= 3 && auditPayloads.every((payload) =>
    payload.provider_id === PROVIDER_ID &&
    payload.tool === "fixture_read" &&
    typeof payload.tool_call_id === "string" &&
    payload.tool_call_id.length > 0 &&
    payload.input_summary &&
    typeof payload.duration_ms === "number" &&
    typeof payload.result === "string" &&
    payload.permission === "read"
  ) && auditPayloads.filter((payload) => payload.status === "succeeded" && payload.output_summary).length >= 2 &&
    !JSON.stringify(auditPayloads).match(/secret|token|password|credential/i);
  const postRestart = { alias, audit_count: auditPayloads.length, capability, read, server };
  await writeJson(resolve(input.artifactDir, "post-restart.json"), postRestart);
  await writeJson(resolve(input.artifactDir, "tool-call-audit.json"), auditPayloads);
  await timeline(input, "restart", "verify-core-restart-persistence", server.enabled && server.readiness === "ready" && Boolean(alias) && readSucceeded(read) ? "passed" : "failed", {
    alias: alias?.metadata?.capability_id,
    audit_count: auditPayloads.length,
    readiness: server.readiness
  });

  const assertions = (existing.assertions as Assertion[]).map((item) => {
    if (item.id === "core_restart_preserves_alias_and_ready") {
      return assertion(item.id, server.enabled === true && server.readiness === "ready" && Boolean(alias) && Boolean(capability) && readSucceeded(read), item.evidence);
    }
    if (item.id === "tool_call_audit_is_complete_and_redacted") {
      return assertion(item.id, auditComplete, item.evidence, { audit_count: auditPayloads.length });
    }
    return item;
  });
  await writeReport(input, existing.started_at, assertions);
}

async function cleanup(input: Options): Promise<void> {
  const results = await api(input, "/api/pi/mcp/discovery/results");
  if (results.servers.some((server: JsonObject) => server.id === SERVER_ID)) {
    await api(input, `/api/pi/mcp/servers/${encodeURIComponent(SERVER_ID)}`, {
      body: { enabled: false },
      method: "PATCH"
    });
    await api(input, `/api/pi/mcp/servers/${encodeURIComponent(SERVER_ID)}`, { method: "DELETE" });
  }
  const db = await openDatabase({ dbPath: input.dbPath });
  try {
    for (const action of listPiActions(db, { status: "pending" })) {
      if (action.action_type !== "mcp.tool.call" || action.source !== "agentic_activation_issue_781") continue;
      const payload = parseJson(action.payload_json);
      if (payload.capability_id !== WRITE_CAPABILITY) continue;
      updatePiAction(db, action.id, {
        decided_by: "fixture:cleanup",
        result_json: JSON.stringify({ reason: "isolated fixture cleanup", status: "rejected" }),
        status: "rejected"
      });
    }
  } finally {
    db.close();
  }
  await rm(controlPath(input), { force: true });
  await rm(statePath(input), { force: true });
}

async function readFixture(input: Options, requestID: string): Promise<JsonObject> {
  return api(input, `/api/pi/tools/${encodeURIComponent(`${PROVIDER_ID}:fixture_read`)}/call`, {
    body: {
      audit_context: {
        conversation_id: CONVERSATION_ID,
        issue_id: ISSUE_ID,
        project_id: PROJECT_ID,
        source: "agentic_activation_issue_781"
      },
      input: { request_id: requestID },
      invocation_id: `issue-781-${requestID}`
    },
    method: "POST"
  });
}

async function writeGateProbe(input: Options): Promise<JsonObject> {
  const before = readFileSync(statePath(input), "utf8");
  const db = await openDatabase({ dbPath: input.dbPath });
  try {
    db.sqlite.run("pragma busy_timeout = 5000");
    const beforeIDs = new Set(listPiActions(db).map((item) => item.id));
    const result = createPiMcpActions(db, {
      authorization: { mode: "attended" },
      conversationID: CONVERSATION_ID,
      projectID: PROJECT_ID,
      source: "agentic_activation_issue_781"
    }).callMcpTool({
      capability_id: WRITE_CAPABILITY,
      input: { value: "must-not-be-written" }
    }) as JsonObject;
    const action = listPiActions(db).find((item) => !beforeIDs.has(item.id) && item.action_type === "mcp.tool.call");
    const events = action ? listPiActionEvents(db, { actionId: action.id }) : [];
    const after = readFileSync(statePath(input), "utf8");
    return {
      action,
      events,
      no_side_effect: before === after && parseJson(after).value === "baseline",
      result
    };
  } finally {
    db.close();
  }
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

async function writeReport(input: Options, startedAt: string, assertions: Assertion[]): Promise<void> {
  const failures = assertions.filter((item) => !item.passed).map((item) => `${item.id}: ${stringDetail(item.detail)}`);
  await writeJson(resolve(input.artifactDir, "report.json"), {
    artifact_refs: [
      "initial-state.json", "discovery-scan.json", "discovered-state.json", "introspection.json",
      "enabled-ready.json", "read-before-disconnect.json",
      "write-gate.json", "disconnected-call.json", "degraded-state.json", "reintrospection.json",
      "read-after-reconnect.json", "recovered-state.json", "state-model.json", "post-restart.json",
      "tool-call-audit.json", "timeline.jsonl", "replay.md", "verification-command.log"
    ],
    assertions,
    ended_at: new Date().toISOString(),
    execution_context: {
      addr: input.addr,
      live_service_mutated: false,
      mode: "isolated_dev_runner"
    },
    failure_reasons: failures,
    result: failures.length === 0 ? "passed" : "pending",
    started_at: startedAt
  });
}

function assertion(id: string, passed: boolean, evidence: string, detail?: unknown): Assertion {
  return { id, passed, evidence, ...(detail === undefined ? {} : { detail }) };
}

function stateModelComplete(state: JsonObject): boolean {
  return state.discovered?.status === "discovered" &&
    state.disabled?.enabled === false &&
    state.enabled?.enabled === true &&
    state.ready?.readiness === "ready" &&
    state.degraded?.readiness === "failed" &&
    state.ui_lifecycle?.discovered?.includes("discovered") &&
    state.ui_lifecycle?.disabled?.includes("disabled") &&
    state.ui_lifecycle?.enabled?.includes("enabled") &&
    state.ui_lifecycle?.ready?.includes("ready") &&
    state.ui_lifecycle?.degraded?.includes("degraded");
}

function readSucceeded(payload: JsonObject): boolean {
  return payload.result?.status === "succeeded" &&
    payload.result?.output?.fixture === "agent-05" &&
    payload.result?.output?.value === "baseline";
}

function resultStatus(payload: JsonObject): string {
  return readSucceeded(payload) ? "passed" : "failed";
}

function fixtureServer(payload: JsonObject): JsonObject {
  const server = payload.servers?.find((item: JsonObject) => item.id === SERVER_ID);
  if (!server) throw new Error(`MCP server missing from API: ${SERVER_ID}`);
  return server;
}

function controlPath(input: Options): string {
  return resolve(input.artifactDir, "fixture-control.json");
}

function statePath(input: Options): string {
  return resolve(input.artifactDir, "fixture-state.json");
}

function discoveryWorkspace(input: Options): string {
  return resolve(input.artifactDir, "discovery-workspace");
}

async function prepareDiscoveryFixture(input: Options): Promise<void> {
  const workspace = discoveryWorkspace(input);
  await mkdir(workspace, { recursive: true });
  await writeJson(resolve(workspace, ".mcp.json"), {
    mcpServers: {
      "agent-05-fixture": {
        args: [input.serverScript],
        command: process.execPath,
        description: "Safe local MCP server for Agent-05 activation verification.",
        env: {
          MCP_ACTIVATION_CONTROL_FILE: controlPath(input),
          MCP_ACTIVATION_STATE_FILE: statePath(input)
        }
      }
    }
  });
}

async function writeReplay(input: Options): Promise<void> {
  const [host, port = "3569"] = input.addr.split(":");
  const frontendPort = String(Number.parseInt(port, 10) - 1);
  const lines = [
    "# Issue #781 MCP 实连权限闭环复现",
    "",
    "所有运行态验证使用隔离 state/DB/ports；不得操作 launchd live 服务。",
    "",
    "## 1. 启动隔离 Runner（终端 A）",
    "",
    "```bash",
    'export ISSUE781_STATE_DIR=\"$(mktemp -d /tmp/codex-issue-781-replay.XXXXXX)\"',
    `printf '%s\\n' "$ISSUE781_STATE_DIR" > ${shellQuote(resolve(input.artifactDir, "replay-state-path.txt"))}`,
    ': > \"$ISSUE781_STATE_DIR/auth_token\"',
    `CODEX_RUNNER_STATE_DIR="$ISSUE781_STATE_DIR" \\`,
    `CODEX_RUNNER_DB="$ISSUE781_STATE_DIR/runner.db" \\`,
    `CODEX_RUNNER_AUTH_TOKEN_FILE="$ISSUE781_STATE_DIR/auth_token" \\`,
    `CODEX_RUNNER_DEV_ADDR=${shellQuote(input.addr)} \\`,
    `FRONTEND_HOST=${shellQuote(host || "127.0.0.1")} FRONTEND_PORT=${shellQuote(frontendPort)} ./dev.sh`,
    "```",
    "",
    "## 2. 执行真实 discovery/introspection/read/deny/disconnect/reconnect（终端 B）",
    "",
    "```bash",
    `export ISSUE781_STATE_DIR="$(cat ${shellQuote(resolve(input.artifactDir, "replay-state-path.txt"))})"`,
    `bun scripts/mcp-live-activation.ts exercise --addr ${shellQuote(input.addr)} --db "$ISSUE781_STATE_DIR/runner.db" --token-file "$ISSUE781_STATE_DIR/auth_token" --artifact-dir ${shellQuote(input.artifactDir)}`,
    "```",
    "",
    "## 3. 重启隔离 Core 并验证持久化",
    "",
    "在终端 A 按 Ctrl+C，随后用第 1 步完全相同的环境变量和命令重新启动；再在终端 B 执行：",
    "",
    "```bash",
    `bun scripts/mcp-live-activation.ts verify-persistence --addr ${shellQuote(input.addr)} --db "$ISSUE781_STATE_DIR/runner.db" --token-file "$ISSUE781_STATE_DIR/auth_token" --artifact-dir ${shellQuote(input.artifactDir)}`,
    `jq -e '.result == "passed" and ([.assertions[].passed] | all)' ${shellQuote(resolve(input.artifactDir, "report.json"))}`,
    "```",
    "",
    "## 4. 可选清理",
    "",
    "```bash",
    `bun scripts/mcp-live-activation.ts cleanup --addr ${shellQuote(input.addr)} --db "$ISSUE781_STATE_DIR/runner.db" --token-file "$ISSUE781_STATE_DIR/auth_token" --artifact-dir ${shellQuote(input.artifactDir)}`,
    "```",
    ""
  ];
  await writeFile(resolve(input.artifactDir, "replay-state-path.txt"), `${resolve(input.dbPath, "..")}\n`, "utf8");
  await writeFile(resolve(input.artifactDir, "replay.md"), lines.join("\n"), "utf8");
}

async function timeline(input: Options, phase: string, action: string, result: string, detail: unknown = {}): Promise<void> {
  await mkdir(input.artifactDir, { recursive: true });
  await Bun.write(Bun.file(resolve(input.artifactDir, "timeline.jsonl")), [
    await Bun.file(resolve(input.artifactDir, "timeline.jsonl")).exists()
      ? await Bun.file(resolve(input.artifactDir, "timeline.jsonl")).text()
      : "",
    JSON.stringify({ action, at: new Date().toISOString(), detail, phase, result }),
    "\n"
  ].join(""));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

function parseJson(value: string): JsonObject {
  try { return JSON.parse(value) as JsonObject; } catch { return {}; }
}

function stringDetail(value: unknown): string {
  if (value === undefined) return "assertion failed";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function parseOptions(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) values.set(args[index] ?? "", args[index + 1] ?? "");
  const artifactDir = resolve(values.get("--artifact-dir") || ".runner/artifacts/agentic-activation/issue-781");
  const tokenFile = resolve(values.get("--token-file") || "data/auth_token");
  const dbPath = resolve(values.get("--db") || "data/runner.db");
  return {
    addr: values.get("--addr") || "127.0.0.1:3009",
    artifactDir,
    dbPath,
    serverScript: resolve(values.get("--server-script") || "scripts/mcp-live-activation-server.ts"),
    tokenFile
  };
}
