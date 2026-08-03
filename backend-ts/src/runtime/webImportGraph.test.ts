import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const ENTRY = resolve(import.meta.dir, "web.ts");
const SOURCE_ROOT = resolve(import.meta.dir, "..");
const FORBIDDEN = ["db/", "providers/", "runner/", "integrations/", "pi-coding-agent"];

test("Web role static import graph excludes DB, PI SDK, providers, schedulers and migrations", () => {
  const visited = [...collectRuntimeImports(ENTRY)].map(sourceRelativePath);
  expect(visited.filter((path) => FORBIDDEN.some((part) => path.includes(part)))).toEqual([]);
  expect(visited).toContain("http/webGateway.ts");
});

function sourceRelativePath(path: string): string {
  return relative(SOURCE_ROOT, path).split(sep).join("/");
}

function collectRuntimeImports(entry: string, visited = new Set<string>()): Set<string> {
  if (visited.has(entry)) return visited;
  visited.add(entry);
  const source = readFileSync(entry, "utf8");
  const imports = source.matchAll(/^import(?!\s+type\b)[^"']*["'](\.{1,2}\/[^"']+)["'];?$/gm);
  for (const match of imports) {
    const target = resolve(dirname(entry), match[1] ?? "");
    if (target.endsWith(".ts")) collectRuntimeImports(target, visited);
  }
  return visited;
}
