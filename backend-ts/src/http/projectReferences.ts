import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export type ProjectReferenceSearchResult = { files: ProjectPathReference[]; folders: ProjectPathReference[] };
type ProjectPathReference = { file_count?: number; path: string; size_bytes?: number; type: "file" | "folder" };
type SearchFilter = { limit?: number; query?: string; type?: string };

const EXCLUDED = new Set([".git", "node_modules", "dist", "build", ".next", "coverage", ".turbo"]);

export function searchProjectReferences(cwd: string, filter: SearchFilter): ProjectReferenceSearchResult {
  const root = resolve(cwd.trim());
  if (!statSync(root).isDirectory()) throw new Error("cwd 不是目录");
  const state = { files: [] as ProjectPathReference[], folders: [] as ProjectPathReference[] };
  const ignored = loadProjectIgnorePatterns(root);
  walk(root, (path, isDir) => addReference(state, root, path, isDir, normalizeFilter(filter), ignored));
  state.files.sort(pathSort); state.folders.sort(pathSort);
  return state;
}

function addReference(out: ProjectReferenceSearchResult, root: string, path: string, isDir: boolean, filter: Required<SearchFilter>, ignored: string[]): void {
  if (path === root) return;
  const rel = relative(root, path).replaceAll("\\", "/");
  if (shouldSkip(rel, ignored)) return;
  if (!rel.toLowerCase().includes(filter.query.toLowerCase())) return;
  if (isDir && wantType(filter.type, "folder") && out.folders.length < filter.limit) out.folders.push({ type: "folder", path: rel, file_count: countFiles(path, ignored) });
  if (!isDir && wantType(filter.type, "file") && out.files.length < filter.limit) out.files.push({ type: "file", path: rel, size_bytes: statSync(path).size });
}

function walk(root: string, visit: (path: string, isDir: boolean) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    visit(path, entry.isDirectory());
    if (entry.isDirectory() && !EXCLUDED.has(entry.name) && !entry.name.startsWith(".")) walk(path, visit);
  }
}

function countFiles(root: string, ignored: string[]): number {
  let count = 0;
  walk(root, (path, isDir) => { if (!isDir && !shouldSkip(basename(path), ignored)) count += 1; });
  return count;
}

function normalizeFilter(filter: SearchFilter): Required<SearchFilter> {
  const limit = typeof filter.limit === "number" && filter.limit > 0 ? Math.min(filter.limit, 200) : 40;
  return { limit, query: filter.query?.trim() ?? "", type: filter.type?.trim().toLowerCase() ?? "" };
}

function shouldSkip(rel: string, ignored: string[]): boolean {
  const name = basename(rel);
  if (EXCLUDED.has(name) || name.startsWith(".")) return true;
  return ignored.some((pattern) => rel === pattern || rel.startsWith(`${pattern}/`) || basename(rel) === pattern);
}

function loadProjectIgnorePatterns(root: string): string[] {
  try {
    return readFileSync(join(root, ".gitignore"), "utf8").split("\n").map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!")).map((line) => line.replace(/^\/+|\/+$/g, ""));
  } catch { return []; }
}

function wantType(current: string, want: string): boolean { return current === "" || current === "all" || current === want; }
function pathSort(left: ProjectPathReference, right: ProjectPathReference): number { return left.path.localeCompare(right.path); }
