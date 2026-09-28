import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { normalizeSkillSource, resolveSkillSourceRoot } from "./managedSource.ts";
import { skillStoreRoot } from "./managedStore.ts";
import { readSkillRegistry } from "./registry.ts";
import { SkillLibraryError } from "./managedTypes.ts";

export async function inspectSkillSource(stateDir: string, input: unknown) {
  const source = normalizeSkillSource(input);
  const scratch = join(skillStoreRoot(stateDir), "staging", crypto.randomUUID());
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  try {
    if (source.kind === "inline") await writeFile(join(scratch, "SKILL.md"), source.content!);
    const resolved = source.kind === "inline" ? { directory: scratch, resolved_ref: undefined } : await resolveSkillSourceRoot(source, scratch, true);
    const candidates: Array<{ id: string; description: string; subdirectory: string; diagnostics: string[] }> = [];
    let visited = 0;
    async function visit(path: string, depth: number): Promise<void> {
      if (depth > 8 || visited++ > 1024 || candidates.length >= 100) return;
      if (existsSync(join(path, "SKILL.md"))) {
        const registry = readSkillRegistry({ roots: [{ label: "source", path, boundary: resolved.directory }] });
        const metadata = registry.items[0];
        if (metadata) candidates.push({ id: metadata.name, description: metadata.description,
          subdirectory: [source.subdirectory, relative(resolved.directory, path).split(sep).join("/")].filter(Boolean).join("/"),
          diagnostics: registry.diagnostics.map(item => item.message) });
        return;
      }
      for (const item of await readdir(path, { withFileTypes: true })) {
        if (item.isDirectory() && ![".git", "node_modules", ".cache"].includes(item.name)) await visit(join(path, item.name), depth + 1);
      }
    }
    await visit(resolved.directory, 0);
    if (!candidates.length) throw new SkillLibraryError(400, "来源中未找到有效的 SKILL.md，请检查仓库或子目录");
    return { candidates, resolved_ref: resolved.resolved_ref || "", truncated: visited > 1024 || candidates.length >= 100 };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
