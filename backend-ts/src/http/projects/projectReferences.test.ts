import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { searchProjectReferences } from "./projectReferences.ts";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "project-reference-budget-"));
  roots.push(root);
  return root;
}

test("reference traversal prunes ignored trees, counts descendants and does not follow directory symlinks", async () => {
  const root = await fixture();
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "ignored"));
  await mkdir(join(root, "node_modules", "deep"), { recursive: true });
  await writeFile(join(root, ".gitignore"), "ignored\n");
  await writeFile(join(root, "src", "a.ts"), "one");
  await writeFile(join(root, "src", "nested", "b.ts"), "two");
  await writeFile(join(root, "ignored", "hidden.ts"), "hidden");
  await writeFile(join(root, "node_modules", "deep", "hidden.ts"), "hidden");
  await symlink(root, join(root, "src", "cycle"));
  const result = await searchProjectReferences(root, { type: "all" });
  expect(result.files.map((file) => file.path)).toEqual(["src/a.ts", "src/cycle", "src/nested/b.ts"]);
  expect(result.folders).toEqual([
    { type: "folder", path: "src", file_count: 3 },
    { type: "folder", path: "src/nested", file_count: 1 }
  ]);
});

test("reference search honors per-type limit and case-insensitive query", async () => {
  const root = await fixture();
  for (let index = 0; index < 12; index += 1) await writeFile(join(root, `Match-${index}.ts`), "abc");
  const result = await searchProjectReferences(root, { type: "file", query: "MATCH", limit: 2 });
  expect(result.files).toHaveLength(2);
  expect(result.files.every((file) => file.size_bytes === 3)).toBe(true);
  expect(result.folders).toEqual([]);
});

test("reference search does not report a truncated folder count as exact", async () => {
  const root = await fixture();
  const folder = join(root, "large");
  await mkdir(folder);
  await Promise.all(Array.from({ length: 2_010 }, (_, index) => writeFile(join(folder, `${index}.ts`), "")));
  const result = await searchProjectReferences(root, { type: "folder", limit: 1 });
  expect(result.folders).toEqual([{ type: "folder", path: "large" }]);
});
