import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { openDatabase } from "../db/database.ts";
import { listPiActions, listPiActionEvents } from "../db/repositories/pi.ts";
import { loadAssistantToolRegistrySnapshot } from "../pi/toolRegistrySnapshot.ts";
import { readSkillCatalog } from "../skills/managedStore.ts";
import { createDefaultRouter } from "./server.ts";
import { finalPiConversationSseData } from "./piConversationSse.testSupport.ts";

const roots: string[] = [];
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

for (const scope of ["instance", "project"] as const) test(`Runner Chat installs and uses a ${scope} skill in the same real SDK turn through capability dispatch`, async () => {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-skill-conversation-")); roots.push(root);
  const stateDir = join(root, "state"), cwd = join(root, "project");
  await mkdir(cwd);
  const db = await openDatabase({ stateDir });
  const provider = `skill-faux-${scope}`, api = `${provider}-api`;
  const faux = registerFauxProvider({ api, provider });
  try {
    db.sqlite.run("update pi_agents set model_provider=?, model_id='faux-1', thinking_level='off', enabled=1 where id='runner-default'", [provider]);
    db.sqlite.run("insert into projects (id,name,cwd,default_skill_policy_json,created_at,updated_at) values (?,?,?,?,?,?)", ["demo", "Demo", cwd, JSON.stringify({ allowed: ["xuanwu"] }), "2026-01-01", "2026-01-01"]);
    const agentDir = join(stateDir, "pi-runtime", "agent"); await mkdir(agentDir, { recursive: true });
    await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { [provider]: { api, apiKey: "test", baseUrl: "http://localhost:0", models: [{ id: "faux-1" }] } } }));
    const definition = loadAssistantToolRegistrySnapshot(db).tools.find(item => item.name === "skill_install")!;
    const arguments_ = { id: "conversation-skill", scope, ...(scope === "project" ? { project_id: "demo" } : {}), source: { kind: "inline", content: "---\nname: conversation-skill\ndescription: A conversation installation verification skill.\n---\nReport CONVERSATION_SKILL_OK after loading these instructions.\n" } };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("capability_search", { query: "skill_install" })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("capability_invoke", { tool_id: "runner-builtin:skill_install", schema_hash: createHash("sha256").update(JSON.stringify(definition.input_schema)).digest("hex"), arguments: arguments_ })], { stopReason: "toolUse" }),
      fauxAssistantMessage([fauxToolCall("skill_use", { id: "conversation-skill" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("CONVERSATION_SKILL_OK")
    ]);
    const router = createDefaultRouter({ database: db });
    const post = (path: string, body: unknown) => router.handle(new Request(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    expect((await post("/api/pi/conversations", { id: `install-${scope}`, ...(scope === "project" ? { project_id: "demo" } : {}) })).status).toBe(201);
    const response = await post(`/api/pi/conversations/install-${scope}/messages`, { prompt: `Install and use conversation-skill for ${scope} scope.` });
    expect(await finalPiConversationSseData(response)).toMatchObject({ status: "completed", text: "CONVERSATION_SKILL_OK" });
    expect(readSkillCatalog(stateDir).skills).toMatchObject([{ id: "conversation-skill", scope, enabled: true }]);
    expect(listPiActions(db).filter(item => item.action_type === "skill.install" || item.action_type === "skill.use").map(item => ({ type: item.action_type, status: item.status }))).toEqual(expect.arrayContaining([{ type: "skill.install", status: "completed" }, { type: "skill.use", status: "completed" }]));
    const use = listPiActions(db).find(item => item.action_type === "skill.use")!;
    expect(JSON.parse(use.result_json).content).toContain("CONVERSATION_SKILL_OK");
    expect(listPiActionEvents(db).filter(item => item.event_type === "tool_call_audit").map(item => JSON.parse(item.payload_json))).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "skill_use", status: "succeeded" })]));
  } finally { faux.unregister(); db.close(); }
});
