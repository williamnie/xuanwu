import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillMetadata = {
  allowed_roles: string[];
  description: string;
  id: string;
  name: string;
  risk_level: "low" | "medium" | "high";
  source_path: string;
  summary: string;
  trigger_rules: string;
};

export type SkillRegistryOptions = { roots?: Array<{ path: string; prefix?: string }> };
export type SkillRecommendationInput = { description?: string; title?: string };
export type SkillRecommendation = SkillMetadata & { reason: string; score: number };

const MAX_DEPTH = 6;
const MAX_SKILLS = 160;

export function listSkillRegistry(options: SkillRegistryOptions = {}): SkillMetadata[] {
  const found = new Map<string, SkillMetadata>();
  for (const root of registryRoots(options)) {
    for (const file of findSkillFiles(root.path, 0)) {
      const skill = readSkillFile(file, root);
      if (skill && !found.has(skill.id)) found.set(skill.id, skill);
      if (found.size >= MAX_SKILLS) return sortedSkills([...found.values()]);
    }
  }
  return sortedSkills([...found.values()]);
}

export function getSkillMetadata(id: string, options: SkillRegistryOptions = {}): SkillMetadata | null {
  const wanted = normalizeID(id);
  return listSkillRegistry(options).find((skill) => skill.id === wanted || skill.name === wanted) ?? null;
}

export function recommendSkillIntents(
  input: SkillRecommendationInput,
  options: SkillRegistryOptions = {}
): SkillRecommendation[] {
  const terms = tokenize(`${input.title ?? ""} ${input.description ?? ""}`);
  if (terms.length === 0) return [];
  return listSkillRegistry(options)
    .map((skill) => recommendation(skill, terms))
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, 8);
}

function registryRoots(options: SkillRegistryOptions): Array<{ path: string; prefix?: string }> {
  if (options.roots?.length) return options.roots;
  const home = Bun.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return [
    { path: join(home, "skills") },
    { path: join(home, "superpowers", "skills"), prefix: "superpowers" },
    { path: join(home, "plugins", "cache") }
  ];
}

function findSkillFiles(root: string, depth: number): string[] {
  if (depth > MAX_DEPTH || !existsSync(root)) return [];
  const stat = safeStat(root);
  if (!stat?.isDirectory()) return [];
  const skill = join(root, "SKILL.md");
  if (existsSync(skill)) return [skill];
  return safeReadDir(root).flatMap((name) => findSkillFiles(join(root, name), depth + 1));
}

function readSkillFile(path: string, root: { path: string; prefix?: string }): SkillMetadata | null {
  const text = safeReadFile(path);
  if (text === "") return null;
  const frontMatter = parseFrontMatter(text);
  const id = normalizeID(root.prefix ? `${root.prefix}:${parentName(path)}` : parentName(path));
  const name = normalizeID(frontMatter.name) || id;
  const description = clean(frontMatter.description);
  return {
    allowed_roles: allowedRoles(description),
    description,
    id,
    name,
    risk_level: riskLevel(`${name} ${description}`),
    source_path: path,
    summary: description,
    trigger_rules: description || `Use when ${name} is requested.`
  };
}

function parseFrontMatter(text: string): Record<string, string> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  return Object.fromEntries(text.slice(3, end).split(/\r?\n/).map(frontMatterLine).filter(Boolean) as Array<[string, string]>);
}

function frontMatterLine(line: string): [string, string] | undefined {
  const separator = line.indexOf(":");
  if (separator < 0) return undefined;
  return [line.slice(0, separator).trim(), line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "")];
}

function recommendation(skill: SkillMetadata, terms: string[]): SkillRecommendation {
  const haystack = tokenize(`${skill.id} ${skill.name} ${skill.description}`);
  const matches = terms.filter((term) => haystack.some((word) => word.includes(term) || term.includes(word)));
  return { ...skill, reason: `matched ${matches.slice(0, 4).join(", ")}`, score: new Set(matches).size };
}

function allowedRoles(description: string): string[] {
  return /design|browser|figma|credential|deploy|publish|destructive/i.test(description)
    ? ["pi", "executor", "human-approved"]
    : ["pi", "executor", "verifier"];
}

function riskLevel(text: string): SkillMetadata["risk_level"] {
  if (/deploy|publish|credential|delete|destructive|github|browser|chrome/i.test(text)) return "high";
  if (/write|edit|commit|issue|runner|implementation|test|figma/i.test(text)) return "medium";
  return "low";
}

function tokenize(text: string): string[] {
  return clean(text).toLowerCase().split(/[^a-z0-9_:-]+/).filter((term) => term.length >= 3);
}

function sortedSkills(skills: SkillMetadata[]): SkillMetadata[] {
  return skills.sort((left, right) => left.id.localeCompare(right.id));
}

function parentName(path: string): string {
  return path.split(/[\\/]+/).at(-2) ?? "skill";
}

function normalizeID(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function safeReadDir(path: string): string[] {
  try { return readdirSync(path); } catch { return []; }
}

function safeReadFile(path: string): string {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

function safeStat(path: string) {
  try { return statSync(path); } catch { return undefined; }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
