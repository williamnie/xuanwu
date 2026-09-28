import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { emptyRuntime, readSkillRuntimeManifest, type SkillRegistryTool, type SkillRuntimeMetadata } from "./runtimeManifest.ts";

export type SkillMetadata = SkillRuntimeMetadata & {
  allowed_roles: string[];
  description: string;
  disable_model_invocation?: boolean;
  id: string;
  instruction_bytes: number;
  instruction_sha256: string;
  instructions: string;
  name: string;
  risk_level: "low" | "medium" | "high";
  source_path: string;
  summary: string;
  trigger_rules: string;
  version: string;
};

export type SkillRegistryDiagnostic = {
  code:
    | "manifest_invalid"
    | "missing_description"
    | "missing_front_matter"
    | "missing_tool"
    | "permission_conflict"
    | "read_error"
    | "root_missing"
    | "root_not_directory";
  message: string;
  severity: "warning";
  source_path: string;
};

export type SkillRegistry = { diagnostics: SkillRegistryDiagnostic[]; items: SkillMetadata[] };
export type SkillRegistryRoot = { label?: string; path: string; prefix?: string; boundary?: string };
export type SkillRegistryOptions = { availableTools?: SkillRegistryTool[]; roots?: SkillRegistryRoot[]; additionalRoots?: SkillRegistryRoot[]; cwd?: string; agentDir?: string };
export type SkillRecommendationInput = { description?: string; title?: string };
export type SkillRecommendation = SkillMetadata & { reason: string; score: number };

const MAX_DEPTH = 6;
const MAX_SKILLS = 160;

export function listSkillRegistry(options: SkillRegistryOptions = {}): SkillMetadata[] {
  return readSkillRegistry(options).items;
}

export function readSkillRegistry(options: SkillRegistryOptions = {}): SkillRegistry {
  const diagnostics: SkillRegistryDiagnostic[] = [];
  const found = new Map<string, SkillMetadata>();
  for (const root of registryRoots(options)) {
    for (const file of findSkillFiles(root, 0, diagnostics)) {
      const skill = readSkillFile(file, root, options, diagnostics);
      if (skill && !found.has(skill.id)) found.set(skill.id, skill);
      if (found.size >= MAX_SKILLS) return { diagnostics, items: sortedSkills([...found.values()]) };
    }
  }
  return { diagnostics, items: sortedSkills([...found.values()]) };
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

export function registryRoots(options: SkillRegistryOptions = {}): SkillRegistryRoot[] {
  if (options.roots?.length) return options.roots;
  const home = Bun.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  const packageDir = Bun.env.PI_PACKAGE_DIR?.trim();
  const repoSkills = join(repoRoot(), "skills");
  const runnerRoots: SkillRegistryRoot[] = resourceRoots(repoRoot(), "repo");
  if (packageDir) runnerRoots.push(...resourceRoots(packageDir, "runner-package"));
  if (runnerRoots.length === 0) runnerRoots.push({ label: "repo", path: repoSkills });
  return [
    ...(options.additionalRoots ?? []),
    ...(options.cwd ? resourceRoots(join(options.cwd, ".pi"), "project") : []),
    ...(options.agentDir ? resourceRoots(options.agentDir, "runtime") : []),
    ...runnerRoots,
    { label: "codex-home", path: join(home, "skills") },
    { label: "codex-superpowers", path: join(home, "superpowers", "skills"), prefix: "superpowers" },
    { label: "codex-plugins", path: join(home, "plugins", "cache") }
  ];
}

function resourceRoots(path: string, label: string): SkillRegistryRoot[] {
  const roots: SkillRegistryRoot[] = [];
  const boundary = label === "project" ? dirname(path) : path;
  const addPackage = (directory: string, packageLabel: string) => {
    let entries = ["skills"];
    try {
      const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (Array.isArray(manifest.pi?.skills)) entries = manifest.pi.skills.filter((item: unknown) => typeof item === "string");
    } catch { /* 普通目录无需 package.json。 */ }
    for (const entry of entries) {
      if (isAbsolute(entry) || entry.split(/[\\/]/).includes("..")) continue;
      const skillPath = resolve(directory, entry);
      if (existsSync(skillPath)) roots.push({ label: packageLabel, path: skillPath, boundary });
    }
  };
  addPackage(path, label);
  const plugins = join(path, "plugins");
  if (existsSync(plugins)) for (const name of readdirSync(plugins).slice(0, 64)) {
    addPackage(join(plugins, name), `${label}-plugin-${name}`);
  }
  return roots;
}

export function resolveSkillFile(id: string, options: SkillRegistryOptions = {}): string | undefined {
  const wanted = normalizeID(id);
  for (const root of registryRoots(options)) for (const file of findSkillFiles(root, 0, [])) {
    const metadata = readSkillFile(file, root, options, []);
    if (metadata && (metadata.id === wanted || metadata.name === wanted)) return file;
  }
  return undefined;
}

function findSkillFiles(root: SkillRegistryRoot, depth: number, diagnostics: SkillRegistryDiagnostic[]): string[] {
  if (depth > MAX_DEPTH) return [];
  if (!existsSync(root.path)) return rootMissing(root, depth, diagnostics);
  if (root.boundary) {
    try {
      const candidate = existsSync(join(root.path, "SKILL.md")) ? join(root.path, "SKILL.md") : root.path;
      const part = relative(realpathSync(root.boundary), realpathSync(candidate));
      if (isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`)) {
        diagnostics.push(diagnostic("read_error", publicPath(root.path, root), "Skill directory escapes its allowed root"));
        return [];
      }
    } catch { return []; }
  }
  const stat = safeStat(root.path);
  if (!stat?.isDirectory()) return rootNotDirectory(root, depth, diagnostics);
  const skill = join(root.path, "SKILL.md");
  if (existsSync(skill)) return [skill];
  return safeReadDir(root.path, root, diagnostics).flatMap((name) => (
    findSkillFiles({ ...root, path: join(root.path, name) }, depth + 1, diagnostics)
  ));
}

function readSkillFile(
  path: string,
  root: SkillRegistryRoot,
  options: SkillRegistryOptions,
  diagnostics: SkillRegistryDiagnostic[]
): SkillMetadata | null {
  const text = safeReadFile(path, root, diagnostics);
  if (text === undefined) return null;
  if (!hasFrontMatter(text)) return badSkill(root, path, diagnostics, "missing_front_matter", "SKILL.md missing front matter");
  const frontMatter = parseFrontMatter(text);
  const id = normalizeID(root.prefix ? `${root.prefix}:${parentName(path)}` : parentName(path));
  const name = normalizeID(frontMatter.name) || id;
  const description = clean(frontMatter.description);
  if (description === "") return badSkill(root, path, diagnostics, "missing_description", "SKILL.md missing description");
  const instructionSha256 = createHash("sha256").update(text).digest("hex");
  return {
    allowed_roles: allowedRoles(description),
    description,
    disable_model_invocation: frontMatter["disable-model-invocation"] === true,
    id,
    instruction_bytes: Buffer.byteLength(text),
    instruction_sha256: instructionSha256,
    instructions: text,
    name,
    risk_level: riskLevel(`${name} ${description}`),
    source_path: publicPath(path, root),
    summary: description,
    ...runtimeManifest(path, root, options, diagnostics),
    trigger_rules: description || `Use when ${name} is requested.`,
    version: clean(frontMatter.version) || `sha256:${instructionSha256.slice(0, 12)}`
  };
}

function runtimeManifest(
  path: string,
  root: SkillRegistryRoot,
  options: SkillRegistryOptions,
  diagnostics: SkillRegistryDiagnostic[]
): SkillRuntimeMetadata {
  if (root.prefix) return emptyRuntime();
  return readSkillRuntimeManifest({
    availableTools: options.availableTools,
    manifestPath: join(dirname(path), "manifest.json"),
    publicPath: (file) => publicPath(file, root)
  }, diagnostics);
}

function hasFrontMatter(text: string): boolean {
  return text.startsWith("---") && text.indexOf("\n---", 3) >= 0;
}

function parseFrontMatter(text: string): Record<string, unknown> {
  if (!text.startsWith("---")) return {};
  const end = text.indexOf("\n---", 3);
  if (end < 0) return {};
  try {
    const parsed = Bun.YAML.parse(text.slice(3, end));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch { return {}; }
}

function recommendation(skill: SkillMetadata, terms: string[]): SkillRecommendation {
  const haystack = tokenize(`${skill.id} ${skill.name} ${skill.description}`);
  const matches = terms.filter((term) => haystack.some((word) => word.includes(term) || term.includes(word)));
  return { ...skill, reason: `matched ${matches.slice(0, 4).join(", ")}`, score: new Set(matches).size };
}

function allowedRoles(description: string): string[] {
  return /design|browser|figma|credential|deploy|publish|destructive/i.test(description)
    ? ["pi", "executor", "human-approved"]
    : ["pi", "executor"];
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

function publicPath(path: string, root: SkillRegistryRoot): string {
  const label = clean(root.label) || clean(root.prefix) || "skill-root";
  const base = label === "repo" || label === "runner-package" ? dirname(root.path) : root.path;
  return `${label}:${relative(base, path).replaceAll("\\", "/")}`;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

function normalizeID(value: unknown): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function safeReadDir(path: string, root: SkillRegistryRoot, diagnostics: SkillRegistryDiagnostic[]): string[] {
  try { return readdirSync(path); } catch { diagnostics.push(diagnostic("read_error", publicPath(path, root), "Cannot read skill directory")); return []; }
}

function safeReadFile(path: string, root: SkillRegistryRoot, diagnostics: SkillRegistryDiagnostic[]): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { diagnostics.push(diagnostic("read_error", publicPath(path, root), "Cannot read skill file")); return undefined; }
}

function safeStat(path: string) {
  try { return statSync(path); } catch { return undefined; }
}

function rootMissing(root: SkillRegistryRoot, depth: number, diagnostics: SkillRegistryDiagnostic[]): string[] {
  if (depth === 0) diagnostics.push(diagnostic("root_missing", clean(root.label) || "skill-root", "Skill root is missing"));
  return [];
}

function rootNotDirectory(root: SkillRegistryRoot, depth: number, diagnostics: SkillRegistryDiagnostic[]): string[] {
  if (depth === 0) diagnostics.push(diagnostic("root_not_directory", clean(root.label) || "skill-root", "Skill root is not a directory"));
  return [];
}

function badSkill(root: SkillRegistryRoot, path: string, diagnostics: SkillRegistryDiagnostic[], code: SkillRegistryDiagnostic["code"], message: string): null {
  diagnostics.push(diagnostic(code, publicPath(path, root), message));
  return null;
}

function diagnostic(code: SkillRegistryDiagnostic["code"], source_path: string, message: string): SkillRegistryDiagnostic {
  return { code, message, severity: "warning", source_path };
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
