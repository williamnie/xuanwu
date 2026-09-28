import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type RunnerDatabase } from "../db/database.ts";
import { getProject } from "../db/repositories/projects.ts";
import { createDefaultRouter } from "../http/server.ts";
import { createSkillLibraryTools } from "../pi/skillLibraryTools.ts";
import { loadSmokeRuntime, resolveDefaultRepoRoot } from "../spikes/piSmokeSupport.ts";
import { createPiRuntimeResourceLoader } from "../http/piRuntimeResources.ts";
import { installManagedSkill, changeManagedSkill, readSkillCatalog, currentSkillRevision, revisionPath } from "./managedStore.ts";
import { normalizeSkillSource } from "./managedSource.ts";
import { listSkillLibrary, verifyLibrarySkill, readLibrarySkillResource } from "./libraryService.ts";
import { buildSkillPromptContext } from "./promptContext.ts";
import { inspectSkillSource } from "./sourceInspection.ts";
import { existsSync } from "node:fs";
import { readSkillRegistry } from "./registry.ts";
import { createIssue } from "../db/repositories/issueCreate.ts";
import { buildIssuePromptForTest } from "../runner/projectLoop.ts";

const roots: string[] = [];
const databases: RunnerDatabase[] = [];
afterEach(async () => { while (databases.length) databases.pop()!.close(); while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });
const content = (body = "Return the marker SKILL_READY after reading references/guide.md.") => `---\nname: demo-skill\ndescription: |\n  A deterministic demonstration skill.\n  Use for skill lifecycle verification.\n---\n${body}\n`;
const inline = (body?: string) => ({ id: "demo-skill", scope: "instance" as const, source: { kind: "inline" as const, content: content(body) } });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "xuanwu-managed-skills-")); roots.push(root);
  const stateDir = join(root, "state"), cwd = join(root, "project");
  await mkdir(cwd);
  const db = await openDatabase({ stateDir }); databases.push(db);
  db.sqlite.run("insert into projects (id,name,cwd,created_at,updated_at) values (?,?,?,?,?)", ["demo", "Demo", cwd, "2026-01-01", "2026-01-01"]);
  return { root, stateDir, cwd, db, project: getProject(db, "demo")! };
}

describe("managed skill lifecycle", () => {
  test("install, persist, load SDK, update, rollback, disable and uninstall", async () => {
    const { db, stateDir } = await fixture();
    const first = await installManagedSkill(stateDir, inline("Version one"));
    expect(readSkillCatalog(stateDir).skills[0]?.revision).toBe(first.revision);
    expect((await verifyLibrarySkill(db, first.key)).checks).toEqual({ integrity: true, metadata: true, sdk_load: true, tools: true });
    expect((await readLibrarySkillResource(db, first.id)).content).toContain("Version one");
    const second = await changeManagedSkill(stateDir, { key: first.key, expected_revision: first.revision, operation: "update", source: inline("Version two").source });
    expect(second.revision).not.toBe(first.revision);
    expect((await readLibrarySkillResource(db, first.id)).content).toContain("Version two");
    await expect(changeManagedSkill(stateDir, { key: first.key, expected_revision: first.revision, operation: "disable" })).rejects.toThrow("版本已变化");
    const rolled = await changeManagedSkill(stateDir, { key: first.key, expected_revision: second.revision, operation: "rollback" });
    expect(rolled.revision).toBe(first.revision);
    expect((await readLibrarySkillResource(db, first.id)).content).toContain("Version one");
    await changeManagedSkill(stateDir, { key: first.key, expected_revision: first.revision, operation: "disable" });
    expect(buildSkillPromptContext(db, {}).audit.injected_skill_ids).not.toContain(first.id);
    await expect(readLibrarySkillResource(db, first.id)).rejects.toThrow("已停用");
    await changeManagedSkill(stateDir, { key: first.key, expected_revision: first.revision, operation: "uninstall" });
    expect(listSkillLibrary(db).installed).toHaveLength(0);
    expect(listSkillLibrary(db).discovered.map(item => item.id)).not.toContain(first.id);
    expect(existsSync(revisionPath(stateDir, currentSkillRevision(first)))).toBe(false);
  });

  test("local packages preserve references and scripts without executing them", async () => {
    const { db, stateDir, root } = await fixture();
    const source = join(root, "source"); await mkdir(join(source, "references"), { recursive: true }); await mkdir(join(source, "scripts"));
    await writeFile(join(source, "SKILL.md"), content());
    await writeFile(join(source, "references", "guide.md"), "A local resource marker");
    await writeFile(join(source, "scripts", "example.sh"), "exit 99");
    const installed = await installManagedSkill(stateDir, { ...inline(), source: { kind: "local", location: source } });
    expect((await verifyLibrarySkill(db, installed.key)).scripts).toEqual(["scripts/example.sh"]);
    expect((await readLibrarySkillResource(db, installed.id, "references/guide.md")).content).toBe("A local resource marker");
    await expect(readLibrarySkillResource(db, installed.id, "../../../../catalog.json")).rejects.toThrow();
    expect((await verifyLibrarySkill(db, installed.key)).execution_verified).toBe(false);
  });

  test("rejects invalid update, duplicates, symlinks, secrets and tampering while retaining the good version", async () => {
    const { db, stateDir, root } = await fixture();
    const first = await installManagedSkill(stateDir, inline());
    await expect(installManagedSkill(stateDir, inline())).rejects.toThrow("同名");
    await expect(changeManagedSkill(stateDir, { key: first.key, expected_revision: first.revision, operation: "update", source: { kind: "inline", content: "invalid" } })).rejects.toThrow("校验失败");
    expect(readSkillCatalog(stateDir).skills[0]?.revision).toBe(first.revision);
    const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "SKILL.md"), content());
    await symlink(join(root, "state"), join(source, "escape"));
    await expect(changeManagedSkill(stateDir, { key: first.key, expected_revision: first.revision, operation: "update", source: { kind: "local", location: source } })).rejects.toThrow("符号链接");
    await rm(join(source, "escape")); await writeFile(join(source, ".env"), "FAKE_SECRET=x");
    await expect(changeManagedSkill(stateDir, { key: first.key, expected_revision: first.revision, operation: "update", source: { kind: "local", location: source } })).rejects.toThrow("凭据");
    await writeFile(join(revisionPath(stateDir, currentSkillRevision(first)), "SKILL.md"), content("tampered"));
    expect(await verifyLibrarySkill(db, first.key)).toMatchObject({ status: "blocked", checks: { integrity: false } });
  });

  test("project isolation, project override and delegated ceilings remain authoritative", async () => {
    const { db, stateDir, project } = await fixture();
    await installManagedSkill(stateDir, inline("Instance"));
    const local = await installManagedSkill(stateDir, { ...inline("Project"), scope: "project", project_id: project.id });
    expect(listSkillLibrary(db).installed).toHaveLength(1);
    expect(listSkillLibrary(db, project.id).installed).toHaveLength(2);
    expect((await readLibrarySkillResource(db, "demo-skill", undefined, project)).content).toContain("Project");
    expect(buildSkillPromptContext(db, { project, authorization: { allowedSkillIntents: ["xuanwu"] } }).audit.injected_skill_ids).not.toContain("demo-skill");
    await changeManagedSkill(stateDir, { key: local.key, expected_revision: local.revision, operation: "disable" });
    expect(buildSkillPromptContext(db, { project }).audit.injected_skill_ids).not.toContain("demo-skill");
    expect(buildSkillPromptContext(db, {}).audit.injected_skill_ids).toContain("demo-skill");
  });

  test("concurrent mutations do not lose catalog entries", async () => {
    const { stateDir } = await fixture();
    const results = await Promise.allSettled([installManagedSkill(stateDir, inline()), installManagedSkill(stateDir, inline())]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(readSkillCatalog(stateDir).skills).toHaveLength(1);
  });

  test("executor handoff carries the requested installed version and base directory without dumping other skills", async () => {
    const { db, stateDir, project } = await fixture();
    const skill = await installManagedSkill(stateDir, { ...inline(), scope: "project", project_id: project.id });
    const issue = createIssue(db, { project_id: project.id, title: "Run the selected skill", required_skill_intents: ["demo-skill"] });
    const prompt = buildIssuePromptForTest(project, issue, db);
    expect(prompt).toContain(skill.revision);
    expect(prompt).toContain(revisionPath(stateDir, currentSkillRevision(skill)));
    expect(prompt).toContain("Keep this version immutable");
    expect(prompt).not.toContain("babysit-repo");
    await changeManagedSkill(stateDir, { key: skill.key, expected_revision: skill.revision, operation: "disable" });
    expect(buildIssuePromptForTest(project, issue, db)).not.toContain(skill.revision);
  });

  test("discovers source candidates without installing, recovers dead process locks and keeps no-op updates stable", async () => {
    const { root, stateDir } = await fixture();
    const source = join(root, "source", "skills", "demo-skill"); await mkdir(source, { recursive: true }); await writeFile(join(source, "SKILL.md"), content());
    expect(await inspectSkillSource(stateDir, { kind: "local", location: join(root, "source") })).toMatchObject({ candidates: [{ id: "demo-skill", subdirectory: "skills/demo-skill" }] });
    expect(readSkillCatalog(stateDir).skills).toHaveLength(0);
    await writeFile(join(stateDir, "skill-library", "catalog.lock"), JSON.stringify({ pid: 99999999 }));
    const skill = await installManagedSkill(stateDir, inline());
    const next = await changeManagedSkill(stateDir, { key: skill.key, expected_revision: skill.revision, operation: "update" });
    expect(next.revision).toBe(skill.revision);
    expect(next.revisions).toHaveLength(1);
  });

  test("missing required tools block skill use and SDK injection with deterministic diagnostics", async () => {
    const { db, stateDir, root, project } = await fixture();
    const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "SKILL.md"), content());
    const manifest = JSON.parse(await readFile(new URL("../../../skills/pi-domain-proposal/manifest.json", import.meta.url), "utf8"));
    manifest.required_tools = ["unavailable:tool:search"];
    await writeFile(join(source, "manifest.json"), JSON.stringify(manifest));
    const installed = await installManagedSkill(stateDir, { ...inline(), source: { kind: "local", location: source } });
    expect(await verifyLibrarySkill(db, installed.key)).toMatchObject({ status: "blocked", checks: { tools: false } });
    await expect(readLibrarySkillResource(db, installed.id)).rejects.toThrow("依赖");
    const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot());
    const loader = await createPiRuntimeResourceLoader(sdk, db, { conversationID: "missing-tools", project, promptProfile: "chat" } as any, { agentDir: join(stateDir, "pi-runtime", "agent"), cwd: project.cwd, runtimeRoot: resolveDefaultRepoRoot(), systemPrompt: "fixture" });
    expect(loader.getSkills().skills).toHaveLength(0);
    expect(loader.snapshot().diagnostics).toContainEqual(expect.objectContaining({ code: "installed_skill_invalid" }));
  });

  test("unified project discovery honors package manifests and rejects directory and SKILL.md symlink escapes", async () => {
    const { root, cwd } = await fixture();
    const source = join(root, "source"); await mkdir(source); await writeFile(join(source, "SKILL.md"), content());
    await mkdir(join(cwd, ".pi")); await symlink(source, join(cwd, ".pi", "skills"));
    expect(readSkillRegistry({ cwd }).items.map(item => item.id)).not.toContain("demo-skill");
    await rm(join(cwd, ".pi", "skills"));
    const local = join(cwd, ".pi", "custom", "demo-skill"); await mkdir(local, { recursive: true });
    await writeFile(join(cwd, ".pi", "package.json"), JSON.stringify({ pi: { skills: ["custom"] } }));
    await symlink(join(source, "SKILL.md"), join(local, "SKILL.md"));
    expect(readSkillRegistry({ cwd }).items.map(item => item.id)).not.toContain("demo-skill");
    await rm(join(local, "SKILL.md")); await writeFile(join(local, "SKILL.md"), content());
    expect(readSkillRegistry({ cwd }).items.map(item => item.id)).toContain("demo-skill");
  });

  test("normalizes GitHub tree sources and rejects unsafe protocols, credentials, hosts and traversal", () => {
    expect(normalizeSkillSource({ kind: "git", location: "https://github.com/acme/skills/tree/main/skills/demo-skill" })).toMatchObject({ location: "https://github.com/acme/skills", ref: "main", subdirectory: "skills/demo-skill" });
    for (const location of ["file:///tmp/repo", "https://user:secret@github.com/a/b", "https://127.0.0.1/a/b", "https://github.com/a/b?token=secret"]) expect(() => normalizeSkillSource({ kind: "git", location })).toThrow();
    expect(() => normalizeSkillSource({ kind: "local", location: "/tmp", subdirectory: "../outside" })).toThrow();
  });

  test("HTTP and conversation tools share audited install/manage and immediate skill use", async () => {
    const { db, project } = await fixture();
    const router = createDefaultRouter({ database: db });
    const request = (path: string, data: unknown) => router.handle(new Request(`http://localhost/api/pi/skill-library/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) }));
    const installedResponse = await request("install", inline());
    expect(installedResponse.status).toBe(200);
    const result = await installedResponse.json() as any;
    expect(result.verification.status).toBe("ready");
    const tools = createSkillLibraryTools(db, project, { source: "runner_chat" });
    const used = await tools.find(item => item.name === "skill_use")!.execute("test", { id: "demo-skill" }, undefined, undefined, undefined as never);
    expect((used.details as any).content).toContain("SKILL_READY");
    const managed = await request("manage", { key: result.skill.key, expected_revision: result.skill.revision, operation: "disable" });
    expect(managed.status).toBe(200);
    await expect(tools.find(item => item.name === "skill_use")!.execute("test", { id: "demo-skill" }, undefined, undefined, undefined as never)).rejects.toThrow("未启用");
    const deniedTools = createSkillLibraryTools(db, project, { source: "runner_chat", authorization: { mode: "delegated", allowedActions: ["skill.install"], forbiddenActions: ["skill.install"], scope: { project_id: project.id } } });
    const denied = await deniedTools.find(item => item.name === "skill_install")!.execute("test", { ...inline(), scope: "project" }, undefined, undefined, undefined as never);
    expect((denied.details as any).status).toBe("denied");
    expect(db.sqlite.query("select count(*) as total from pi_actions where action_type='skill.install'").get()).toMatchObject({ total: 2 });
    expect((await request("install", { ...inline(), unknown: 1 })).status).toBe(400);
  });

  test("the actual controlled PI loader includes enabled installed skills and excludes disabled ones on a new turn", async () => {
    const { db, stateDir, project } = await fixture();
    const skill = await installManagedSkill(stateDir, { ...inline(), scope: "project", project_id: project.id });
    const sdk = await loadSmokeRuntime(resolveDefaultRepoRoot());
    const options = { agentDir: join(stateDir, "pi-runtime", "agent"), cwd: project.cwd, runtimeRoot: resolveDefaultRepoRoot(), systemPrompt: "fixture" };
    const input = { conversationID: "test-skills", project, promptProfile: "chat" } as any;
    const loader = await createPiRuntimeResourceLoader(sdk, db, input, options);
    expect(loader.getSkills().skills.map(item => item.name)).toContain(skill.id);
    await changeManagedSkill(stateDir, { key: skill.key, expected_revision: skill.revision, operation: "disable" });
    const next = await createPiRuntimeResourceLoader(sdk, db, input, options);
    expect(next.getSkills().skills.map(item => item.name)).not.toContain(skill.id);
  });
});
