import type { LoadExtensionsResult, PromptTemplate, ResourceDiagnostic, ResourceLoader, Skill } from "@earendil-works/pi-coding-agent";
import type { RunnerDatabase } from "../../db/database.ts";
import { createPiActionEvent } from "../../db/repositories/pi.ts";
import { redactSensitiveText } from "../../util/redact.ts";
import type { SmokeRuntime } from "../../spikes/piSmokeSupport.ts";
import type { RuntimeSessionInput } from "./piRuntime.ts";
import type { ControlledPiResourceOptions, PiRuntimeResourceSnapshot, AllowedRoot, PiRuntimeResourceDiagnostic, ResourcePackage, ResourceExtensionPaths, Discovery, ResourceType, ResourcePathEntry } from "./piRuntimeResources.model.ts";
import { splitFinalPersonaPrompt, coreOnlyLoader, resourcePromptSummary, safeMessage, notAllowedDiagnostic, publicPath } from "./piRuntimeResources.piManifest.ts";
import { discoverResources, sortedDiagnostics, sdkDiagnostic, resourceDiagnostic, namedPaths, sortedNames, normalizeID, sanitizeExtensions } from "./piRuntimeResources.discoverResources.ts";
import { pathAllowed } from "./piRuntimeResources.validExtensionFile.ts";

export async function createControlledPiResourceLoader(
  sdk: SmokeRuntime,
  options: ControlledPiResourceOptions
): Promise<ResourceLoader & { snapshot(): PiRuntimeResourceSnapshot }> {
  const loader = new ControlledPiResourceLoader(sdk, options);
  await loader.reload();
  return loader;
}

export class ControlledPiResourceLoader implements ResourceLoader {
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
  getSystemPromptSource() { return this.active.getSystemPromptSource(); }
  getAppendSystemPromptSources() { return this.active.getAppendSystemPromptSources(); }

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

export function recordPiRuntimeResourceSnapshot(
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
