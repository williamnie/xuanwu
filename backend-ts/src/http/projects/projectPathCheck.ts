import { stat } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, parse } from "node:path";
import type { RunnerDatabase } from "../../db/database.ts";
import { listProjects } from "../../db/repositories/projects.ts";
import { HttpError } from "../errors.ts";
import { nextProjectID } from "./projectSync.ts";

// This probe deliberately inspects filesystem metadata only. A .git file also
// represents a linked worktree; do not spawn git or mutate project registration.
export async function checkProjectPath(db: RunnerDatabase, input: string | null) {
  const value = input?.trim() || "";
  if (!value || !isAbsolute(value) || value.includes("\0")) {
    throw new HttpError(400, "请输入本地文件夹的绝对路径");
  }
  const cwd = normalizedPath(value);
  const entry = await pathStat(cwd);
  const directory = entry?.isDirectory() === true;
  const gitEntry = directory ? await pathStat(join(cwd, ".git")) : null;
  const projects = listProjects(db);
  const existing = projects.find(project => normalizedPath(project.cwd) === cwd);
  return {
    exists: Boolean(entry),
    directory,
    git_repo: Boolean(gitEntry?.isDirectory() || gitEntry?.isFile()),
    suggested_id: existing?.id || nextProjectID(basename(cwd), cwd, new Set(projects.map(project => project.id))),
    existing_project_id: existing?.id || null
  };
}

function normalizedPath(value: string): string {
  const path = normalize(value);
  return path === parse(path).root ? path : path.replace(/[\\/]+$/, "");
}

async function pathStat(path: string) {
  try {
    return await stat(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw new HttpError(400, "无法读取此路径，请检查文件夹访问权限");
  }
}
