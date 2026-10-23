import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { listPiActions, listPiActionEvents } from "../../db/repositories/pi.ts";
import { loadAssistantToolRegistrySnapshot } from "../../pi/tools/toolRegistrySnapshot.ts";
import { readSkillCatalog } from "../../skills/managedStore.ts";
import { createDefaultRouter } from "../server.ts";
import { finalPiConversationSseData } from "./piConversationSse.testSupport.ts";
import { apiClient, insertProject, useTestDatabase } from "../../testing/harness.ts";
import { useFauxPi } from "../../testing/fauxPi.ts";

const openFixtureDatabase = useTestDatabase("xuanwu-skill-conversation-");
const fauxPi = useFauxPi("skill-faux");

for (const scope of ["instance", "project"] as const) test(`Runner Chat installs and uses a ${scope} skill in the same real SDK turn through capability dispatch`, async () => {
  const db = await openFixtureDatabase();
  const stateDir = dirname(db.path), cwd = join(stateDir, "..", "project");
  await mkdir(cwd);
  const faux = fauxPi(db);
  insertProject(db, "demo", { name: "Demo", cwd, default_skill_policy_json: JSON.stringify({ allowed: ["xuanwu"] }) });
  const definition = loadAssistantToolRegistrySnapshot(db).tools.find(item => item.name === "skill_install")!;
  const arguments_ = { id: "conversation-skill", scope, ...(scope === "project" ? { project_id: "demo" } : {}), source: { kind: "inline", content: "---\nname: conversation-skill\ndescription: A conversation installation verification skill.\n---\nReport CONVERSATION_SKILL_OK after loading these instructions.\n" } };
  faux.setResponses([
    fauxAssistantMessage([fauxToolCall("capability_search", { query: "skill_install" })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("capability_invoke", { tool_id: "runner-builtin:skill_install", schema_hash: createHash("sha256").update(JSON.stringify(definition.input_schema)).digest("hex"), arguments: arguments_ })], { stopReason: "toolUse" }),
    fauxAssistantMessage([fauxToolCall("skill_use", { id: "conversation-skill" })], { stopReason: "toolUse" }),
    fauxAssistantMessage("CONVERSATION_SKILL_OK")
  ]);
  const api = apiClient(createDefaultRouter({ database: db }));
  expect((await api.post("/api/pi/conversations", { id: `install-${scope}`, ...(scope === "project" ? { project_id: "demo" } : {}) })).status).toBe(201);
  const response = await api.raw(`/api/pi/conversations/install-${scope}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: `Install and use conversation-skill for ${scope} scope.` }) });
  expect(await finalPiConversationSseData(response)).toMatchObject({ status: "completed", text: "CONVERSATION_SKILL_OK" });
  expect(readSkillCatalog(stateDir).skills).toMatchObject([{ id: "conversation-skill", scope, enabled: true }]);
  expect(listPiActions(db).filter(item => item.action_type === "skill.install" || item.action_type === "skill.use").map(item => ({ type: item.action_type, status: item.status }))).toEqual(expect.arrayContaining([{ type: "skill.install", status: "completed" }, { type: "skill.use", status: "completed" }]));
  const use = listPiActions(db).find(item => item.action_type === "skill.use")!;
  expect(JSON.parse(use.result_json).content).toContain("CONVERSATION_SKILL_OK");
  expect(listPiActionEvents(db).filter(item => item.event_type === "tool_call_audit").map(item => JSON.parse(item.payload_json))).toEqual(expect.arrayContaining([expect.objectContaining({ tool: "skill_use", status: "succeeded" })]));
});
