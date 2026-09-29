import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { rememberPiMemoryItem, updatePiMemoryItem } from "../db/repositories/pi/memoryItems.ts";
import { seedMemoryExperience } from "../pi/memoryExperienceTestFixtures.ts";
import { createSkillLibraryTools } from "../pi/skillLibraryTools.ts";
import { createDefaultRouter } from "../http/server.ts";
import { createExperienceTemplateDraft, selectExperienceTemplate } from "./experienceTemplates.ts";
import { changeManagedSkill, installManagedSkill, readSkillCatalog } from "./managedStore.ts";
import { readLibrarySkillResource, verifyLibrarySkill } from "./libraryService.ts";
import { buildSkillPromptContext } from "./promptContext.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { buildIssuePromptForTest } from "../runner/projectLoop.ts";
import { createPiRuntimeResourceLoader } from "../http/piRuntimeResources.ts";
import { loadSmokeRuntime, resolveDefaultRepoRoot } from "../spikes/piSmokeSupport.ts";
import { loadAssistantToolRegistrySnapshot } from "../pi/toolRegistrySnapshot.ts";

const resources: { db: RunnerDatabase; root: string }[] = [];
afterEach(async () => { for (const { db, root } of resources.splice(0)) { db.close(); await rm(root, { recursive: true, force: true }); } });

async function fixture(count = 2) {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-experience-template-"));
  const db = await openDatabase({ stateDir: root }); resources.push({ db, root });
  const seeds = Array.from({ length: count }, () => seedMemoryExperience(db));
  let memory;
  for (const seed of seeds) memory = rememberPiMemoryItem(db, {
    id: "stable-timeout", scope: "project", scope_id: "demo", kind: "resolution", memory_key: "timeout.cleanup",
    authority: "evidence_backed", confidence: "high", layer: "long_term", content: JSON.stringify(seed.experience)
  });
  const input = { id: "timeout-template", project_id: "demo", memory_id: memory!.id, expected_memory_revision: memory!.revision };
  return { db, root, seeds, memory: memory!, input, project: getProject(db, "demo")! };
}

function httpPost(db: RunnerDatabase) {
  const router = createDefaultRouter({ database: db });
  return (path: string, body: unknown) => router.handle(new Request(`http://localhost/api/pi/skill-library/${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body)
  }));
}

for (const operation of ["install", "enable", "rollback"] as const) test(`generic HTTP ${operation} cannot bypass template selection`, async () => {
  const { db, root, input, memory } = await fixture();
  const post = httpPost(db);
  const draft = createExperienceTemplateDraft(db, input);
  let body: Record<string, unknown> = { id: input.id, project_id: input.project_id, scope: "project", enabled: true,
    source: { kind: "inline", content: draft.content } };
  if (operation !== "install") {
    const first = await selectExperienceTemplate(db, { ...input, template_revision: draft.template_revision, choice: "save" }) as any;
    let current = first.skill;
    if (operation === "rollback") {
      const seed = seedMemoryExperience(db);
      const latest = rememberPiMemoryItem(db, { ...memory, content: JSON.stringify(seed.experience) });
      const nextInput = { ...input, expected_memory_revision: latest.revision };
      const next = createExperienceTemplateDraft(db, nextInput);
      current = (await selectExperienceTemplate(db, { ...nextInput, key: first.skill.key, expected_revision: first.skill.revision,
        template_revision: next.template_revision, choice: "save" }) as any).skill;
    }
    body = { key: current.key, expected_revision: current.revision, operation,
      ...(operation === "rollback" ? { revision: first.skill.revision } : {}) };
  }
  const before = readSkillCatalog(root);
  const response = await post(operation === "install" ? "install" : "manage", body);
  expect(response.status).toBe(403);
  expect(await response.text()).toContain("明确选择");
  expect(readSkillCatalog(root)).toEqual(before);
  const forged = await post(operation === "install" ? "install" : "manage", { ...body, experienceTemplateSelection: true });
  expect(forged.status).toBe(400);
  expect(readSkillCatalog(root)).toEqual(before);
});

test("draft requires independent verified Works and never installs or enables a skill", async () => {
  const single = await fixture(1);
  await expect(Promise.resolve().then(() => createExperienceTemplateDraft(single.db, single.input))).rejects.toThrow("至少两个");
  // 人为计数不能替代持久化证据，也不能把重复复盘当作新任务。
  single.db.sqlite.run("update pi_memory_items set occurrence_count=99 where id=?", [single.memory.id]);
  expect(() => createExperienceTemplateDraft(single.db, single.input)).toThrow("至少两个");
  const { db, root, input, seeds } = await fixture();
  const draft = createExperienceTemplateDraft(db, input);
  expect(draft).toMatchObject({ status: "draft", enabled: false, scope: "project", project_id: "demo" });
  expect(draft.provenance.validations.map(item => item.work_id)).toEqual(seeds.map(seed => seed.workID));
  for (const title of ["输入要求", "适用条件", "步骤", "验证方式", "交付目标"]) expect(draft.content).toContain(title);
  expect(draft.content).toContain("完成后移除超时回调");
  expect(readSkillCatalog(root).skills).toHaveLength(0);
  expect(createExperienceTemplateDraft(db, input).template_revision).toBe(draft.template_revision);
});

test("rejects stale, cross-project, disabled, untrusted, superseded and diagnosis-only experience", async () => {
  const { db, input, seeds, memory } = await fixture();
  expect(() => createExperienceTemplateDraft(db, { ...input, expected_memory_revision: 1 })).toThrow("版本");
  expect(() => createExperienceTemplateDraft(db, { ...input, project_id: "another" })).toThrow("项目");
  seeds[0].persistEvidence({ ...seeds[0].evidence, id: "xw:evidence:issue_events:correction", supersedes_id: seeds[0].evidence.id, status: "failed" });
  expect(() => createExperienceTemplateDraft(db, input)).toThrow("至少两个");
  const disabled = updatePiMemoryItem(db, memory.id, { disabled: 1 });
  expect(() => createExperienceTemplateDraft(db, { ...input, expected_memory_revision: disabled.revision })).toThrow("停用");
  const diagnosis = await fixture();
  const diagnostic = updatePiMemoryItem(diagnosis.db, diagnosis.memory.id, { content: JSON.stringify({ ...diagnosis.seeds[1].experience, outcome: "diagnosis_only" }) });
  expect(() => createExperienceTemplateDraft(diagnosis.db, { ...diagnosis.input, expected_memory_revision: diagnostic.revision })).toThrow("解决经验");
  const untrusted = await fixture();
  const seed = untrusted.seeds[1];
  const claim: typeof seed.evidence = { ...seed.evidence, id: "xw:evidence:issue_events:agent-claim", provenance: { ...seed.evidence.provenance, assertion_origin: "agent_claim", source_kind: "agent_statement" } };
  seed.persistEvidence(claim);
  const changed = updatePiMemoryItem(untrusted.db, untrusted.memory.id, { content: JSON.stringify({ ...seed.experience, verification: { ...seed.experience.verification, evidence_refs: [`evidence:${claim.id}`] } }) });
  expect(() => createExperienceTemplateDraft(untrusted.db, { ...untrusted.input, expected_memory_revision: changed.revision })).toThrow("trusted");
});

test("rejects secrets and old task state before returning a draft", async () => {
  for (const [resolution, reason] of [["token=do-not-copy-this-value", "敏感信息"], ["当前任务 #12 已完成", "旧任务"], ["继续处理 xw:work:issues:123", "旧任务"]]) {
    const { db, input, seeds, memory } = await fixture();
    const edited = updatePiMemoryItem(db, memory.id, { content: JSON.stringify({ ...seeds[1].experience, resolution }) });
    expect(() => createExperienceTemplateDraft(db, { ...input, expected_memory_revision: edited.revision })).toThrow(reason);
    expect(readSkillCatalog(join(db.path, "..")).skills).toHaveLength(0);
  }
});

test("explicit save is disabled, explicit enable replays in a new task with unchanged tool ceilings", async () => {
  const { db, root, input, project } = await fixture();
  const draft = createExperienceTemplateDraft(db, input);
  const post = httpPost(db);
  const selection = { ...input, template_revision: draft.template_revision };
  expect((await post("templates/select", selection)).status).toBe(400);
  expect(readSkillCatalog(root).skills).toHaveLength(0);
  const response = await post("templates/select", { ...selection, choice: "save" });
  expect(response.status).toBe(200);
  const saved = await response.json() as any;
  expect(saved.skill.enabled).toBe(false);
  expect((await verifyLibrarySkill(db, saved.skill.key)).status).toBe("disabled");
  expect(buildSkillPromptContext(db, { project }).audit.injected_skill_ids).not.toContain(input.id);
  const tools = createSkillLibraryTools(db, project, { source: "runner_chat" });
  await expect(tools.find(tool => tool.name === "skill_manage")!.execute("auto-enable", {
    key: saved.skill.key, expected_revision: saved.skill.revision, operation: "enable"
  }, undefined, undefined, undefined as never)).rejects.toThrow("明确选择");
  const enable = { ...selection, key: saved.skill.key, expected_revision: saved.skill.revision, choice: "enable" as const };
  expect((await post("templates/select", { ...enable, template_revision: "0".repeat(64) })).status).toBe(409);
  expect((await post("templates/select", { ...enable, expected_memory_revision: 1 })).status).toBe(409);
  expect(await selectExperienceTemplate(db, enable, { source: "runner_chat", authorization: {
    forbiddenActions: ["skill.enable"], scope: { project_id: "demo" }
  } })).toMatchObject({ status: "denied" });
  expect(readSkillCatalog(root).skills[0]!.enabled).toBe(false);
  expect((await post("templates/select", enable)).status).toBe(200);
  const newTaskTools = createSkillLibraryTools(db, project, { source: "runner_chat" });
  const replay = await newTaskTools.find(tool => tool.name === "skill_use")!.execute("new-task", { id: input.id }, undefined, undefined, undefined as never);
  expect((replay.details as any).content).toBe(draft.content);
  expect((replay.details as any).revision).toBe(saved.skill.revision);
  expect(buildSkillPromptContext(db, { project, authorization: { allowedSkillIntents: ["xuanwu"] } }).audit.injected_skill_ids).not.toContain(input.id);
  expect(buildSkillPromptContext(db, {}).audit.injected_skill_ids).not.toContain(input.id);
  const newIssue = createIssue(db, { project_id: "demo", title: "Verify a new callback cleanup task", required_skill_intents: [input.id] });
  const prompt = buildIssuePromptForTest(project, newIssue, db);
  expect(prompt).toContain(saved.skill.revision);
  expect(prompt).toContain("Verify a new callback cleanup task");
  const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot());
  const loader = await createPiRuntimeResourceLoader(sdk, db, { conversationID: "new-template-task", project, promptProfile: "chat" } as any, {
    agentDir: join(root, "pi-runtime", "agent"), cwd: project.cwd, runtimeRoot: resolveDefaultRepoRoot(), systemPrompt: "fixture"
  });
  expect(loader.getSkills().skills.map(skill => skill.name)).toContain(input.id);
  expect(loader.snapshot().diagnostics).toEqual([]);
});

test("selection checks reviewed hash, gate authorization and memory revision; generic install cannot bypass it", async () => {
  const { db, root, input } = await fixture();
  const draft = createExperienceTemplateDraft(db, input);
  await expect(installManagedSkill(root, { id: input.id, scope: "project", project_id: "demo", source: { kind: "inline", content: draft.content } })).rejects.toThrow("明确选择");
  await expect(installManagedSkill(root, { id: input.id, scope: "instance", source: { kind: "inline", content: draft.content } }, { experienceTemplateSelection: true })).rejects.toThrow("项目范围");
  await expect(selectExperienceTemplate(db, { ...input, template_revision: "stale", choice: "save" })).rejects.toThrow("草稿");
  const denied = await selectExperienceTemplate(db, { ...input, template_revision: draft.template_revision, choice: "save_and_enable" }, {
    source: "runner_chat", authorization: { mode: "delegated", forbiddenActions: ["skill.install"], scope: { project_id: "demo" } }
  });
  expect(denied).toMatchObject({ status: "denied" });
  expect(readSkillCatalog(root).skills).toHaveLength(0);
  const changed = updatePiMemoryItem(db, input.memory_id, { confidence: "medium" });
  await expect(selectExperienceTemplate(db, { ...input, template_revision: draft.template_revision, choice: "save" })).rejects.toThrow("经验版本");
  expect(changed.revision).toBeGreaterThan(input.expected_memory_revision);
});

test("Pi discovers a read-only draft tool whose project and Action Gate limits cannot grant a save", async () => {
  const { db, root, project, input } = await fixture();
  const registry = loadAssistantToolRegistrySnapshot(db);
  expect(registry.tools.find(tool => tool.name === "skill_template_draft")?.permission).toBe("read");
  expect(registry.tools.find(tool => tool.name === "skill_template_select")).toBeUndefined();
  const invoke = (context: Parameters<typeof createSkillLibraryTools>[2], params = input) =>
    createSkillLibraryTools(db, project, context).find(tool => tool.name === "skill_template_draft")!.execute("draft", params, undefined, undefined, undefined as never);
  expect((await invoke({ source: "runner_chat" })).details).toMatchObject({ status: "draft" });
  expect((await invoke({ source: "runner_chat", authorization: { forbiddenActions: ["skill.inspect_source"] } })).details).toMatchObject({ status: "denied" });
  await expect(invoke({ source: "runner_chat" }, { ...input, project_id: "another" })).rejects.toThrow("项目范围");
  expect(readSkillCatalog(root).skills).toHaveLength(0);
});

test("narrowed experience must collect independent validations again", async () => {
  const { db, memory, input } = await fixture();
  const narrower = (seed: ReturnType<typeof seedMemoryExperience>) => ({ ...seed.experience, applies_when: `${seed.experience.applies_when}且使用共享响应对象` });
  const correction = seedMemoryExperience(db);
  const corrected = rememberPiMemoryItem(db, { ...memory, content: JSON.stringify(narrower(correction)) }, {
    correction: { expected_revision: memory.revision, disposition: "narrow", reason: "新证据限定为共享响应对象" }
  });
  expect(() => createExperienceTemplateDraft(db, { ...input, expected_memory_revision: corrected.revision })).toThrow("至少两个");
  const revalidated = seedMemoryExperience(db);
  const latest = rememberPiMemoryItem(db, { ...corrected, content: JSON.stringify(narrower(revalidated)) });
  const draft = createExperienceTemplateDraft(db, { ...input, expected_memory_revision: latest.revision });
  expect(draft.provenance.validations.map(value => value.work_id)).toEqual([correction.workID, revalidated.workID]);
});

test("template updates and rollbacks reuse immutable skill versions and reject conflicting revisions", async () => {
  const { db, root, input, seeds, memory } = await fixture();
  const draft = createExperienceTemplateDraft(db, input);
  const first = await selectExperienceTemplate(db, { ...input, template_revision: draft.template_revision, choice: "save_and_enable" }) as any;
  const third = seedMemoryExperience(db);
  const latest = rememberPiMemoryItem(db, { ...memory, content: JSON.stringify(third.experience) });
  const nextInput = { ...input, expected_memory_revision: latest.revision };
  const next = createExperienceTemplateDraft(db, nextInput);
  const second = await selectExperienceTemplate(db, { ...nextInput, template_revision: next.template_revision, choice: "save", key: first.skill.key, expected_revision: first.skill.revision }) as any;
  expect(second.skill.revision).not.toBe(first.skill.revision);
  expect(second.skill.enabled).toBe(true); // 更新保留用户此前的启用选择。
  await expect(selectExperienceTemplate(db, { ...nextInput, template_revision: next.template_revision, choice: "save", key: first.skill.key, expected_revision: first.skill.revision })).rejects.toThrow("版本");
  await expect(changeManagedSkill(root, { key: first.skill.key, expected_revision: second.skill.revision, operation: "update", source: { kind: "inline", content: "---\nname: timeout-template\ndescription: overwritten\n---\nerase provenance" } })).rejects.toThrow("明确选择");
  const post = httpPost(db);
  const rollback = { ...nextInput, template_revision: draft.template_revision, key: first.skill.key,
    expected_revision: second.skill.revision, revision: first.skill.revision, choice: "rollback" as const };
  expect((await post("templates/select", { ...rollback, choice: undefined })).status).toBe(400);
  expect((await post("templates/select", { ...rollback, revision: undefined })).status).toBe(400);
  expect((await post("templates/select", { ...rollback, template_revision: next.template_revision })).status).toBe(409);
  expect((await post("templates/select", { ...rollback, expected_memory_revision: memory.revision })).status).toBe(409);
  expect((await post("templates/select", { ...rollback, expected_revision: first.skill.revision })).status).toBe(409);
  expect(await selectExperienceTemplate(db, rollback, { source: "runner_chat", authorization: {
    forbiddenActions: ["skill.rollback"], scope: { project_id: "demo" }
  } })).toMatchObject({ status: "denied" });
  expect(readSkillCatalog(root).skills[0]!.revision).toBe(second.skill.revision);
  const response = await post("templates/select", rollback);
  expect(response.status).toBe(200);
  expect((await response.json() as any).skill.revision).toBe(first.skill.revision);
  expect((await readLibrarySkillResource(db, input.id, undefined, getProject(db, "demo")!)).content).toContain(seeds[0].workID);
  const edited = updatePiMemoryItem(db, memory.id, { content: JSON.stringify({ ...third.experience, applies_when: "仅限修正后的更小范围" }) });
  const before = readSkillCatalog(root);
  expect((await post("templates/select", { ...rollback, expected_memory_revision: edited.revision, expected_revision: first.skill.revision, revision: second.skill.revision,
    template_revision: next.template_revision })).status).toBe(409);
  expect(readSkillCatalog(root)).toEqual(before);
});
