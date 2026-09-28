import { afterEach, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { createPiConversation, listPiActionEvents, type PiAgent } from "../../db/repositories/pi.ts";
import { adoptImConversationState } from "../../db/repositories/imConversationState.ts";
import { getProject, type Project } from "../../db/repositories/projects.ts";
import { saveJevSkillSettings } from "../../http/jevSkillSettingsApi.ts";
import { managerCycleAuthorization } from "../../http/piProjectControlAuthorization.ts";
import { createPiRuntimeSession, type PiRuntimeSession } from "../../http/piRuntime.ts";
import { runPiConversationPrompt } from "../../http/piConversationApi.ts";
import { piInternalReadAuthorization } from "../../pi/internalReadAuthorization.ts";
import { runPiIssueAcceptance } from "../../pi/issueAcceptance.ts";
import { runPiSupervisorDecision } from "../../pi/issueSupervisorDecision.ts";
import { authContext } from "../../pi/issueSupervisorDecisionTestSupport.ts";
import type { CompletionCard } from "../../domain/acceptance/completionCard.ts";
import { JEV_CAPABILITY_ID, JEV_SKILL_ID, JEV_TOOL_NAME, type JevScope } from "./config.ts";
import { managerJevAuthorization, withOptionalJevTool } from "./policy.ts";

const FAUX_API = "pi-jev-sdk-smoke-api";
const FAUX_PROVIDER = "pi-jev-sdk-smoke";
const REPORT = { title: "列表显示异常", body: "打开列表时显示错误；预期展示项目。" };
const FINAL_TEXT = "已继续使用普通 Agent 流程完成处理。";
const roots: string[] = [];
const databases: RunnerDatabase[] = [];
const runtimes: PiRuntimeSession[] = [];
const providers: ReturnType<typeof registerFauxProvider>[] = [];
const originalPackage = process.env.PI_PACKAGE_DIR;
const originalBackend = process.env.XUANWU_SECRET_BACKEND;

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.dispose();
  for (const provider of providers.splice(0)) provider.unregister();
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (originalPackage === undefined) delete process.env.PI_PACKAGE_DIR;
  else process.env.PI_PACKAGE_DIR = originalPackage;
  if (originalBackend === undefined) delete process.env.XUANWU_SECRET_BACKEND;
  else process.env.XUANWU_SECRET_BACKEND = originalBackend;
});

type Fixture = { root: string; packageRoot: string; stateDir: string; db: RunnerDatabase; project: Project; agent: PiAgent };

async function fixture(outcome: "advisory" | "timeout" = "advisory"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-jev-sdk-smoke-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const packageRoot = join(root, "package");
  const cwd = join(root, "project");
  await mkdir(cwd, { recursive: true });
  await writeFile(join(cwd, "README.md"), "# Isolated Jev SDK smoke fixture\n");
  await writeFakePackage(packageRoot, outcome);
  process.env.PI_PACKAGE_DIR = packageRoot;
  process.env.XUANWU_SECRET_BACKEND = "file";
  const db = await openDatabase({ stateDir });
  databases.push(db);
  db.sqlite.run("insert into projects (id,name,cwd,created_at,updated_at) values ('demo','Demo',?,'2026-09-28','2026-09-28')", [cwd]);
  const agentDir = join(stateDir, "pi-runtime", "agent");
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: {
    [FAUX_PROVIDER]: { api: FAUX_API, apiKey: "synthetic-faux-model-key", baseUrl: "http://127.0.0.1:0", models: [{ id: "faux-1" }] }
  } }));
  const agent: PiAgent = {
    id: "runner-default", name: "Jev SDK smoke", provider: "pi-sdk", model_provider: FAUX_PROVIDER,
    model_id: "faux-1", thinking_level: "off", cwd_policy: "project", tools_json: "[]", instructions: "", enabled: 1,
    created_at: "2026-09-28", updated_at: "2026-09-28"
  };
  return { root, packageRoot, stateDir, db, project: getProject(db, "demo")!, agent };
}

async function enable(f: Fixture, scopes: JevScope[] = ["web", "github", "feishu", "telegram", "background"]) {
  await saveJevSkillSettings(f.db, {
    enabled: true, mode: "assist", scopes, model: "jev-latest", timeout_ms: 500,
    api_key: "synthetic-jev-sdk-smoke-key",
  });
}

function fauxResponses(final = FINAL_TEXT, callTool = true) {
  const faux = registerFauxProvider({ api: FAUX_API, provider: FAUX_PROVIDER, tokensPerSecond: 0 });
  providers.push(faux);
  faux.setResponses([
    ...(callTool ? [fauxAssistantMessage([fauxToolCall(JEV_TOOL_NAME, REPORT, { id: "jev-sdk-call" })], { stopReason: "toolUse" })] : []),
    fauxAssistantMessage(final),
  ]);
  return faux;
}

async function openRuntime(f: Fixture, input: Partial<Parameters<typeof createPiRuntimeSession>[1]> = {}) {
  const runtime = await createPiRuntimeSession(f.db, {
    agent: f.agent, project: f.project, conversationID: crypto.randomUUID(), promptProfile: "chat", source: "runner_chat",
    retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } }, ...input,
  });
  runtimes.push(runtime);
  return runtime;
}

async function prompt(runtime: PiRuntimeSession) {
  await runtime.session.prompt("按需使用 Jev 辅助理解这段报告，然后继续处理。", { expandPromptTemplates: false, source: "rpc" });
  expect(runtime.session.getLastAssistantText()).toBe(FINAL_TEXT);
  expect(runtime.session.state.errorMessage || "").toBe("");
}

function optionalCalls(db: RunnerDatabase) {
  return listPiActionEvents(db).filter(event => event.event_type === "optional_skill.called")
    .map(event => ({ ...JSON.parse(event.payload_json), event }));
}

test.each([
  ["runner_chat", "web"], ["feishu_runner_chat", "feishu"], ["telegram_runner_chat", "telegram"],
] as const)("real PI SDK %s calls the optional tool through the shared skill and continues", async (source, scope) => {
  const f = await fixture();
  await enable(f, [scope]);
  const faux = fauxResponses();
  const runtime = await openRuntime(f, { source });
  expect(runtime.session.getActiveToolNames()).toContain(JEV_TOOL_NAME);
  expect(runtime.session.systemPrompt).toContain("<name>jev-assist</name>");
  await prompt(runtime);
  expect(faux.state.callCount).toBe(2);
  expect(optionalCalls(f.db)).toMatchObject([{ source: scope, status: "observed", reason: "advisory" }]);
  expect(await readFile(join(f.packageRoot, "invoked.json"), "utf8")).toBe(JSON.stringify(REPORT));
  expect(JSON.stringify(runtime.session.state.messages)).not.toContain("synthetic-jev-sdk-smoke-key");
});

test("Telegram review keeps its trusted channel scope through the real conversation API", async () => {
  const f = await fixture();
  f.db.sqlite.run("update pi_agents set model_provider=?,model_id='faux-1',thinking_level='off',enabled=1 where id='runner-default'", [FAUX_PROVIDER]);
  const conversationID = "telegram-jev-review";
  createPiConversation(f.db, { id: conversationID, pi_session_id: conversationID, project_id: "demo", pi_agent_id: "runner-default", title: "Review fixture" });
  adoptImConversationState(f.db, { activeConversationId: conversationID, baseConversationId: conversationID, connectorId: "telegram", scopeKey: conversationID });
  const request = { conversationId: conversationID, intent: "review", prompt: "Review this report and optionally classify it.",
    channelContextProjection: { connectorID: "telegram", conversationID: "chat-review", events: [], omittedCount: 0,
      piConversationID: conversationID, prompt: "", scopeKey: conversationID, truncated: false } };
  await enable(f, ["web"]);
  const faux = fauxResponses();
  await runPiConversationPrompt({ database: f.db }, request);
  expect(optionalCalls(f.db)).toHaveLength(0);
  expect(existsSync(join(f.packageRoot, "invoked.json"))).toBe(false);
  await enable(f, ["telegram"]);
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall(JEV_TOOL_NAME, REPORT, { id: "jev-review-call" })], { stopReason: "toolUse" }),
    fauxAssistantMessage(FINAL_TEXT)
  ]);
  await runPiConversationPrompt({ database: f.db }, request);
  expect(optionalCalls(f.db)).toMatchObject([{ source: "telegram", reason: "advisory" }]);
});

test.each(["missing", "unconfigured", "disabled"] as const)("real PI SDK conversation completes when Jev is %s at session start", async state => {
  const f = await fixture();
  await enable(f);
  if (state === "missing") await rm(join(f.packageRoot, "skills", JEV_SKILL_ID), { recursive: true });
  if (state === "unconfigured") await saveJevSkillSettings(f.db, { clear_api_key: true });
  if (state === "disabled") await saveJevSkillSettings(f.db, { enabled: false });
  const faux = fauxResponses(FINAL_TEXT, false);
  const runtime = await openRuntime(f);
  expect(runtime.session.getActiveToolNames()).not.toContain(JEV_TOOL_NAME);
  expect(runtime.session.getActiveToolNames()).toContain("issue_read");
  await prompt(runtime);
  expect(faux.state.callCount).toBe(1);
  expect(optionalCalls(f.db)).toEqual([]);
  expect(existsSync(join(f.packageRoot, "invoked.json"))).toBe(false);
});

test.each(["credential_missing", "disabled", "skill_package_missing"] as const)("a loaded tool becomes %s without stopping the real SDK conversation", async reason => {
  const f = await fixture();
  await enable(f);
  const faux = fauxResponses();
  const runtime = await openRuntime(f);
  expect(runtime.session.getActiveToolNames()).toContain(JEV_TOOL_NAME);
  if (reason === "credential_missing") await saveJevSkillSettings(f.db, { clear_api_key: true });
  if (reason === "disabled") await saveJevSkillSettings(f.db, { enabled: false });
  if (reason === "skill_package_missing") await rm(join(f.packageRoot, "skills", JEV_SKILL_ID), { recursive: true });
  await prompt(runtime);
  expect(faux.state.callCount).toBe(2);
  expect(optionalCalls(f.db)).toMatchObject([{ source: "web", status: "unavailable", reason }]);
  expect(existsSync(join(f.packageRoot, "invoked.json"))).toBe(false);
});

test("a service timeout result remains optional inside the real SDK tool loop", async () => {
  const f = await fixture("timeout");
  await enable(f);
  const faux = fauxResponses();
  const runtime = await openRuntime(f);
  await prompt(runtime);
  expect(faux.state.callCount).toBe(2);
  expect(optionalCalls(f.db)).toMatchObject([{ status: "unavailable", reason: "timeout" }]);
  expect(JSON.stringify(runtime.session.state.messages)).toContain("continue_without_skill");
});

test.each(["recovery", "acceptance"] as const)("GitHub %s applies the real internal authorization and dynamic active-tool list", async promptProfile => {
  const f = await fixture();
  await enable(f, ["github"]);
  const issue = createIssue(f.db, { project_id: "demo", title: "GitHub fixture", source_session_id: "github:I_sdk_fixture" });
  const source = promptProfile === "recovery" ? "pi_supervisor_decision" : "pi_issue_acceptance";
  const context = { projectID: "demo", issueID: issue.id, source };
  const tools = withOptionalJevTool(f.db, context, ["issue_read"]);
  expect(tools).toEqual(["issue_read", JEV_TOOL_NAME]);
  const authorization = piInternalReadAuthorization({ ...context, toolNames: tools });
  expect(authorization.authorizedActions).toContainEqual({
    action_type: "skill.optional.call", project_id: "demo", issue_id: issue.id,
    payload: { skill_id: JEV_SKILL_ID, capability_id: JEV_CAPABILITY_ID },
  });
  const faux = fauxResponses();
  const runtime = await openRuntime(f, { authorization, issueID: issue.id, source, promptProfile });
  runtime.session.setActiveToolsByName(tools);
  expect(runtime.session.getActiveToolNames()).toEqual(tools);
  await prompt(runtime);
  expect(faux.state.callCount).toBe(2);
  expect(optionalCalls(f.db)).toMatchObject([{ source: "github", reason: "advisory" }]);
});

test("the actual GitHub Supervisor entrypoint retains Jev when narrowing its active tools", async () => {
  const f = await fixture();
  await enable(f, ["github"]);
  const issue = createIssue(f.db, { project_id: "demo", title: "GitHub supervision", source_session_id: "github:I_supervisor" });
  const context = authContext();
  context.issue.id = issue.id;
  const faux = fauxResponses(JSON.stringify({
    confidence: "high", decision: "needs_user", evidence_refs: ["provider_error"],
    expected_outcome: "An authorized user restores provider authentication.", fallback_if_no_progress: "blocked",
    rationale: "Provider authorization is unavailable; Jev advice cannot approve access.",
    recovery_message: "Restore the provider credentials before continuing.", risk_level: "low",
  }));
  const result = await runPiSupervisorDecision({ agent: f.agent, context, database: f.db, project: f.project });
  expect(result.valid).toBe(true);
  expect(result.decision.decision).toBe("needs_user");
  expect(faux.state.callCount).toBe(2);
  expect(optionalCalls(f.db)).toMatchObject([{ source: "github", reason: "advisory" }]);
});

test("the actual GitHub acceptance entrypoint keeps its optional tool and completes a PI decision", async () => {
  const f = await fixture();
  await enable(f, ["github"]);
  const issue = createIssue(f.db, { project_id: "demo", title: "GitHub acceptance", source_session_id: "github:I_acceptance" });
  const faux = fauxResponses(JSON.stringify({
    decision: "needs_user", confidence: "high", rationale: "The external acceptance criterion needs a user decision.",
    evidence_refs: [], unmet_requirements: ["Confirm the requested behavior."], human_review_kind: "decision",
    progress: { made_progress: false, evidence_refs: [], summary: "Awaiting the user's decision." },
  }));
  const result = await runPiIssueAcceptance({ agent: f.agent, card: completionCard(issue.id), database: f.db, project: f.project });
  expect(result.valid).toBe(true);
  if (result.valid) expect(result.decision.decision).toBe("needs_user");
  expect(faux.state.callCount).toBe(2);
  expect(optionalCalls(f.db)).toMatchObject([{ source: "github", reason: "advisory" }]);
});

test("real manager cycle uses its synthetic delegation and narrowly grants the optional capability", async () => {
  const f = await fixture();
  await enable(f, ["background"]);
  const base = managerCycleAuthorization(f.project);
  expect(base.allowedMcpCapabilities).toEqual([]);
  const authorization = managerJevAuthorization(f.db, f.project.id, base);
  expect(authorization.allowedMcpCapabilities).toEqual([JEV_CAPABILITY_ID]);
  const faux = fauxResponses();
  const runtime = await openRuntime(f, {
    authorization, delegationID: "pi-cycle:demo", heartbeatID: "heartbeat-jev-sdk-smoke",
    source: "pi_manager_cycle", promptProfile: "manager_cycle",
  });
  expect(runtime.session.getActiveToolNames()).toContain(JEV_TOOL_NAME);
  await prompt(runtime);
  expect(faux.state.callCount).toBe(2);
  expect(optionalCalls(f.db)).toMatchObject([{
    source: "background", reason: "advisory",
    event: { delegation_id: "pi-cycle:demo", heartbeat_id: "heartbeat-jev-sdk-smoke" },
  }]);
});

async function writeFakePackage(packageRoot: string, outcome: "advisory" | "timeout") {
  const skillRoot = join(packageRoot, "skills", JEV_SKILL_ID);
  await mkdir(join(skillRoot, "scripts"), { recursive: true });
  await writeFile(join(skillRoot, "SKILL.md"), "---\nname: jev-assist\ndescription: Optional bounded report assistance.\n---\nUse jev_classify_report only when helpful. Continue normally when unavailable.\n");
  const output = outcome === "timeout" ? { status: "unavailable", reason: "timeout", model: "jev-latest" } : {
    status: "observed", reason: "advisory", model: "jev-latest", advice: {
      intent: { choice: "bug_report", confidence: 0.99 }, information: { choice: "missing", confidence: 0.99 },
      message_kind: { choice: "report", confidence: 0.99 },
    },
  };
  // 只处理本地 JSON-RPC，无 HTTP 客户端或网络调用；标记文件证明真实 stdio transport 已执行。
  await writeFile(join(skillRoot, "scripts", "server.mjs"), `import { readFileSync, writeFileSync } from 'node:fs';
for (const line of readFileSync(0, 'utf8').trim().split('\\n')) {
  const message = JSON.parse(line);
  if (message.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'jev-smoke',version:'1'}}})+'\\n');
  if (message.method === 'tools/call') {
    writeFileSync(${JSON.stringify(join(packageRoot, "invoked.json"))}, JSON.stringify(message.params.arguments));
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{structuredContent:${JSON.stringify(output)},content:[]}})+'\\n');
  }
}
`);
}

function completionCard(issueID: number): CompletionCard {
  return {
    contract: "xw.issue-completion-card.v1", acceptance: { criteria: [] }, commands: { items: [], omitted: 0, total: 0 },
    final_message: "Fixture complete", fingerprint: "jev-sdk-smoke-fixture", generated_at: "2026-09-28", human_review: null,
    git: { baseline_revision: "", changed_files: [], commit_count: 0, commits: [], final_revision: "", has_diff: false,
      observed_at: "2026-09-28", source: "session_observation", working_tree_dirty: false },
    issue: { id: issueID, project_id: "demo", status: "human_review", title: "GitHub acceptance", updated_at: "2026-09-28", goal: "Confirm requested behavior" },
    provider_outcome: { outcome: "completed", reason: "fixture" },
    run: { attempt: 1, ended_at: "2026-09-28", id: "fixture-run", provider: "codex", provider_session_id: "fixture-session",
      provider_turn_id: "fixture-turn", started_at: "2026-09-28", status: "completed" },
    session: { current_git: null, error: "", inspected: false, latest_turn_id: "", latest_turn_items: [], latest_turn_matches_run: false,
      latest_turn_status: "", provider_session_id: "fixture-session", run_turn_id: "fixture-turn", turn_count: 1 },
    warnings: [],
  };
}
