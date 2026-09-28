import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile, cp } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { openDatabase, type RunnerDatabase } from "../../db/database.ts";
import { createIssue } from "../../db/repositories/issueCreate.ts";
import { getProject } from "../../db/repositories/projects.ts";
import { localSettingsPath, readLocalSettingsSync, updateLocalSettingsFile } from "../../config/localSettings.ts";
import { createSecretService } from "../../security/secrets/service.ts";
import { createDefaultRouter } from "../../http/server.ts";
import { publicJevSkillSettings, saveJevSkillSettings } from "../../http/jevSkillSettingsApi.ts";
import { createPiRuntimeToolKit } from "../../pi/piRuntimeTools.ts";
import { callMcpTool } from "../../pi/mcpToolCall.ts";
import { buildSkillPromptContext } from "../promptContext.ts";
import { readMcpRegistry } from "../../mcp/registry.ts";
import { loadSmokeRuntime, resolveDefaultRepoRoot } from "../../spikes/piSmokeSupport.ts";
import { createPiRuntimeResourceLoader } from "../../http/piRuntimeResources.ts";
import { JEV_CAPABILITY_ID, JEV_SKILL_ID, JEV_TOOL_NAME, jevConfigFromSettings, jevPackage, readJevConfig } from "./config.ts";
import { invokeJevSkill, jevCooldownUntil } from "./invoke.ts";
import { jevAllowed, jevScope, managerJevAuthorization } from "./policy.ts";
import { runStdioProcess } from "../../mcp/stdioProcess.ts";
import { managerCycleAuthorization } from "../../http/piProjectControlAuthorization.ts";
import type { PiGatePolicy } from "../../pi/actionGate.ts";
import type { McpTransportInvokeRequest, McpTransportInvokeResult } from "../../pi/mcpTransport.ts";

const databases: RunnerDatabase[] = [];
const roots: string[] = [];
const originalPackage = process.env.PI_PACKAGE_DIR;
const originalBackend = process.env.XUANWU_SECRET_BACKEND;
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  if (originalPackage === undefined) delete process.env.PI_PACKAGE_DIR; else process.env.PI_PACKAGE_DIR = originalPackage;
  if (originalBackend === undefined) delete process.env.XUANWU_SECRET_BACKEND; else process.env.XUANWU_SECRET_BACKEND = originalBackend;
});
async function fixture() {
  process.env.XUANWU_SECRET_BACKEND = "file";
  delete process.env.PI_PACKAGE_DIR;
  const root = await mkdtemp(join(tmpdir(), "xuanwu-jev-skill-")); roots.push(root);
  const db = await openDatabase({ stateDir: root }); databases.push(db);
  db.sqlite.run("insert into projects (id,name,cwd,created_at,updated_at) values ('demo','Demo',?,'2026-09-28','2026-09-28')", [root]);
  return { db, root, project: getProject(db, "demo")! };
}
async function enable(db: RunnerDatabase, patch: Record<string, unknown> = {}) {
  await saveJevSkillSettings(db, { enabled: true, mode: "assist", scopes: ["web", "github", "feishu", "telegram", "background"], api_key: "synthetic-jev-credential-for-tests", ...patch });
}
const input = { title: "页面问题", body: "点击打开后看到报错，预期显示列表。" };
function observed(): McpTransportInvokeResult {
  return { status: "succeeded", durationMs: 1, output: { status: "observed", reason: "advisory", model: "jev-1.13.0", advice: {
    intent: { choice: "bug_report", confidence: 0.99 }, information: { choice: "missing", confidence: 0.99 }, message_kind: { choice: "report", confidence: 0.99 }
  } } };
}

test("missing, disabled, invalid and uncredentialed skill preserve the core runtime with zero transport calls", async () => {
  const { db } = await fixture();
  let calls = 0;
  const transport = async () => { calls++; return observed(); };
  expect(createPiRuntimeToolKit(db).tools).toContain("issue_read");
  expect(readMcpRegistry({ database: db }).servers.map(server => server.id)).not.toContain(JEV_SKILL_ID);
  expect((await invokeJevSkill({ db, input }, undefined, { transport })).output).toMatchObject({ reason: "disabled" });
  await enable(db);
  await saveJevSkillSettings(db, { clear_api_key: true });
  expect((await invokeJevSkill({ db, input }, undefined, { transport })).output).toMatchObject({ reason: "credential_missing" });
  await updateLocalSettingsFile(localSettingsPath(dirname(db.path)), current => ({ ...current, optionalSkills: { [JEV_SKILL_ID]: { enabled: true, timeoutMs: -1 } } }));
  expect(createPiRuntimeToolKit(db).tools).toContain("issue_read");
  expect((await invokeJevSkill({ db, input }, undefined, { transport })).output).toMatchObject({ reason: "invalid_configuration" });
  expect(calls).toBe(0);
});

test("legacy migration preserves mode, key reference and GitHub-only scope; explicit new disable/clear wins", async () => {
  const { db, root } = await fixture();
  const legacy = { integrations: { github: { issueSync: { enabled: true, jev: { mode: "routing", model: "jev-latest", apiKeyRef: "env://LEGACY_JEV_TEST_KEY" } } } } };
  await writeFile(localSettingsPath(root), JSON.stringify(legacy));
  expect(readJevConfig(db)).toMatchObject({ migrated: true, config: { enabled: true, mode: "assist", scopes: ["github"], apiKeyRef: "env://LEGACY_JEV_TEST_KEY" } });
  expect(jevAllowed(db, { source: "runner_chat" })).toBe(false);
  await saveJevSkillSettings(db, { enabled: false, clear_api_key: true });
  expect(readJevConfig(db)).toMatchObject({ migrated: false, config: { enabled: false, apiKeyRef: "", apiKeyEnvFile: "" } });
  expect(readLocalSettingsSync(root).integrations).toEqual(legacy.integrations);
  expect(jevConfigFromSettings({ integrations: { github: { issueSync: { enabled: true, jev: { mode: "broken" } } } } }).diagnostic).toBe("invalid_configuration");
  expect(jevConfigFromSettings({ integrations: { github: { issueSync: { enabled: false, jev: { mode: "shadow" } } } } }).config.enabled).toBe(false);
});

test("all supported channels and Supervisor profiles expose one optional tool and load its skill", async () => {
  const { db, project, root } = await fixture(); await enable(db);
  const github = createIssue(db, { project_id: project.id, title: "GitHub work", source_session_id: "github:I_fixture" });
  const contexts = [
    { source: "runner_chat" }, { source: "feishu_runner_chat" }, { source: "telegram_runner_chat" },
    { source: "pi_supervisor_decision", issueID: github.id }, { source: "pi_project_manager", heartbeatID: "h-test" }
  ];
  expect(contexts.map(context => jevScope(db, context))).toEqual(["web", "feishu", "telegram", "github", "background"]);
  expect(jevScope(db, { source: "telegram_runner_review" })).toBe("telegram");
  expect(jevScope(db, { source: "slack_runner_chat" })).toBe("unknown");
  expect(jevAllowed(db, { source: "slack_runner_chat" })).toBe(false);
  for (const context of contexts) {
    const kit = createPiRuntimeToolKit(db, project, context);
    expect(kit.customTools.filter(tool => tool.name === JEV_TOOL_NAME)).toHaveLength(1);
    expect(buildSkillPromptContext(db, { project, ...context }).audit.injected_skill_ids).toContain(JEV_SKILL_ID);
  }
  const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot());
  for (const promptProfile of ["chat", "manager_cycle", "recovery", "acceptance"] as const) {
    const kit = createPiRuntimeToolKit(db, project, { source: "runner_chat" }, { promptProfile });
    expect(kit.tools).toContain(JEV_TOOL_NAME);
    const loader = await createPiRuntimeResourceLoader(sdk, db, { promptProfile, project, source: "runner_chat" } as never, {
      agentDir: join(root, "agent"), cwd: root, runtimeRoot: join(root, "runtime"), systemPrompt: "Core prompt"
    });
    expect(loader.snapshot().loaded.skills).toContain(JEV_SKILL_ID);
    expect(loader.getSystemPrompt()).toBe("Core prompt");
    if (promptProfile === "acceptance" || promptProfile === "recovery") expect(loader.snapshot().loaded.extensions).toEqual([]);
  }
});

test("scope and project/runtime ceilings are enforced again at invocation, including stale loaded tools", async () => {
  const { db, project } = await fixture(); await enable(db, { scopes: ["github"] });
  expect(jevAllowed(db, { source: "feishu_runner_chat" })).toBe(false);
  const result = await callMcpTool({ db, capabilityID: JEV_CAPABILITY_ID, input, auditContext: { conversationID: "", source: "runner_chat" } });
  expect(result.output).toMatchObject({ reason: "scope_denied" });
  await enable(db);
  const kit = createPiRuntimeToolKit(db, project, { source: "runner_chat" });
  const tool = kit.customTools.find(tool => tool.name === JEV_TOOL_NAME)!;
  db.sqlite.run("update projects set default_skill_policy_json=? where id='demo'", [JSON.stringify({ allowed: ["xuanwu"] })]);
  expect((await tool.execute("call-stale", input, undefined, undefined, {} as never)).details).toMatchObject({ output: { reason: "scope_denied" } });
  expect(jevAllowed(db, { authorization: { mode: "attended", allowedSkillIntents: [] } })).toBe(false);
  await saveJevSkillSettings(db, { enabled: false });
  expect((await tool.execute("call-disabled", input, undefined, undefined, {} as never)).details).toMatchObject({ output: { reason: "disabled" } });
});

test("existing Action Gate denies expired, forbidden, MCP-restricted and cross-project optional calls before transport", async () => {
  const { db } = await fixture(); await enable(db);
  let calls = 0;
  const transport = async () => { calls++; return observed(); };
  const base: PiGatePolicy = { mode: "delegated", scope: { project_id: "demo" } };
  const denials: PiGatePolicy[] = [
    { ...base, allowedMcpCapabilities: [] }, { ...base, expiresAt: "2020-01-01" },
    { ...base, forbiddenActions: ["mcp.tool.call"] }, { ...base, forbiddenActions: ["skill.optional.call"] },
    { ...base, scope: { project_id: "other" } }, { mode: "delegated" },
    { ...base, enforceAuthorizedReadScope: true, authorizedActions: [{ action_type: "skill.optional.call", issue_id: 999 }] }
  ];
  for (const authorization of denials) {
    const result = await invokeJevSkill({ db, input, context: { projectID: "demo", source: "runner_chat", authorization } }, undefined, { transport });
    expect(result.output).toMatchObject({ reason: "scope_denied" });
  }
  expect(calls).toBe(0);
  db.sqlite.run("update projects set default_mcp_policy_json=? where id='demo'", [JSON.stringify({ allowed: ["docs:tool:search"] })]);
  expect(jevAllowed(db, { projectID: "demo", authorization: base })).toBe(false);
});

test("manager uses its actual virtual cycle IDs without granting excluded capabilities or failing on broken optional policy", async () => {
  const { db, project } = await fixture(); await enable(db);
  const authorization = managerJevAuthorization(db, project.id, managerCycleAuthorization(project));
  const context = { projectID: project.id, delegationID: `pi-cycle:${project.id}`, heartbeatID: `pi-cycle:${project.id}:conv`, source: "pi_manager_cycle", authorization };
  expect(jevAllowed(db, context)).toBe(true);
  expect(createPiRuntimeToolKit(db, project, context, { promptProfile: "manager_cycle" }).tools).toContain(JEV_TOOL_NAME);
  expect(jevAllowed(db, { ...context, delegationID: "pi-cycle:other" })).toBe(false);
  db.sqlite.run("update projects set default_mcp_policy_json='broken' where id='demo'");
  expect(managerJevAuthorization(db, project.id, authorization)).toBe(authorization);
});

test("a queued Jev call is cancelled before spawning when the skill is disabled", async () => {
  const { db, root } = await fixture(); await enable(db);
  const source = jevPackage().directory;
  const pkg = join(root, "isolated-package");
  await cp(source, join(pkg, "skills", JEV_SKILL_ID), { recursive: true });
  const started = join(root, "unexpected-start");
  await writeFile(join(pkg, "skills", JEV_SKILL_ID, "scripts/server.mjs"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(started)}, 'started');`);
  process.env.PI_PACKAGE_DIR = pkg;
  const release = join(root, "release-workers");
  const blockers = Array.from({ length: 4 }, () => runStdioProcess({ command: Bun.which("node")!,
    args: ["-e", "const fs=require('node:fs');const poll=()=>fs.existsSync(process.argv[1])?process.exit(0):setTimeout(poll,5);poll();", release],
    input: "", timeoutMs: 5000, stdoutLimit: 1024, stderrLimit: 1024 }));
  const pending = invokeJevSkill({ db, input });
  // 先让凭据解析完成并进入队列；释放 worker 必须晚于实际持久化禁用。
  await new Promise(resolve => setTimeout(resolve, 30));
  await saveJevSkillSettings(db, { enabled: false });
  await writeFile(release, "release");
  await Promise.all(blockers);
  expect((await pending).output).toMatchObject({ reason: "configuration_changed" });
  expect(existsSync(started)).toBe(false);
});

test("transport credentials stay out of registry, output and audit; low confidence/shadow never grant advice", async () => {
  const { db } = await fixture(); await enable(db);
  const key = "synthetic-jev-credential-for-tests";
  let captured: McpTransportInvokeRequest | undefined;
  const result = await invokeJevSkill({ db, input: { ...input, body: `报告中的密钥 ${key}` } }, undefined, { transport: async request => {
    captured = request; return observed();
  } });
  expect(captured?.server.transport?.env?.TYPESAFE_API_KEY).toBe(key);
  expect(JSON.stringify(captured?.input)).not.toContain(key);
  expect(result.output).toMatchObject({ reason: "advisory", advice: { intent: { choice: "bug_report" } } });
  expect(JSON.stringify(readMcpRegistry({ database: db }))).not.toContain(key);
  expect(JSON.stringify(publicJevSkillSettings(db))).not.toContain(key);
  expect(JSON.stringify(db.sqlite.query("select * from pi_action_events").all())).not.toContain(key);
  await saveJevSkillSettings(db, { mode: "shadow" });
  const shadow = await invokeJevSkill({ db, input }, undefined, { transport: async () => observed() });
  expect(shadow.output).toMatchObject({ reason: "shadow_only" });
  expect(shadow.output).not.toHaveProperty("advice");
  await saveJevSkillSettings(db, { mode: "assist" });
  const low = await invokeJevSkill({ db, input }, undefined, { transport: async () => ({ status: "succeeded", durationMs: 1,
    output: { status: "observed", model: "jev-latest", reason: "low_confidence", advice: { execute: true } } }) });
  expect(low.output).not.toHaveProperty("advice");
});

test("failures open a bounded cooldown, invalid input does not call, disable during a call discards advice", async () => {
  const { db } = await fixture(); await enable(db);
  let calls = 0;
  const transport = async (): Promise<McpTransportInvokeResult> => { calls++; return { status: "timeout", durationMs: 500 }; };
  await invokeJevSkill({ db, input: { ...input, body: "x".repeat(12001) } }, undefined, { transport });
  expect(calls).toBe(0);
  for (let i = 0; i < 3; i++) expect((await invokeJevSkill({ db, input }, undefined, { transport })).output).toMatchObject({ reason: "timeout" });
  expect((await invokeJevSkill({ db, input }, undefined, { transport })).output).toMatchObject({ reason: "cooldown" });
  expect(calls).toBe(3); expect(jevCooldownUntil(db)).not.toBe("");
  await saveJevSkillSettings(db, { enabled: true });
  const changed = await invokeJevSkill({ db, input }, undefined, { transport: async () => {
    await saveJevSkillSettings(db, { enabled: false }); return observed();
  } });
  expect(changed.output).toMatchObject({ reason: "configuration_changed" });
  expect(changed.output).not.toHaveProperty("advice");
});

test("removing or breaking the package leaves other skills/core usable and stale invocation safely unavailable", async () => {
  const { db, root } = await fixture(); await enable(db);
  const installed = jevPackage().directory;
  const isolated = join(root, "package"); await mkdir(isolated);
  await cp(installed, join(isolated, "skills", JEV_SKILL_ID), { recursive: true });
  process.env.PI_PACKAGE_DIR = isolated;
  expect(jevPackage().installed).toBe(true);
  await writeFile(join(isolated, "skills", JEV_SKILL_ID, "SKILL.md"), "broken metadata");
  expect(createPiRuntimeToolKit(db).tools).toContain("issue_read");
  expect((await callMcpTool({ db, capabilityID: JEV_CAPABILITY_ID, input })).output).toMatchObject({ reason: "skill_package_invalid" });
  await rm(join(isolated, "skills", JEV_SKILL_ID), { recursive: true });
  expect(readMcpRegistry({ database: db }).servers.map(server => server.id)).not.toContain(JEV_SKILL_ID);
  expect((await callMcpTool({ db, capabilityID: JEV_CAPABILITY_ID, input })).output).toMatchObject({ reason: "skill_package_missing" });
  const router = createDefaultRouter({ database: db });
  const response = await router.handle(new Request("http://localhost/api/pi/skills/jev-assist"));
  expect((await response.json() as any).skill).toMatchObject({ optional: true, installed: false, availability_status: "missing" });
});

test("settings API saves encrypted write-only keys, preserves unrelated settings and supports explicit removal", async () => {
  const { db, root } = await fixture();
  const router = createDefaultRouter({ database: db });
  const url = "http://localhost/api/pi/skills/jev-assist/settings";
  const put = async (body: unknown) => router.handle(new Request(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  await updateLocalSettingsFile(localSettingsPath(root), current => ({ ...current, runner: { maxParallelProjects: 3 } }));
  const key = "new-synthetic-jev-key-for-api-test";
  const saved = await put({ api_key: key, enabled: true, mode: "assist", scopes: ["web"] });
  expect(saved.status).toBe(200);
  const value = await saved.json(); expect(value).toMatchObject({ api_key_configured: true, availability: "ready" });
  expect(JSON.stringify(value)).not.toContain(key);
  expect(await readFile(localSettingsPath(root), "utf8")).not.toContain(key);
  expect(await readFile(join(root, "secrets", "store.json"), "utf8")).not.toContain(key);
  expect(readLocalSettingsSync(root).runner).toEqual({ maxParallelProjects: 3 });
  await put({ api_key: "", mode: "shadow" });
  expect(createSecretService({ stateDir: root }).resolve(readJevConfig(db).config.apiKeyRef)).toBe(key);
  expect((await put({ api_key: "do-not-save", scopes: ["outside"] })).status).toBe(400);
  expect(createSecretService({ stateDir: root }).resolve(readJevConfig(db).config.apiKeyRef)).toBe(key);
  expect((await put({ clear_api_key: true, api_key: "conflict" })).status).toBe(400);
  await put({ clear_api_key: true });
  expect(readJevConfig(db).config.apiKeyRef).toBe("");
  const probe = await router.handle(new Request("http://localhost/api/pi/skills/jev-assist/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "assist" })
  }));
  expect(await probe.json()).toMatchObject({ ok: false, reason: "credential_missing" });
  expect(readJevConfig(db).config.mode).toBe("shadow");
});

test("connection test executes a synthetic MCP call using draft credentials without saving or enabling the draft", async () => {
  const { db, root } = await fixture(); await enable(db, { enabled: false, scopes: ["github"], mode: "shadow" });
  const pkg = join(root, "probe-package");
  await cp(jevPackage().directory, join(pkg, "skills", JEV_SKILL_ID), { recursive: true });
  const output = JSON.stringify(observed().output);
  await writeFile(join(pkg, "skills", JEV_SKILL_ID, "scripts/server.mjs"), `
    import { createInterface } from 'node:readline';
    for await (const line of createInterface({ input: process.stdin })) {
      const request = JSON.parse(line);
      if (request.method !== 'tools/call') continue;
      const valid = process.env.TYPESAFE_API_KEY === 'synthetic-draft-only-key' && request.params.arguments.title === 'Synthetic connectivity test';
      console.log(JSON.stringify({ jsonrpc:'2.0', id:request.id, result:{ structuredContent: valid ? ${output} : {status:'unavailable',reason:'invalid_input'}, content:[] } }));
    }
  `);
  process.env.PI_PACKAGE_DIR = pkg;
  const before = await readFile(localSettingsPath(root), "utf8");
  const response = await createDefaultRouter({ database: db }).handle(new Request("http://localhost/api/pi/skills/jev-assist/test", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "assist", api_key: "synthetic-draft-only-key", scopes: ["web"] })
  }));
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ ok: true, status: "observed", reason: "advisory" });
  expect(await readFile(localSettingsPath(root), "utf8")).toBe(before);
  expect(readJevConfig(db).config).toMatchObject({ enabled: false, mode: "shadow", scopes: ["github"] });
  expect(JSON.stringify(publicJevSkillSettings(db))).not.toContain("synthetic-draft-only-key");
});
