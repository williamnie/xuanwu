import { opendir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";

export type ProjectReferenceSearchResult = { files: ProjectPathReference[]; folders: ProjectPathReference[] };
type ProjectPathReference = { file_count?: number; path: string; size_bytes?: number; type: "file" | "folder" };
type SearchFilter = { limit?: number; query?: string; type?: string };
type ScanBudget = { remaining: number; deadline: number; incomplete?: boolean };

const EXCLUDED = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo"]);
const MAX_SCAN_ENTRIES = 20_000;
const MAX_SCAN_MS = 1_500;
const MAX_DEPTH = 64;

export async function searchProjectReferences(cwd: string, filter: SearchFilter): Promise<ProjectReferenceSearchResult> {
  const root = resolve(cwd.trim());
  if (!(await stat(root)).isDirectory()) throw new Error("cwd 不是目录");
  const state: ProjectReferenceSearchResult = { files: [], folders: [] };
  const normalized = normalizeFilter(filter);
  if (!wantType(normalized.type, "file") && !wantType(normalized.type, "folder")) return state;
  const ignored = await loadProjectIgnorePatterns(root);
  const budget = { remaining: MAX_SCAN_ENTRIES, deadline: performance.now() + MAX_SCAN_MS };
  for await (const entry of walk(root, root, ignored, budget)) {
    if (!entry.rel.toLowerCase().includes(normalized.query)) continue;
    if (entry.isDir && wantType(normalized.type, "folder") && state.folders.length < normalized.limit) {
      state.folders.push({ type: "folder", path: entry.rel });
    }
    if (!entry.isDir && wantType(normalized.type, "file") && state.files.length < normalized.limit) {
      try { state.files.push({ type: "file", path: entry.rel, size_bytes: (await stat(entry.path)).size }); }
      catch { /* 扫描期间删除或无权访问的文件不影响其余结果。 */ }
    }
    if (filled(state, normalized)) break;
  }
  // 数量统计共用扫描预算；不完整时省略可选字段，避免把部分计数报告为总数。
  for (const folder of state.folders) {
    if (!withinBudget(budget)) break;
    const count = await countFiles(root, join(root, folder.path), ignored, budget);
    if (count !== undefined) folder.file_count = count;
  }
  state.files.sort(pathSort); state.folders.sort(pathSort);
  return state;
}

async function* walk(root: string, directory: string, ignored: string[], budget: ScanBudget, depth = 0): AsyncGenerator<{ path: string; rel: string; isDir: boolean }> {
  if (!withinBudget(budget) || depth >= MAX_DEPTH) { budget.incomplete = true; return; }
  let entries;
  try { entries = await opendir(directory); } catch { budget.incomplete = true; return; }
  for await (const entry of entries) {
    if (!withinBudget(budget)) break;
    budget.remaining -= 1;
    const path = join(directory, entry.name);
    const rel = relative(root, path).replaceAll("\\", "/");
    if (shouldSkip(rel, ignored)) continue;
    const isDir = entry.isDirectory();
    yield { path, rel, isDir };
    if (isDir) yield* walk(root, path, ignored, budget, depth + 1);
  }
}

async function countFiles(root: string, directory: string, ignored: string[], budget: ScanBudget): Promise<number | undefined> {
  // 单个目录也有限额，避免第一个大目录耗尽所有其他结果的统计预算。
  const local: ScanBudget = { remaining: Math.min(budget.remaining, 2_000), deadline: budget.deadline };
  const before = local.remaining;
  let count = 0;
  for await (const entry of walk(root, directory, ignored, local)) {
    if (!entry.isDir) count += 1;
  }
  budget.remaining -= before - local.remaining;
  return withinBudget(local) && !local.incomplete ? count : undefined;
}

function filled(out: ProjectReferenceSearchResult, filter: Required<SearchFilter>): boolean {
  return (!wantType(filter.type, "file") || out.files.length >= filter.limit)
    && (!wantType(filter.type, "folder") || out.folders.length >= filter.limit);
}
function withinBudget(budget: ScanBudget): boolean { return budget.remaining > 0 && performance.now() < budget.deadline; }

function normalizeFilter(filter: SearchFilter): Required<SearchFilter> {
  const limit = typeof filter.limit === "number" && Number.isFinite(filter.limit) && filter.limit > 0
    ? Math.max(1, Math.min(Math.floor(filter.limit), 200)) : 40;
  return { limit, query: filter.query?.trim().toLowerCase() ?? "", type: filter.type?.trim().toLowerCase() ?? "" };
}

function shouldSkip(rel: string, ignored: string[]): boolean {
  const name = basename(rel);
  if (EXCLUDED.has(name) || name.startsWith(".")) return true;
  return ignored.some((pattern) => rel === pattern || rel.startsWith(`${pattern}/`) || name === pattern);
}

async function loadProjectIgnorePatterns(root: string): Promise<string[]> {
  try {
    return (await readFile(join(root, ".gitignore"), "utf8")).split("\n").map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!")).map((line) => line.replace(/^\/+|\/+$/g, ""));
  } catch { return []; }
}

function wantType(current: string, want: string): boolean { return current === "" || current === "all" || current === want; }
function pathSort(left: ProjectPathReference, right: ProjectPathReference): number { return left.path.localeCompare(right.path); }
