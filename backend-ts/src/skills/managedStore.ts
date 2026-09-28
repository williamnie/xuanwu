import { createHash } from "node:crypto";
import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { mkdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { readSkillRegistry } from "./registry.ts";
import { digestSkillTree, normalizeSkillSource, stageSkillSource, within } from "./managedSource.ts";
import { SkillLibraryError, skillID, type ManagedSkill, type SkillCatalog, type SkillRevision, type SkillScope, type SkillSource } from "./managedTypes.ts";

export type InstallSkillInput = { id: string; scope: SkillScope; project_id?: string; source: SkillSource; enabled?: boolean };
export type ChangeSkillInput = { key: string; expected_revision: string; operation: "enable" | "disable" | "update" | "rollback" | "uninstall"; source?: SkillSource; revision?: string };
export const skillStoreRoot = (stateDir: string) => join(stateDir, "skill-library");
const catalogPath = (stateDir: string) => join(skillStoreRoot(stateDir), "catalog.json");

export function readSkillCatalog(stateDir: string): SkillCatalog {
  const path = catalogPath(stateDir);
  if (!existsSync(path)) return { version: 1, generation: 0, skills: [] };
  try {
    const data = JSON.parse(readFileSync(path, "utf8")) as SkillCatalog;
    if (data.version !== 1 || !Number.isSafeInteger(data.generation) || !Array.isArray(data.skills)) throw new Error();
    for (const skill of data.skills) {
      skillID(skill.id);
      if (!/^[a-f0-9]{24}$/.test(skill.key) || !["instance", "project"].includes(skill.scope) || typeof skill.enabled !== "boolean" || !Array.isArray(skill.revisions) || !skill.revisions.length) throw new Error();
      if (!skill.revisions.some(item => item.revision === skill.revision)) throw new Error();
      for (const revision of skill.revisions) revisionPath(stateDir, revision);
    }
    return data;
  } catch { throw new SkillLibraryError(409, "技能目录索引损坏，请恢复 catalog.json 后重试；现有文件未修改"); }
}

export function visibleManagedSkills(stateDir: string, projectID?: string): ManagedSkill[] {
  return readSkillCatalog(stateDir).skills.filter(item => item.scope === "instance" || item.project_id === projectID)
    .sort((left, right) => (left.scope === "project" ? -1 : 1) - (right.scope === "project" ? -1 : 1));
}

export function currentSkillRevision(skill: ManagedSkill): SkillRevision {
  const current = skill.revisions.find(item => item.revision === skill.revision);
  if (!current) throw new SkillLibraryError(409, "技能当前版本不存在");
  return current;
}

export function revisionPath(stateDir: string, revision: SkillRevision): string {
  if (!/^[a-f0-9]{24}\/[a-f0-9-]{36}\/[a-z0-9-]+$/.test(revision.directory)) throw new SkillLibraryError(409, "技能版本路径无效");
  const root = join(skillStoreRoot(stateDir), "packages");
  const path = resolve(root, revision.directory);
  if (!within(root, path)) throw new SkillLibraryError(409, "技能版本路径越界");
  return path;
}

export async function installManagedSkill(stateDir: string, input: InstallSkillInput): Promise<ManagedSkill> {
  const id = skillID(input.id);
  if (!["instance", "project"].includes(input.scope)) throw new SkillLibraryError(400, "请选择实例或项目作用域");
  const projectID = input.scope === "project" ? input.project_id?.trim() : "";
  if (input.scope === "project" && !projectID) throw new SkillLibraryError(400, "项目级安装需要 project_id");
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new SkillLibraryError(400, "enabled 必须是布尔值");
  const source = normalizeSkillSource(input.source);
  const key = createHash("sha256").update(`${input.scope}\0${projectID}\0${id}`).digest("hex").slice(0, 24);
  return await mutateCatalog(stateDir, async catalog => {
    if (catalog.skills.some(item => item.key === key)) throw new SkillLibraryError(409, "该作用域已安装同名技能，请使用更新操作");
    const revision = await stageRevision(stateDir, key, id, source);
    const skill: ManagedSkill = { key, id, scope: input.scope, project_id: projectID || "", enabled: input.enabled ?? true, revision: revision.revision, revisions: [revision] };
    catalog.skills.push(skill);
    return skill;
  });
}

export async function changeManagedSkill(stateDir: string, input: ChangeSkillInput): Promise<ManagedSkill> {
  return await mutateCatalog(stateDir, async catalog => {
    const skill = catalog.skills.find(item => item.key === input.key);
    if (!skill) throw new SkillLibraryError(404, "技能未安装或已卸载");
    if (input.expected_revision !== skill.revision) throw new SkillLibraryError(409, "技能版本已变化，请刷新后重试");
    switch (input.operation) {
      case "enable": await validateManagedSkill(stateDir, skill); skill.enabled = true; break;
      case "disable": skill.enabled = false; break;
      case "uninstall": catalog.skills = catalog.skills.filter(item => item.key !== skill.key); break;
      case "update": {
        const revision = await stageRevision(stateDir, skill.key, skill.id, normalizeSkillSource(input.source ?? currentSkillRevision(skill).source));
        if (revision.digest === currentSkillRevision(skill).digest && revision.resolved_ref === currentSkillRevision(skill).resolved_ref && JSON.stringify(revision.source) === JSON.stringify(currentSkillRevision(skill).source)) {
          await rm(join(skillStoreRoot(stateDir), "packages", skill.key, revision.revision), { recursive: true, force: true });
          break;
        }
        // 保留旧版本，更新失败不会替换当前版本，回滚不需要网络。
        skill.revisions.push(revision);
        skill.revision = revision.revision;
        break;
      }
      case "rollback": {
        const revision = input.revision ? skill.revisions.find(item => item.revision === input.revision)
          : skill.revisions.filter(item => item.revision !== skill.revision).at(-1);
        if (!revision) throw new SkillLibraryError(400, "没有可回滚版本");
        await validateManagedSkill(stateDir, { ...skill, revision: revision.revision });
        skill.revision = revision.revision;
        break;
      }
      default: throw new SkillLibraryError(400, "未知的技能操作");
    }
    return skill;
  }, async skill => {
    if (input.operation !== "uninstall") return;
    // 先撤销索引，再在同一独占锁内清除自有版本；不触碰原始来源目录。
    try { await rm(join(skillStoreRoot(stateDir), "packages", skill.key), { recursive: true, force: true }); }
    catch { skill.cleanup_pending = true; }
  });
}

export async function validateManagedSkill(stateDir: string, skill: ManagedSkill) {
  const revision = currentSkillRevision(skill);
  const directory = revisionPath(stateDir, revision);
  const canonical = await realpath(directory).catch(() => { throw new SkillLibraryError(409, "技能文件缺失，请更新或重新安装"); });
  if (!within(await realpath(skillStoreRoot(stateDir)), canonical)) throw new SkillLibraryError(409, "技能目录越界");
  const tree = await digestSkillTree(directory);
  if (tree.digest !== revision.digest) throw new SkillLibraryError(409, "技能文件与安装时的校验值不一致，请更新或重新安装");
  const registry = readSkillRegistry({ roots: [{ label: "managed", path: directory }] });
  const metadata = registry.items[0];
  if (!metadata || registry.diagnostics.some(item => item.code !== "missing_tool")) throw new SkillLibraryError(400, "技能 SKILL.md 或 manifest.json 无效");
  return { metadata, ...tree, directory };
}

async function stageRevision(stateDir: string, key: string, id: string, source: SkillSource): Promise<SkillRevision> {
  const revision = crypto.randomUUID();
  const root = skillStoreRoot(stateDir), scratch = join(root, "staging", revision);
  const directory = `${key}/${revision}/${id}`;
  const destination = join(scratch, id);
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  try {
    const staged = await stageSkillSource(source, destination, scratch);
    const registry = readSkillRegistry({ roots: [{ label: "staged", path: destination }] });
    const metadata = registry.items[0];
    if (!metadata || registry.diagnostics.length) throw new SkillLibraryError(400, `技能校验失败：${registry.diagnostics.map(item => item.message).join("；") || "缺少 SKILL.md"}`);
    if (metadata.name !== id) throw new SkillLibraryError(400, `SKILL.md 的 name (${metadata.name}) 必须与安装名称 (${id}) 一致`);
    const sdk = loadSkillsFromDir({ dir: destination, source: "xuanwu-library" });
    if (!sdk.skills.some(item => item.name === id) || sdk.diagnostics.length) throw new SkillLibraryError(400, `Pi 技能加载校验失败：${sdk.diagnostics.map(item => item.message).join("；")}`);
    const target = join(root, "packages", key, revision);
    await mkdir(target, { recursive: true, mode: 0o700 });
    await rename(destination, join(target, id));
    return { revision, directory, digest: staged.digest, source, resolved_ref: staged.resolved_ref, installed_at: new Date().toISOString() };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

async function mutateCatalog<T>(stateDir: string, mutate: (catalog: SkillCatalog) => Promise<T>, afterCommit?: (result: T) => Promise<void>): Promise<T> {
  const root = skillStoreRoot(stateDir);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lockPath = join(root, "catalog.lock");
  const lock = acquireLock(lockPath);
  const temporary = join(root, `catalog.${crypto.randomUUID()}.tmp`);
  try {
    const catalog = readSkillCatalog(stateDir);
    const result = await mutate(catalog);
    catalog.generation++;
    await writeFile(temporary, JSON.stringify(catalog, null, 2), { flag: "wx", mode: 0o600 });
    await rename(temporary, catalogPath(stateDir));
    await afterCommit?.(result);
    return result;
  } finally {
    closeSync(lock);
    await rm(lockPath, { force: true });
    await rm(temporary, { force: true });
  }
}

function acquireLock(path: string): number {
  const acquire = () => {
    const fd = openSync(path, "wx", 0o600);
    try { writeSync(fd, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })); }
    catch (error) { closeSync(fd); unlinkSync(path); throw error; }
    return fd;
  };
  try { return acquire(); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    let before;
    try { before = statSync(path); }
    catch (failure) {
      if ((failure as NodeJS.ErrnoException).code === "ENOENT") {
        try { return acquire(); } catch { throw new SkillLibraryError(409, "另一个技能操作正在进行，请稍后重试"); }
      }
      throw failure;
    }
    let stale = false;
    try {
      const { pid } = JSON.parse(readFileSync(path, "utf8"));
      if (Number.isSafeInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); } catch (failure) { stale = (failure as NodeJS.ErrnoException).code === "ESRCH"; }
      }
    } catch { stale = Date.now() - before.mtimeMs > 300_000; }
    if (stale && statSync(path).ino === before.ino) {
      unlinkSync(path);
      try { return acquire(); } catch { /* 另一个进程先获得了锁。 */ }
    }
    throw new SkillLibraryError(409, "另一个技能操作正在进行，请稍后重试");
  }
}
