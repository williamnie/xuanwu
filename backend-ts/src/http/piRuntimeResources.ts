import type {
  LoadExtensionsResult,
  PromptTemplate,
  ResourceDiagnostic,
  ResourceLoader,
  Skill
} from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { RunnerDatabase } from "../db/database.ts";
import { createPiActionEvent } from "../db/repositories/pi.ts";
import { buildSkillPromptContext } from "../skills/promptContext.ts";
import { redactSensitiveText } from "../util/redact.ts";
import type { SmokeRuntime } from "../spikes/piSmokeSupport.ts";
import type { RuntimeSessionInput } from "./piRuntime.ts";

export type PiRuntimeResourceDiagnostic = {
  code: string;
  message: string;
  resource_type: "agent" | "extension" | "loader" | "prompt" | "skill";
  severity: "warning" | "error";
  source_path: string;
};

export type PiRuntimeResourceSnapshot = {
  counts: { agents: number; diagnostics: number; extensions: number; prompts: number; skills: number };
  diagnostics: PiRuntimeResourceDiagnostic[];
  generation: number;
  loaded: { agents: string[]; extensions: string[]; prompts: string[]; skills: string[] };
  outcome: "loaded" | "fallback";
  sources: string[];
};

export type ControlledPiResourceOptions = {
  agentDir: string;
  allowedSkillIDs: string[];
  cwd: string;
  onSnapshot?: (snapshot: PiRuntimeResourceSnapshot) => void;
  piPackageDir?: string;
  runtimeRoot: string;
  resourceScope?: "core" | "full";
  systemPrompt: string;
};

type ResourceType = PiRuntimeResourceDiagnostic["resource_type"];
type ResourceExtensionPaths = Parameters<ResourceLoader["extendResources"]>[0];
type ResourcePathEntry = NonNullable<ResourceExtensionPaths["skillPaths"]>[number];
type PiPackageManifest = { extensions: string[]; prompts: string[]; skills: string[] };
type ResourcePackage = { label: string; manifest?: PiPackageManifest; path: string; wholeRootAllowed: boolean };
type AllowedRoot = { label: string; path: string; resourceType: ResourceType };
type Discovery = {
  agents: Array<{ content: string; path: string }>;
  allowedRoots: AllowedRoot[];
  diagnostics: PiRuntimeResourceDiagnostic[];
  extensionPaths: string[];
  packages: ResourcePackage[];
  promptPaths: string[];
  skillPaths: string[];
};

const PI_RESOURCE_DIR = ".pi";
const MAX_AGENT_FILE_BYTES = 128 * 1024;
const MAX_PLUGIN_PACKAGES = 64;
const MAX_EXTENSION_FILES = 128;
const MAX_EXTENSION_BYTES = 512 * 1024;
const SUMMARY_ITEM_LIMIT = 16;

export async function createPiRuntimeResourceLoader(
  sdk: SmokeRuntime,
  db: RunnerDatabase,
  input: RuntimeSessionInput,
  options: Omit<ControlledPiResourceOptions, "allowedSkillIDs" | "onSnapshot">
): Promise<ResourceLoader & { snapshot(): PiRuntimeResourceSnapshot }> {
  const promptProject = input.toolProject ?? input.project;
  const resourceScope = input.promptProfile === "chat" || input.promptProfile === "manager_cycle" ? "full" : "core";
  const skillContext = resourceScope === "full"
    ? buildSkillPromptContext(db, { ...input, project: promptProject })
    : { audit: { injected_skill_ids: [], missing_skill_intents: [] } };
  const allowedSkillIDs = unique([
    ...skillContext.audit.injected_skill_ids,
    ...skillContext.audit.missing_skill_intents
  ]);
  return await createControlledPiResourceLoader(sdk, {
    ...options,
    allowedSkillIDs,
    resourceScope,
    onSnapshot: (snapshot) => recordPiRuntimeResourceSnapshot(db, input, promptProject?.id, snapshot)
  });
}

export async function createControlledPiResourceLoader(
  sdk: SmokeRuntime,
  options: ControlledPiResourceOptions
): Promise<ResourceLoader & { snapshot(): PiRuntimeResourceSnapshot }> {
  const loader = new ControlledPiResourceLoader(sdk, options);
  await loader.reload();
  return loader;
}

class ControlledPiResourceLoader implements ResourceLoader {
  private active: ResourceLoader;
  private allowedRoots: AllowedRoot[] = [];
  private baseDiagnostics: PiRuntimeResourceDiagnostic[] = [];
  private generation = 0;
  private outcome: PiRuntimeResourceSnapshot["outcome"] = "loaded";
  private sources: ResourcePackage[] = [];
  private readonly promptParts: { base: string; final: string };

  constructor(private readonly sdk: SmokeRuntime, private readonly options: ControlledPiResourceOptions) {
    this.promptParts = splitFinalPersonaPrompt(options.systemPrompt);
    this.active = coreOnlyLoader(sdk, this.promptParts.base);
  }

  getExtensions(): LoadExtensionsResult { return this.active.getExtensions(); }
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } { return this.active.getSkills(); }
  getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } { return this.active.getPrompts(); }
  getThemes() { return this.active.getThemes(); }
  getAgentsFiles() { return this.active.getAgentsFiles(); }
  getSystemPrompt(): string | undefined { return this.active.getSystemPrompt(); }

  getAppendSystemPrompt(): string[] {
    return [
      ...this.active.getAppendSystemPrompt(),
      resourcePromptSummary(this.snapshot()),
      this.promptParts.final,
      this.promptParts.final ? `Current date: ${new Date().toISOString().slice(0, 10)}` : ""
    ].filter(Boolean);
  }

  extendResources(paths: ResourceExtensionPaths): void {
    const diagnostics: PiRuntimeResourceDiagnostic[] = [];
    const filtered = {
      skillPaths: this.filterExtendedPaths(paths.skillPaths, "skill", diagnostics),
      promptPaths: this.filterExtendedPaths(paths.promptPaths, "prompt", diagnostics),
      themePaths: []
    };
    this.baseDiagnostics.push(...diagnostics);
    this.active.extendResources(filtered);
    this.emitSnapshot();
  }

  async reload(): Promise<void> {
    this.generation += 1;
    const discovery = discoverResources(this.options);
    const policyDiagnostics: PiRuntimeResourceDiagnostic[] = [];
    // Drop the previous extension runtime before importing a fresh generation.
    // Keeping both runtimes live can leave the SDK module loader waiting on the
    // prior TypeScript extension instance during an in-process reload.
    this.active = coreOnlyLoader(this.sdk, this.promptParts.base);
    try {
      const candidate = this.defaultLoader(discovery, policyDiagnostics);
      await candidate.reload();
      this.active = candidate;
      this.allowedRoots = discovery.allowedRoots;
      this.baseDiagnostics = [...discovery.diagnostics, ...policyDiagnostics];
      this.sources = discovery.packages;
      this.outcome = "loaded";
    } catch (error) {
      this.active = coreOnlyLoader(this.sdk, this.promptParts.base);
      this.allowedRoots = discovery.allowedRoots;
      this.sources = discovery.packages;
      this.outcome = "fallback";
      this.baseDiagnostics = [...discovery.diagnostics, ...policyDiagnostics, {
        code: "resource_reload_failed",
        message: safeMessage(error, discovery.allowedRoots),
        resource_type: "loader",
        severity: "error",
        source_path: "runtime:resource-loader"
      }];
    }
    this.emitSnapshot();
  }

  snapshot(): PiRuntimeResourceSnapshot {
    const extensions = this.active.getExtensions();
    const prompts = this.active.getPrompts();
    const skills = this.active.getSkills();
    const agents = this.active.getAgentsFiles().agentsFiles;
    const diagnostics = sortedDiagnostics([
      ...this.baseDiagnostics,
      ...extensions.errors.map((item) => sdkDiagnostic("extension_load_failed", "extension", "error", item.path, item.error, this.allowedRoots)),
      ...prompts.diagnostics.map((item) => resourceDiagnostic("prompt", item, this.allowedRoots)),
      ...skills.diagnostics.map((item) => resourceDiagnostic("skill", item, this.allowedRoots))
    ]);
    return {
      counts: {
        agents: agents.length,
        diagnostics: diagnostics.length,
        extensions: extensions.extensions.length,
        prompts: prompts.prompts.length,
        skills: skills.skills.length
      },
      diagnostics,
      generation: this.generation,
      loaded: {
        agents: namedPaths(agents.map((item) => item.path), this.allowedRoots),
        extensions: namedPaths(extensions.extensions.map((item) => item.path), this.allowedRoots),
        prompts: sortedNames(prompts.prompts.map((item) => item.name)),
        skills: sortedNames(skills.skills.map((item) => item.name))
      },
      outcome: this.outcome,
      sources: this.sources.map((source) => source.label).sort()
    };
  }

  private defaultLoader(discovery: Discovery, diagnostics: PiRuntimeResourceDiagnostic[]): ResourceLoader {
    const allowedSkills = new Set(this.options.allowedSkillIDs.map(normalizeID).filter(Boolean));
    const filterPaths = <T>(items: T[], resourceType: ResourceType, pathOf: (item: T) => string): T[] => items.filter((item) => {
      const path = pathOf(item);
      if (pathAllowed(path, resourceType, discovery.allowedRoots)) return true;
      diagnostics.push(notAllowedDiagnostic(resourceType, path, discovery.allowedRoots));
      return false;
    });
    return new this.sdk.pi.DefaultResourceLoader({
      cwd: this.options.cwd,
      agentDir: this.options.agentDir,
      settingsManager: this.sdk.pi.SettingsManager.inMemory(),
      additionalExtensionPaths: discovery.extensionPaths,
      additionalPromptTemplatePaths: discovery.promptPaths,
      additionalSkillPaths: discovery.skillPaths,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: this.promptParts.base,
      appendSystemPromptOverride: () => [],
      agentsFilesOverride: () => ({ agentsFiles: discovery.agents }),
      extensionsOverride: (base) => sanitizeExtensions(
        { ...base, extensions: filterPaths(base.extensions, "extension", (item) => item.path) },
        diagnostics,
        discovery.allowedRoots
      ),
      promptsOverride: (base) => ({
        ...base,
        prompts: filterPaths(base.prompts, "prompt", (item) => item.filePath)
      }),
      skillsOverride: (base) => ({
        diagnostics: base.diagnostics,
        skills: filterPaths(base.skills, "skill", (item) => item.filePath).filter((skill) => {
          if (allowedSkills.has(normalizeID(skill.name))) return true;
          diagnostics.push({
            code: "skill_not_allowlisted",
            message: `Skill ${normalizeID(skill.name) || "unknown"} is not in the effective skill policy`,
            resource_type: "skill",
            severity: "warning",
            source_path: publicPath(skill.filePath, discovery.allowedRoots)
          });
          return false;
        })
      }),
      themesOverride: () => ({ diagnostics: [], themes: [] })
    });
  }

  private filterExtendedPaths(
    entries: ResourcePathEntry[] | undefined,
    resourceType: "prompt" | "skill",
    diagnostics: PiRuntimeResourceDiagnostic[]
  ): ResourcePathEntry[] {
    return (entries ?? []).filter((entry) => {
      if (pathAllowed(entry.path, resourceType, this.allowedRoots)) return true;
      diagnostics.push(notAllowedDiagnostic(resourceType, entry.path, this.allowedRoots));
      return false;
    });
  }

  private emitSnapshot(): void {
    try { this.options.onSnapshot?.(this.snapshot()); } catch (error) {
      console.warn("[pi-runtime] failed to audit resource snapshot:", redactSensitiveText(String(error)));
    }
  }
}

function discoverResources(options: ControlledPiResourceOptions): Discovery {
  const diagnostics: PiRuntimeResourceDiagnostic[] = [];
  if (options.resourceScope === "core") {
    return {
      agents: [],
      allowedRoots: [],
      diagnostics,
      extensionPaths: [],
      packages: [],
      promptPaths: [],
      skillPaths: []
    };
  }
  const candidates: ResourcePackage[] = [
    packageCandidate("builtin", options.runtimeRoot, diagnostics),
    packageCandidate("project", join(options.cwd, PI_RESOURCE_DIR), diagnostics, options.cwd),
    packageCandidate("runtime", options.agentDir, diagnostics),
    packageCandidate("pi-package", clean(options.piPackageDir), diagnostics),
    ...pluginCandidates(options, diagnostics)
  ].filter((item): item is ResourcePackage => item.path !== "");
  const packages = dedupePackages(candidates).filter(hasResources);
  const allowedRoots = packages.flatMap(packageAllowedRoots);
  const skillPaths = packages.flatMap((source) => packagePaths(source, "skill", diagnostics));
  const promptPaths = packages.flatMap((source) => packagePaths(source, "prompt", diagnostics));
  const extensionPaths = packages
    .flatMap((source) => packagePaths(source, "extension", diagnostics))
    .flatMap((path) => extensionFiles(path, allowedRoots, diagnostics));
  const agents = [
    readAgentFile("project-agent", join(options.cwd, "AGENTS.md"), options.cwd, diagnostics),
    readAgentFile("runtime-agent", join(options.agentDir, "AGENTS.md"), options.agentDir, diagnostics)
  ].filter((item): item is { content: string; path: string } => Boolean(item));
  allowedRoots.push(
    { label: "project-agent", path: canonical(options.cwd), resourceType: "agent" },
    { label: "runtime-agent", path: canonical(options.agentDir), resourceType: "agent" }
  );
  return {
    agents,
    allowedRoots,
    diagnostics,
    extensionPaths: unique(extensionPaths),
    packages,
    promptPaths: unique(promptPaths),
    skillPaths: unique(skillPaths)
  };
}

function splitFinalPersonaPrompt(systemPrompt: string): { base: string; final: string } {
  const header = "Chat presentation profile:";
  const marker = `\n${header}`;
  const index = systemPrompt.lastIndexOf(marker);
  if (index >= 0) return { base: systemPrompt.slice(0, index), final: systemPrompt.slice(index + 1) };
  if (systemPrompt.startsWith(header)) return { base: "", final: systemPrompt };
  return { base: systemPrompt, final: "" };
}

function packageCandidate(
  label: string,
  path: string,
  diagnostics: PiRuntimeResourceDiagnostic[],
  allowedParent?: string
): ResourcePackage {
  const candidate = clean(path);
  if (candidate === "" || !existsSync(candidate) || !safeDirectory(candidate)) return { label, path: "", wholeRootAllowed: false };
  if (allowedParent && !within(canonical(candidate), canonical(allowedParent))) {
    diagnostics.push(notAllowedDiagnostic("loader", candidate, [{ label, path: allowedParent, resourceType: "loader" }]));
    return { label, path: "", wholeRootAllowed: false };
  }
  const manifest = piManifest(candidate, label, diagnostics);
  if (manifest === null) return { label, path: "", wholeRootAllowed: false };
  return { label, manifest: manifest ?? undefined, path: canonical(candidate), wholeRootAllowed: Boolean(manifest) };
}

function pluginCandidates(options: ControlledPiResourceOptions, diagnostics: PiRuntimeResourceDiagnostic[]): ResourcePackage[] {
  const roots = unique([
    join(options.runtimeRoot, "plugins"),
    join(options.cwd, PI_RESOURCE_DIR, "plugins"),
    join(options.agentDir, "plugins"),
    clean(options.piPackageDir) === "" ? "" : join(clean(options.piPackageDir), "plugins")
  ]).filter(Boolean);
  const packages: ResourcePackage[] = [];
  for (const root of roots) {
    if (!existsSync(root) || !safeDirectory(root)) continue;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true }).slice(0, MAX_PLUGIN_PACKAGES)) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const item = packageCandidate(`plugin:${entry.name}`, join(root, entry.name), diagnostics, root);
        if (item.path !== "") packages.push(item);
      }
    } catch (error) {
      diagnostics.push({
        code: "plugin_discovery_failed",
        message: safeMessage(error, [{ label: "plugins", path: root, resourceType: "loader" }]),
        resource_type: "loader",
        severity: "warning",
        source_path: "plugins:root"
      });
    }
  }
  return packages;
}

function piManifest(root: string, label: string, diagnostics: PiRuntimeResourceDiagnostic[]): PiPackageManifest | null | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return undefined;
  try {
    const pi = (JSON.parse(readFileSync(path, "utf8")) as { pi?: unknown }).pi;
    if (pi === undefined) return undefined;
    if (typeof pi !== "object" || pi === null) throw new Error("package.json pi manifest must be an object");
    const manifest = pi as Record<string, unknown>;
    const parsed = {
      extensions: manifestEntries(manifest.extensions),
      prompts: manifestEntries(manifest.prompts),
      skills: manifestEntries(manifest.skills)
    };
    if ([...parsed.extensions, ...parsed.prompts, ...parsed.skills].some(unsafeManifestEntry)) {
      diagnostics.push({
        code: "package_manifest_not_allowlisted",
        message: "PI package manifest contains an absolute or parent-traversal resource path",
        resource_type: "loader",
        severity: "warning",
        source_path: `${label}:package.json`
      });
      return null;
    }
    return parsed;
  } catch (error) {
    diagnostics.push({
      code: "package_manifest_invalid",
      message: safeMessage(error, [{ label, path: root, resourceType: "loader" }]),
      resource_type: "loader",
      severity: "warning",
      source_path: `${label}:package.json`
    });
    return undefined;
  }
}

function hasResources(source: ResourcePackage): boolean {
  return source.manifest
    ? [...source.manifest.extensions, ...source.manifest.prompts, ...source.manifest.skills].length > 0
    : ["extensions", "prompts", "skills"].some((name) => existsSync(join(source.path, name)));
}

function packageAllowedRoots(source: ResourcePackage): AllowedRoot[] {
  const roots: AllowedRoot[] = [];
  for (const resourceType of ["extension", "prompt", "skill"] as const) {
    const path = source.wholeRootAllowed ? source.path : join(source.path, `${resourceType}s`);
    if (!source.wholeRootAllowed && !within(canonical(path), canonical(source.path))) continue;
    roots.push({
      label: source.label,
      path,
      resourceType
    });
  }
  return roots;
}

function packagePaths(
  source: ResourcePackage,
  resourceType: "extension" | "prompt" | "skill",
  diagnostics: PiRuntimeResourceDiagnostic[]
): string[] {
  if (!source.manifest) {
    const path = join(source.path, `${resourceType}s`);
    if (!existsSync(path)) return [];
    if (within(canonical(path), canonical(source.path))) return [path];
    diagnostics.push(notAllowedDiagnostic(resourceType, path, [{ label: source.label, path: source.path, resourceType }]));
    return [];
  }
  const entries = source.manifest[`${resourceType}s`];
  return entries
    .filter((entry) => !/^[!+-]/.test(entry))
    .flatMap((entry) => expandManifestEntry(source, entry, resourceType, diagnostics));
}

function expandManifestEntry(
  source: ResourcePackage,
  entry: string,
  resourceType: "extension" | "prompt" | "skill",
  diagnostics: PiRuntimeResourceDiagnostic[]
): string[] {
  try {
    const matches = hasGlob(entry)
      ? [...new Bun.Glob(entry).scanSync({ absolute: true, cwd: source.path, onlyFiles: false })]
      : [resolve(source.path, entry)];
    return matches.filter((path) => {
      if (within(canonical(path), canonical(source.path))) return true;
      diagnostics.push(notAllowedDiagnostic(resourceType, path, packageAllowedRoots(source)));
      return false;
    });
  } catch (error) {
    diagnostics.push({
      code: "package_manifest_entry_invalid",
      message: safeMessage(error, packageAllowedRoots(source)),
      resource_type: resourceType,
      severity: "warning",
      source_path: `${source.label}:package.json`
    });
    return [];
  }
}

function extensionFiles(
  path: string,
  roots: AllowedRoot[],
  diagnostics: PiRuntimeResourceDiagnostic[],
  depth = 0
): string[] {
  if (depth > 6 || !existsSync(path)) return [];
  const resolved = canonical(path);
  if (!pathAllowed(resolved, "extension", roots)) {
    diagnostics.push(notAllowedDiagnostic("extension", path, roots));
    return [];
  }
  let stat;
  try { stat = statSync(resolved); } catch { return []; }
  if (stat.isFile()) return validExtensionFile(resolved, stat.size, roots, diagnostics) ? [resolved] : [];
  if (!stat.isDirectory()) return [];
  try {
    return readdirSync(resolved, { withFileTypes: true })
      .slice(0, MAX_EXTENSION_FILES)
      .flatMap((entry) => extensionFiles(join(resolved, entry.name), roots, diagnostics, depth + 1));
  } catch (error) {
    diagnostics.push({
      code: "extension_discovery_failed",
      message: safeMessage(error, roots),
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(resolved, roots)
    });
    return [];
  }
}

function validExtensionFile(
  path: string,
  size: number,
  roots: AllowedRoot[],
  diagnostics: PiRuntimeResourceDiagnostic[]
): boolean {
  const extension = extname(path).toLowerCase();
  if (![".cjs", ".js", ".mjs", ".ts"].includes(extension)) return false;
  if (size > MAX_EXTENSION_BYTES) {
    diagnostics.push({
      code: "extension_too_large",
      message: "Extension exceeds the runtime size limit",
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(path, roots)
    });
    return false;
  }
  try {
    const loader = extension === ".ts" ? "ts" : "js";
    new Bun.Transpiler({ loader }).transformSync(readFileSync(path, "utf8"));
    return true;
  } catch (error) {
    diagnostics.push({
      code: "extension_parse_failed",
      message: safeMessage(error, roots),
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(path, roots)
    });
    return false;
  }
}

function readAgentFile(
  label: string,
  path: string,
  allowedRoot: string,
  diagnostics: PiRuntimeResourceDiagnostic[]
): { content: string; path: string } | undefined {
  if (!existsSync(path)) return undefined;
  const resolved = canonical(path);
  if (!within(resolved, canonical(allowedRoot))) {
    diagnostics.push(notAllowedDiagnostic("agent", path, [{ label, path: allowedRoot, resourceType: "agent" }]));
    return undefined;
  }
  try {
    const stat = statSync(resolved);
    if (!stat.isFile() || stat.size > MAX_AGENT_FILE_BYTES) {
      diagnostics.push({
        code: "agent_file_invalid",
        message: stat.size > MAX_AGENT_FILE_BYTES ? "AGENTS.md exceeds the runtime size limit" : "AGENTS.md is not a regular file",
        resource_type: "agent",
        severity: "warning",
        source_path: `${label}:AGENTS.md`
      });
      return undefined;
    }
    return { content: readFileSync(resolved, "utf8"), path: resolved };
  } catch (error) {
    diagnostics.push({
      code: "agent_read_failed",
      message: safeMessage(error, [{ label, path: allowedRoot, resourceType: "agent" }]),
      resource_type: "agent",
      severity: "warning",
      source_path: `${label}:AGENTS.md`
    });
    return undefined;
  }
}

function coreOnlyLoader(sdk: SmokeRuntime, systemPrompt: string): ResourceLoader {
  return {
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getAppendSystemPrompt: () => [],
    getExtensions: () => ({ extensions: [], errors: [], runtime: sdk.pi.createExtensionRuntime() }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getSystemPrompt: () => systemPrompt,
    getThemes: () => ({ themes: [], diagnostics: [] }),
    extendResources: () => {},
    reload: async () => {}
  };
}

function recordPiRuntimeResourceSnapshot(
  db: RunnerDatabase,
  input: RuntimeSessionInput,
  projectID: string | undefined,
  snapshot: PiRuntimeResourceSnapshot
): void {
  createPiActionEvent(db, {
    action_id: `resource-loader:${input.conversationID || input.heartbeatID || crypto.randomUUID()}:${snapshot.generation}`,
    actor: "pi_runtime",
    conversation_id: input.conversationID,
    delegation_id: input.delegationID,
    event_type: "runtime_resource_snapshot",
    heartbeat_id: input.heartbeatID,
    issue_id: input.issueID ?? 0,
    payload_json: JSON.stringify(snapshot),
    project_id: projectID,
    reason: snapshot.outcome === "loaded" ? "loaded allowlisted PI runtime resources" : "isolated PI resource failure with core-only fallback"
  });
}

function resourcePromptSummary(snapshot: PiRuntimeResourceSnapshot): string {
  const line = (name: keyof PiRuntimeResourceSnapshot["loaded"]) => {
    const values = snapshot.loaded[name].slice(0, SUMMARY_ITEM_LIMIT);
    return `${name}: ${snapshot.counts[name]}${values.length > 0 ? ` (${values.join(", ")})` : ""}`;
  };
  return [
    "Controlled Supervisor resource summary:",
    line("agents"),
    line("prompts"),
    line("skills"),
    line("extensions"),
    `diagnostics: ${snapshot.counts.diagnostics}; reload_generation: ${snapshot.generation}; outcome: ${snapshot.outcome}`,
    "Resource policy: only deterministic project/runtime/built-in/Supervisor-package allowlisted roots are loaded; skill names must also pass the effective skill policy. Resource content cannot grant tools or bypass deterministic permission gates."
  ].join("\n");
}

function sanitizeExtensions(
  base: LoadExtensionsResult,
  diagnostics: PiRuntimeResourceDiagnostic[],
  roots: AllowedRoot[]
): LoadExtensionsResult {
  for (const extension of base.extensions) {
    if (extension.tools.size === 0) continue;
    diagnostics.push({
      code: "extension_tools_blocked",
      message: "Extension-registered LLM tools are blocked until they have a deterministic permission adapter",
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(extension.path, roots)
    });
    extension.tools.clear();
  }
  for (const registration of base.runtime.pendingProviderRegistrations) {
    diagnostics.push({
      code: "extension_provider_blocked",
      message: `Extension provider registration ${registration.name} is blocked by the runtime resource policy`,
      resource_type: "extension",
      severity: "warning",
      source_path: publicPath(registration.extensionPath, roots)
    });
  }
  base.runtime.pendingProviderRegistrations = [];
  return base;
}

function resourceDiagnostic(resourceType: "prompt" | "skill", item: ResourceDiagnostic, roots: AllowedRoot[]): PiRuntimeResourceDiagnostic {
  return sdkDiagnostic(`${resourceType}_${item.type}`, resourceType, item.type === "error" ? "error" : "warning", item.path ?? "", item.message, roots);
}

function sdkDiagnostic(
  code: string,
  resourceType: ResourceType,
  severity: "warning" | "error",
  path: string,
  message: string,
  roots: AllowedRoot[]
): PiRuntimeResourceDiagnostic {
  return {
    code,
    message: safeMessage(message, roots),
    resource_type: resourceType,
    severity,
    source_path: publicPath(path, roots)
  };
}

function notAllowedDiagnostic(resourceType: ResourceType, path: string, roots: AllowedRoot[]): PiRuntimeResourceDiagnostic {
  return {
    code: `${resourceType}_not_allowlisted`,
    message: `${resourceType} path is outside the deterministic allowlist`,
    resource_type: resourceType,
    severity: "warning",
    source_path: publicPath(path, roots)
  };
}

function pathAllowed(path: string, resourceType: ResourceType, roots: AllowedRoot[]): boolean {
  const target = canonical(path);
  return roots.some((root) => root.resourceType === resourceType && within(target, canonical(root.path)));
}

function publicPath(path: string, roots: AllowedRoot[]): string {
  const target = clean(path);
  if (target === "") return "runtime:unknown";
  const resolved = canonical(target);
  const matches = roots
    .filter((root) => within(resolved, canonical(root.path)))
    .sort((left, right) => right.path.length - left.path.length);
  const root = matches[0];
  if (!root) return `outside-allowlist:${basename(target) || "resource"}`;
  const suffix = relative(canonical(root.path), resolved).split(sep).join("/");
  return `${root.label}:${suffix || basename(resolved)}`;
}

function safeMessage(error: unknown, roots: AllowedRoot[]): string {
  let message = redactSensitiveText(error instanceof Error ? error.message : String(error));
  for (const root of [...roots].sort((left, right) => right.path.length - left.path.length)) {
    if (root.path !== "") message = message.split(root.path).join(`${root.label}:`);
  }
  return message.length > 320 ? `${message.slice(0, 317)}...` : message;
}

function namedPaths(paths: string[], roots: AllowedRoot[]): string[] {
  return sortedNames(paths.map((path) => publicPath(path, roots)));
}

function sortedNames(values: string[]): string[] {
  return unique(values.map(clean).filter(Boolean)).sort();
}

function sortedDiagnostics(values: PiRuntimeResourceDiagnostic[]): PiRuntimeResourceDiagnostic[] {
  const found = new Map<string, PiRuntimeResourceDiagnostic>();
  for (const value of values) found.set(JSON.stringify(value), value);
  return [...found.values()].sort((left, right) =>
    left.resource_type.localeCompare(right.resource_type) || left.source_path.localeCompare(right.source_path) || left.code.localeCompare(right.code));
}

function manifestEntries(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("PI package resource entries must be string arrays");
  }
  return unique(value.map(clean).filter(Boolean));
}

function unsafeManifestEntry(value: string): boolean {
  const entry = value.replace(/^[!+-]+/, "");
  return isAbsolute(entry) || entry.split(/[\\/]+/).includes("..");
}

function hasGlob(value: string): boolean {
  return /[*?{}[\]]/.test(value);
}

function dedupePackages(values: ResourcePackage[]): ResourcePackage[] {
  const found = new Map<string, ResourcePackage>();
  for (const value of values) if (!found.has(canonical(value.path))) found.set(canonical(value.path), value);
  return [...found.values()];
}

function normalizeID(value: string): string {
  return clean(value).toLowerCase().replace(/[^a-z0-9_:-]+/g, "-").replace(/^-+|-+$/g, "");
}

function canonical(path: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(path || ".");
  try { return realpathSync(absolute); } catch { return absolute; }
}

function within(path: string, root: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!suffix.startsWith(`..${sep}`) && suffix !== ".." && !isAbsolute(suffix));
}

function safeDirectory(path: string): boolean {
  try { return statSync(path).isDirectory(); } catch { return false; }
}

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
